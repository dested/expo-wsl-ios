// expo2spm: Windows-side prep output + the app's node_modules -> one SwiftPM/xtool package (runs in WSL).
//   bun src/expo2spm/cli.ts --app <dir> --gen <dir> --out <dir> --fw <dir> --name <AppName>
//                           --bundle-id <id> [--exclude a,b] [--flavor debug|release]
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Glob } from 'bun';
import { z } from 'zod';
import { expoResolve, rnConfig, toPosixPath } from './inputs.ts';
import { collectPackages, resolveProducts, type NativePackage, type ResolvedProduct } from './packages.ts';
import { generatePackage } from './generate.ts';
import { plistDict, substitute, toPlist, type PlistDict } from './plist.ts';
import type { Flavor } from './spm-config.ts';

const REPO = resolve(import.meta.dir, '../..');

interface CliArgs {
  app: string;
  /** The node_modules holding react-native: the app's own, or a workspace root's when hoisted. */
  nodeModules: string;
  gen: string;
  out: string;
  fw: string;
  name: string;
  bundleId: string;
  exclude: string[];
  flavor: Flavor;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const need = (name: string): string => {
    const v = get(name);
    if (v === undefined) throw new Error(`missing --${name}`);
    return v;
  };
  const flavor = get('flavor') ?? 'debug';
  if (flavor !== 'debug' && flavor !== 'release') throw new Error(`--flavor must be debug or release`);
  return {
    app: toPosixPath(need('app')),
    nodeModules: toPosixPath(get('node-modules') ?? join(need('app'), 'node_modules')),
    gen: toPosixPath(need('gen')),
    out: need('out'),
    fw: need('fw'),
    name: need('name'),
    bundleId: need('bundle-id'),
    exclude: (get('exclude') ?? '').split(',').filter(Boolean),
    flavor,
  };
}

const introspect = z.object({
  ios: z.object({ infoPlist: plistDict.optional(), entitlements: plistDict.optional(), deploymentTarget: z.string().optional() }).optional(),
});

/** expo config's Info.plist, with Xcode build settings substituted and Xcode-template leftovers fixed. */
function infoPlist(raw: PlistDict, a: CliArgs, metroPort: string, warnings: string[]): PlistDict {
  const vars = {
    DEVELOPMENT_LANGUAGE: 'en',
    EXECUTABLE_NAME: a.name,
    PRODUCT_NAME: a.name,
    PRODUCT_BUNDLE_IDENTIFIER: a.bundleId,
    PRODUCT_BUNDLE_PACKAGE_TYPE: 'APPL',
    RCT_METRO_PORT: metroPort,
  };
  const out = plistDict.parse(substitute(raw, vars));
  // The Xcode template still says armv7; arm64 is what the binary is.
  if (Array.isArray(out.UIRequiredDeviceCapabilities)) out.UIRequiredDeviceCapabilities = ['arm64'];
  // No storyboard is compiled (yet): a missing launch storyboard letterboxes the app, UILaunchScreen doesn't.
  if (out.UILaunchStoryboardName !== undefined) {
    delete out.UILaunchStoryboardName;
    out.UILaunchScreen = {};
    warnings.push('splash: SplashScreen.storyboard is not built yet; using a blank UILaunchScreen');
  }
  delete out.LSMinimumSystemVersion;
  // Debug builds load JS from Metro on the LAN; iOS asks for Local Network access first and
  // refuses the connection without a usage string.
  out.NSLocalNetworkUsageDescription ??= 'Loads JavaScript from the development server on your computer.';
  return out;
}

async function extractTemplateAppDelegate(nm: string, dest: string): Promise<void> {
  const p = Bun.spawn(['tar', '-xzOf', join(nm, 'expo/template.tgz'), 'package/ios/HelloWorld/AppDelegate.swift'], { stdout: 'pipe', stderr: 'pipe' });
  const [src, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`AppDelegate from expo/template.tgz: ${err}`);
  writeFileSync(dest, src);
}

/** CocoaPods resource_bundles -> <name>.bundle directories at the .app root. */
async function stageResourceBundles(products: ResolvedProduct[], resDir: string): Promise<string[]> {
  const made: string[] = [];
  for (const { pkg, product, source } of products) {
    if (source.kind !== 'source') continue;
    for (const t of product.targets) {
      for (const [bundle, globs] of Object.entries(t.resourceBundles ?? {})) {
        const dir = join(resDir, `${bundle}.bundle`);
        // A bundle prep already wrote (EXConstants.bundle/app.config) wins over the pod's copy.
        const prestaged = existsSync(dir);
        mkdirSync(dir, { recursive: true });
        for (const g of globs) {
          for await (const f of new Glob(g).scan({ cwd: pkg.root, onlyFiles: false })) {
            cpSync(join(pkg.root, f), join(dir, basename(f)), { recursive: true, force: !prestaged });
          }
        }
        if (!prestaged) made.push(`${bundle}.bundle`);
      }
    }
  }
  return made;
}

/** CocoaPods `resources` (not bundles) are copied flat into the .app root. */
async function stagePodResources(products: ResolvedProduct[], resDir: string): Promise<string[]> {
  const made: string[] = [];
  for (const { pkg, product, source } of products) {
    if (source.kind !== 'source' || (pkg.tier !== 'podspec' && pkg.tier !== 'remote-pod')) continue;
    for (const t of product.targets) {
      for (const r of t.resources ?? []) {
        const glob = typeof r === 'string' ? r : r.path;
        for await (const f of new Glob(glob).scan({ cwd: pkg.root, onlyFiles: false })) {
          const name = basename(f);
          if (made.includes(name) || existsSync(join(resDir, name))) continue;
          cpSync(join(pkg.root, f), join(resDir, name), { recursive: true });
          made.push(name);
        }
      }
    }
  }
  return made;
}

function report(packages: NativePackage[], products: ResolvedProduct[]): void {
  const rows = packages.map((p) => {
    const mine = products.filter((r) => r.pkg === p);
    const desc = mine.map((r) => `${r.product.name}${r.source.kind === 'binary' ? ' (prebuilt)' : ''}`).join(', ') || '(nothing linked)';
    return `  ${p.name.padEnd(42)} ${p.tier.padEnd(13)} ${desc}`;
  });
  console.log(`native packages (${packages.length}):\n${rows.join('\n')}`);
}

/** Dotted version compare: negative, zero or positive. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const nm = a.nodeModules;
  const warnings: string[] = [];

  const expo = expoResolve.parse(await Bun.file(join(a.gen, 'expo-resolve.json')).json());
  const rn = rnConfig.parse(await Bun.file(join(a.gen, 'rn-config.json')).json());
  const packages = await collectPackages(expo, rn, {
    nodeModules: nm,
    overridesDirs: [join(a.app, 'expo-wsl-ios/configs'), join(REPO, 'configs')],
    exclude: new Set(a.exclude),
    // Pod::Config.project_root: CNG apps have no ios/, and podspec helpers cd into it, so the app dir.
    projectRoot: a.app,
    cacheDir: join(process.env['EXPO_WSL_IOS_CACHE'] ?? join(process.env['HOME'] ?? '/tmp', '.cache/expo-wsl-ios'), 'pods'),
  });
  // Script phases the Windows prep step already performs (expo-constants' app.config).
  const handled = (pkg: string, w: string): boolean => pkg === 'expo-constants' && w.includes('Generate app.config');
  for (const p of packages) for (const w of p.warnings) if (!handled(p.name, w)) warnings.push(`${p.name}: ${w}`);
  const products = resolveProducts(packages, a.flavor, a.fw);
  report(packages, products);
  const intro = introspect.parse(await Bun.file(join(a.gen, 'introspect.json')).json());
  // SwiftPM takes one deployment target per package: the app's own (ios.deploymentTarget), raised to
  // the highest minimum any linked product declares, where CocoaPods would have refused the install.
  const deploymentTarget = [intro.ios?.deploymentTarget, ...products.flatMap((p) => p.product.platforms ?? []).map((s) => /^iOS\("([\d.]+)"\)$/.exec(s)?.[1])]
    .reduce<string>((max, v) => (v !== undefined && compareVersions(v, max) > 0 ? v : max), '16.4');
  console.log(`deployment target: iOS ${deploymentTarget}`);

  mkdirSync(a.out, { recursive: true });
  // Every package's effective config, as a starting point for an override in <app>/expo-wsl-ios/configs.
  const resolved = join(a.out, 'configs');
  rmSync(resolved, { recursive: true, force: true });
  for (const p of packages) {
    mkdirSync(join(resolved, p.name), { recursive: true });
    writeFileSync(join(resolved, p.name, 'spm.config.json'), `${JSON.stringify(p.config, null, 2)}
`);
  }

  const appSrc = join(a.out, '.app-src');
  rmSync(appSrc, { recursive: true, force: true });
  mkdirSync(appSrc, { recursive: true });
  const custom = join(a.app, 'expo-wsl-ios/AppDelegate.swift');
  if (existsSync(custom)) cpSync(custom, join(appSrc, 'AppDelegate.swift'));
  else await extractTemplateAppDelegate(nm, join(appSrc, 'AppDelegate.swift'));
  cpSync(join(a.gen, 'ExpoModulesProvider.swift'), join(appSrc, 'ExpoModulesProvider.swift'));

  const gen = await generatePackage(products, {
    outDir: a.out,
    appName: a.name,
    flavor: a.flavor,
    frameworksDir: a.fw,
    genDir: a.gen,
    appSources: [join(appSrc, 'AppDelegate.swift'), join(appSrc, 'ExpoModulesProvider.swift')],
    reactNativeVersion: z.object({ version: z.string() }).parse(await Bun.file(join(nm, 'react-native/package.json')).json()).version,
    deploymentTarget,
  });
  warnings.push(...gen.warnings);
  for (const { pkg, product } of products) {
    if (pkg.tier === 'podspec' || pkg.tier === 'remote-pod') continue; // staged below, at the .app root
    for (const t of product.targets) if (t.resources?.length) warnings.push(`${t.name}: SwiftPM resources (${t.resources.length}) are not bundled yet`);
  }

  // Resources copied to the .app root by xtool.
  const res = join(a.out, 'Resources');
  rmSync(res, { recursive: true, force: true });
  mkdirSync(res, { recursive: true });
  const resources: string[] = [];
  const put = (from: string, name: string): void => {
    if (!existsSync(from)) return;
    cpSync(from, join(res, name), { recursive: true });
    resources.push(name);
  };
  put(join(a.gen, 'main.hbc'), 'main.jsbundle');
  put(join(a.gen, 'EXConstants.bundle'), 'EXConstants.bundle');
  put(join(a.gen, 'ip.txt'), 'ip.txt');
  // export:embed --assets-dest writes what Xcode would copy into the .app (assets/, *.bundle).
  const assets = join(a.gen, 'assets');
  if (existsSync(assets)) for (const e of readdirSync(assets)) put(join(assets, e), e);
  resources.push(...(await stageResourceBundles(products, res)));
  resources.push(...(await stagePodResources(products, res)));

  const metroPort = existsSync(join(a.gen, 'metro-port')) ? (await Bun.file(join(a.gen, 'metro-port')).text()).trim() : '8081';
  writeFileSync(join(a.out, 'Info.plist'), toPlist(infoPlist(intro.ios?.infoPlist ?? {}, a, metroPort, warnings)));
  const ent = intro.ios?.entitlements ?? {};
  if (Object.keys(ent).length > 0) {
    writeFileSync(join(a.out, 'app.entitlements'), toPlist(ent));
    warnings.push(`entitlements (${Object.keys(ent).join(', ')}) are not provisioned yet; dev signing keeps only the basics`);
  }

  writeFileSync(join(a.out, 'xtool.yml'), [
    'version: 1',
    `bundleID: ${a.bundleId}`,
    `product: ${a.name}`,
    'infoPath: Info.plist',
    'resources:',
    ...resources.map((r) => `  - Resources/${r}`),
    '',
  ].join('\n'));

  writeFileSync(join(a.out, 'expo2spm-report.json'), JSON.stringify({
    packages: packages.map((p) => ({ name: p.name, version: p.version, tier: p.tier, pods: p.pods })),
    products: products.map((r) => ({ package: r.pkg.name, product: r.product.name, source: r.source.kind })),
    warnings,
  }, null, 2));
  if (warnings.length) console.log(`warnings (${warnings.length}):\n${warnings.map((w) => `  - ${w}`).join('\n')}`);
  console.log(`generated ${join(a.out, 'Package.swift')}`);
}

await main();
