// Windows-side prep: every JS-ecosystem step, run against the app's Windows node_modules.
// Output goes to <app>/.expo/wsl-ios/prep, which the WSL half reads over /mnt.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { PKG_ROOT, binPath, packageDir } from './env.ts';
import { CommandError, run, step } from './proc.ts';

export interface PrepOptions {
  app: string;
  exclude: string[];
  host: string | undefined;
  port: number | undefined;
  bundleId: string | undefined;
}

export interface PrepResult {
  dir: string;
  name: string;
  slug: string;
  bundleId: string;
  /** PascalCase Swift product name derived from the slug. */
  productName: string;
  metro: string;
}

const appConfig = z.object({
  name: z.string(),
  slug: z.string(),
  ios: z.object({ bundleIdentifier: z.string().optional() }).optional(),
});

/** First private IPv4 on a physical-looking interface (skips WSL/Hyper-V vEthernet). */
function lanAddress(): string {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/vEthernet|WSL|Loopback|VirtualBox|VMware|Tailscale|ZeroTier/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  throw new Error('no LAN address found; pass --host <ip of this PC on the phone\'s Wi-Fi>');
}

/** `expo start --port N` in package.json's start script, so the app finds the Metro you usually run. */
function metroPortFromScripts(app: string): number | undefined {
  const pj = z.object({ scripts: z.record(z.string(), z.string()).optional() }).parse(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')));
  const m = /--port[ =](\d+)/.exec(pj.scripts?.['start'] ?? '');
  return m?.[1] ? Number(m[1]) : undefined;
}

export function productNameFor(slug: string): string {
  const pascal = slug.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m: string, _s: string, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
  return /^[0-9]/.test(pascal) ? `App${pascal}` : pascal || 'App';
}

export async function prep(o: PrepOptions): Promise<PrepResult> {
  const app = o.app;
  const dir = join(app, '.expo', 'wsl-ios', 'prep');
  const node = (args: string[], cwd = app): Promise<string> => run(process.execPath, args, { cwd, quiet: true });

  const expoDir = packageDir('expo', app);
  const rnDir = packageDir('react-native', app);
  const autolinking = await binPath(packageDir('expo-modules-autolinking', expoDir), 'expo-modules-autolinking');
  const expoCli = await binPath(expoDir, 'expo');

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  step('autolinking');
  writeFileSync(join(dir, 'expo-resolve.json'), await node([autolinking, 'resolve', '--platform', 'apple', '--json']));
  writeFileSync(join(dir, 'rn-config.json'), await node([autolinking, 'react-native-config', '--platform', 'ios', '--json']));

  step('codegen (app)');
  await node([join(rnDir, 'scripts/generate-codegen-artifacts.js'), '-p', app, '-t', 'ios', '-o', join(dir, 'codegen')]);

  step('codegen (libraries that compile their own codegen)');
  const resolveJson = z.object({ modules: z.array(z.object({ packageName: z.string(), pods: z.array(z.object({ podspecDir: z.string() })) })) })
    .parse(JSON.parse(readFileSync(join(dir, 'expo-resolve.json'), 'utf8')));
  // Up from the podspec first: a local module in <app>/modules has expo-module.config.json but no package.json.
  const moduleRoot = (pkg: string): string => {
    const podspecDir = resolveJson.modules.find((m) => m.packageName === pkg)?.pods[0]?.podspecDir;
    for (let d = podspecDir; d !== undefined && dirname(d) !== d; d = dirname(d)) {
      if (existsSync(join(d, 'expo-module.config.json')) || existsSync(join(d, 'package.json'))) return d;
    }
    return packageDir(pkg, app);
  };
  const rnJson = z.object({ dependencies: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(readFileSync(join(dir, 'rn-config.json'), 'utf8')));
  const packages = new Set([...resolveJson.modules.map((m) => m.packageName), ...Object.keys(rnJson.dependencies)]);
  for (const pkg of packages) {
    if (o.exclude.includes(pkg)) continue;
    const pkgDir = moduleRoot(pkg);
    const configs = [
      join(app, 'expo-wsl-ios/configs', pkg, 'spm.config.json'),
      join(PKG_ROOT, 'configs', pkg, 'spm.config.json'),
      join(pkgDir, 'spm.config.json'),
      join(packageDir('expo-modules-autolinking', expoDir), 'external-configs/ios', pkg, 'spm.config.json'),
    ];
    const config = configs.find((f) => existsSync(f));
    if (config && readFileSync(config, 'utf8').includes('.build/codegen')) {
      await node([join(rnDir, 'scripts/generate-codegen-artifacts.js'), '-p', pkgDir, '-t', 'ios', '-o', join(dir, 'libs', pkg, 'codegen'), '-s', 'library'], rnDir);
    }
  }

  step('ExpoModulesProvider.swift');
  const expoPackages = resolveJson.modules.map((m) => m.packageName).filter((p) => !o.exclude.includes(p));
  await node([autolinking, 'generate-modules-provider', '--platform', 'apple', '--target', join(dir, 'ExpoModulesProvider.swift'), '--packages', ...expoPackages]);

  step('app config');
  const introspect = await node([expoCli, 'config', '--type', 'introspect', '--json']);
  writeFileSync(join(dir, 'introspect.json'), introspect);
  const cfg = appConfig.parse(JSON.parse(introspect));
  let bundleId = o.bundleId ?? cfg.ios?.bundleIdentifier;
  if (!bundleId) {
    // Like `expo run:ios`'s prompt default. Bundle ids are global across Apple teams, hence the user name.
    const part = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'app';
    bundleId = `com.${part(userInfo().username)}.${part(cfg.slug)}`;
    console.log(`   no expo.ios.bundleIdentifier: using ${bundleId} (set it in app.json to keep it stable)`);
  }
  const constants = join(packageDir('expo-constants', expoDir), 'scripts/getAppConfig.js');
  if (existsSync(constants)) {
    mkdirSync(join(dir, 'EXConstants.bundle'), { recursive: true });
    await node([constants, app, join(dir, 'EXConstants.bundle')]);
  }

  step('JS bundle + Hermes bytecode (embedded fallback when Metro is not running)');
  const entry = (await node(['-e', `process.stdout.write(require(require.resolve('@expo/config/paths',{paths:[${JSON.stringify(expoDir)}]})).resolveEntryPoint(process.cwd(),{platform:'ios'}))`])).trim();
  await node([expoCli, 'export:embed', '--platform', 'ios', '--dev', 'false', '--minify', 'true', '--entry-file', entry,
    '--bundle-output', join(dir, 'main.jsbundle'), '--assets-dest', join(dir, 'assets')]).catch((e: unknown) => {
    // Node 22 on Windows can die with an access violation (0xC0000005) while Metro tears down,
    // after everything is written. Keep the output then; hermesc below rejects a truncated bundle.
    const crashedAfterWrite = e instanceof CommandError && e.code === 0xc0000005 && e.stdout.includes('Done writing bundle output');
    if (!crashedAfterWrite) throw e;
    console.log('   node crashed after Metro finished writing (a Windows Node flake); keeping the bundle');
  });
  const hermesc = join(packageDir('hermes-compiler', rnDir), 'hermesc/win64-bin/hermesc.exe');
  await run(hermesc, ['-emit-binary', '-O', '-max-diagnostic-width=80', '-w', '-out', join(dir, 'main.hbc'), join(dir, 'main.jsbundle')], { quiet: true });

  // RCTBundleURLProvider reads ip.txt from the bundle; "host:port" overrides the compiled-in 8081.
  const host = o.host ?? lanAddress();
  const port = o.port ?? metroPortFromScripts(app) ?? 8081;
  writeFileSync(join(dir, 'ip.txt'), `${host}:${port}\n`);
  writeFileSync(join(dir, 'metro-port'), String(port));
  return { dir, name: cfg.name, slug: cfg.slug, bundleId, productName: productNameFor(cfg.slug), metro: `${host}:${port}` };
}
