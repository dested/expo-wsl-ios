// Turn resolved products into ONE SwiftPM package (option B): source products become targets
// staged on ext4, prebuilt products become binary targets, plus RN codegen and the app target.
// Expo's per-product generator semantics (plans/2026-10-07-expo-spm-generator.md) are kept
// target by target; Expo's post-build "single module" rewrite is not needed because nothing
// here is shipped as a framework.
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, symlinkSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Glob } from 'bun';
import { resolveCompilerFlags, type Flavor, type SpmTarget } from './spm-config.ts';
import type { ResolvedProduct } from './packages.ts';

export interface GenerateOptions {
  outDir: string;
  appName: string;
  flavor: Flavor;
  frameworksDir: string;
  /** Windows-side prep output (codegen, provider, bundle), posix path. */
  genDir: string;
  /** Extra app sources (AppDelegate.swift, ExpoModulesProvider.swift). */
  appSources: string[];
  /** react-native's version, for ${REACT_NATIVE_MINOR_VERSION} in compiler flags. */
  reactNativeVersion: string;
}

/** One target in the generated package. Settings are Swift source fragments. */
interface PkgTarget {
  name: string;
  kind: 'swift' | 'clang' | 'binary';
  binaryPath?: string;
  deps: string[];
  publicHeaders: boolean;
  cSettings: string[];
  swiftSettings: string[];
  linkerSettings: string[];
}

const RN_BINARIES = ['React', 'ReactNativeDependencies', 'hermesvm'] as const;
const DEFAULT_PATTERN: Record<'swift' | 'objc' | 'cpp', string> = {
  swift: '**/*.swift',
  objc: '**/*.{m,mm,c,cpp}',
  cpp: '**/*.{cpp,c,cc,cxx}',
};

const q = (s: string): string => JSON.stringify(s);
const flagList = (flags: string[]): string => `[${flags.map(q).join(', ')}]`;

export async function generatePackage(products: ResolvedProduct[], opts: GenerateOptions): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const { outDir } = opts;
  const sourcesDir = join(outDir, 'Sources');
  rmSync(sourcesDir, { recursive: true, force: true });
  rmSync(join(outDir, 'Frameworks'), { recursive: true, force: true });
  mkdirSync(sourcesDir, { recursive: true });
  mkdirSync(join(outDir, 'Frameworks'), { recursive: true });

  const fw = opts.frameworksDir;
  const reactXcf = join(fw, 'React.xcframework');
  const vfs = join(outDir, 'react-vfs.yaml');
  writeFileSync(vfs, (await Bun.file(join(reactXcf, 'React-VFS-template.yaml')).text()).replaceAll('${ROOT_PATH}', reactXcf));
  const prefix = join(outDir, 'expo-wsl-ios-prefix.h');
  writeFileSync(prefix, PREFIX_HEADER);
  const generatedHeaders = join(outDir, '.build/out/Intermediates.noindex/GeneratedModuleMaps-iphoneos');

  // Header and define flags every C-family target gets (CocoaPods/Expo give RN-dependent pods
  // the same: React's VFS overlay, ReactNativeDependencies and Hermes headers, folly config).
  const rnClang = [
    '-ivfsoverlay', vfs,
    `-I${join(reactXcf, 'Headers')}`,
    `-I${join(fw, 'ReactNativeDependencies.xcframework/Headers')}`,
    `-I${join(fw, 'hermes-headers')}`,
    '-fmodules', '-fobjc-arc', '-include', prefix,
    '-Wno-incomplete-umbrella', '-Wno-nullability-completeness', '-Wno-non-modular-include-in-framework-module',
    '-DFOLLY_NO_CONFIG=1', '-DFOLLY_MOBILE=1', '-DFOLLY_USE_LIBCPP=1', '-DFOLLY_CFG_NO_COROUTINES=1',
    '-DFOLLY_HAVE_CLOCK_GETTIME=1', '-DRCT_NEW_ARCH_ENABLED=1', '-DRCT_REMOVE_LEGACY_ARCH=1', '-DUSE_HERMES=1',
  ];
  const rnSwift = [
    '-Xcc', '-ivfsoverlay', '-Xcc', vfs,
    '-Xcc', `-I${join(reactXcf, 'Headers')}`,
    '-Xcc', `-I${join(fw, 'ReactNativeDependencies.xcframework/Headers')}`,
    '-Xcc', '-Wno-incomplete-umbrella',
    '-DRCT_NEW_ARCH_ENABLED', '-DRCT_REMOVE_LEGACY_ARCH',
  ];

  const targets: PkgTarget[] = [];
  const pendingExports: { file: string; modules: string[] }[] = [];
  const binary = (name: string, xcframework: string): void => {
    const link = join(outDir, 'Frameworks', `${name}.xcframework`);
    symlinkSync(xcframework, link);
    targets.push({ name, kind: 'binary', binaryPath: relative(outDir, link), deps: [], publicHeaders: false, cSettings: [], swiftSettings: [], linkerSettings: [] });
  };
  for (const b of RN_BINARIES) binary(b, join(fw, `${b}.xcframework`));
  for (const p of products) if (p.source.kind === 'binary') binary(p.product.name, p.source.xcframework);

  // Dependency tokens → target names in this package.
  const byProduct = new Map(products.map((p) => [p.product.name, p]));
  const byPod = new Map(products.map((p) => [p.product.podName ?? p.product.name, p]));
  const productRefs = (p: ResolvedProduct): string[] => {
    if (p.source.kind === 'binary') {
      // Prebuilt Expo frameworks load ExpoModulesJSI and RN at runtime and import them in their interfaces.
      const extra = p.product.name === 'ExpoModulesJSI' ? [] : byProduct.has('ExpoModulesJSI') ? ['ExpoModulesJSI'] : [];
      return [p.product.name, ...extra, ...RN_BINARIES];
    }
    return p.product.targets.filter((t) => t.type !== 'framework').map((t) => t.name);
  };
  const resolveDep = (dep: string, owner: ResolvedProduct): string[] => {
    if (dep === 'React' || dep === 'ReactNativeDependencies') return [dep];
    if (dep === 'Hermes') return ['hermesvm'];
    if (owner.product.targets.some((t) => t.name === dep)) return [dep];
    const name = dep.startsWith('pod:') ? dep.slice(4) : dep.split('/').pop() ?? dep;
    const target = byProduct.get(name) ?? byPod.get(name);
    if (target && target !== owner) return productRefs(target);
    if (target === owner) return [];
    warnings.push(`${owner.product.name}: dependency ${dep} is not linked in this app; dropped`);
    return [];
  };

  for (const rp of products) {
    if (rp.source.kind === 'binary') continue;
    const { pkg, product } = rp;
    const mirror = join(outDir, '.mirror', pkg.name);
    const buildMirror = join(outDir, '.mirror-build', pkg.name);
    await mirrorTree(pkg.root, mirror);
    if (product.targets.some((t) => t.path.startsWith('.build/'))) {
      const libGen = join(opts.genDir, 'libs', pkg.name);
      if (!existsSync(libGen)) throw new Error(`${product.name}: needs library codegen at ${libGen} (run prep)`);
      await mirrorTree(libGen, buildMirror);
    }
    const inProduct = new Set(product.targets.map((t) => t.name));
    // Expo's generator substitutes these in flags at generate time.
    const rnMinor = opts.reactNativeVersion.split('.')[1] ?? '0';
    const vars = (f: string): string => f.replaceAll('${PACKAGE_VERSION}', pkg.version).replaceAll('${REACT_NATIVE_MINOR_VERSION}', rnMinor);

    for (const t of product.targets) {
      if (t.type === 'framework') {
        binary(t.name, join(mirror, t.path));
        continue;
      }
      const remap = (p: string): string => {
        const buildRoot = join(mirror, '.build');
        // Expo's own staging layout, .build/generated/<Product>/<Target>/..., is Sources/<Target>/ here.
        const staged = new RegExp(`^${buildRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/generated/[^/]+/([^/]+)(/.*)?$`).exec(p);
        if (staged?.[1]) return join(sourcesDir, staged[1], staged[2] ?? '');
        return p === buildRoot || p.startsWith(`${buildRoot}/`) ? join(buildMirror, relative(buildRoot, p)) : p;
      };
      const srcRoot = remap(join(mirror, t.path));
      const dir = join(sourcesDir, t.name);
      if (existsSync(dir)) throw new Error(`target name collision: ${t.name} (${pkg.name})`);
      mkdirSync(dir, { recursive: true });
      const headerDir = t.moduleName ?? product.name;
      const staged = await stageTarget(t, srcRoot, dir, headerDir, warnings);

      const deps = [...new Set((t.dependencies ?? []).flatMap((d) => resolveDep(d, rp)))];
      // A codegen library without its own .build/ codegen target includes <lib_codegen/...> from
      // the app's ReactCodegen, as its pod does from the ReactCodegen pod.
      if (pkg.codegen && !product.targets.some((x) => x.path.startsWith('.build/')) && !deps.includes('ReactCodegen')) deps.push('ReactCodegen');
      if (t.importsSwiftHeaderOf && !deps.includes(t.importsSwiftHeaderOf)) deps.push(t.importsSwiftHeaderOf);
      const linker = [
        ...(t.linkedFrameworks ?? []).map((f) => `.linkedFramework(${q(f)})`),
        ...(t.linkerFlags?.length ? [`.unsafeFlags(${flagList(t.linkerFlags)})`] : []),
      ];

      if (t.type === 'swift') {
        if (!staged.hasSources) {
          warnings.push(`${t.name}: swift target has no sources; skipped`);
          rmSync(dir, { recursive: true, force: true });
          inProduct.delete(t.name);
          continue;
        }
        const exports = [
          ...(t.linkedFrameworks ?? []),
          ...(t.dependencies ?? []).filter((d) => inProduct.has(d) && product.targets.find((x) => x.name === d)?.type !== 'swift'),
        ];
        pendingExports.push({ file: join(dir, `${product.name}+Exports.swift`), modules: exports });
        const six = (product.swiftLanguageVersions ?? []).some((v) => v.startsWith('6'));
        const cFlagsForSwift = resolveCompilerFlags(t.compilerFlags, opts.flavor, 'c').map(vars).flatMap((f) => ['-Xcc', f]);
        targets.push({
          name: t.name, kind: 'swift', deps, publicHeaders: false, cSettings: [], linkerSettings: linker,
          swiftSettings: [
            `.swiftLanguageMode(.v${six ? 6 : 5})`,
            `.unsafeFlags(${flagList([...rnSwift, ...cFlagsForSwift, ...(t.swiftFlags ?? [])])})`,
          ],
        });
        continue;
      }

      // objc / cpp
      if (!staged.hasSources) writeFileSync(join(dir, '_expo2spm_empty.c'), '// SwiftPM needs one source file per target.\n');
      // SwiftPM on Linux rejects a clang target whose (default) include/ dir doesn't exist.
      mkdirSync(join(dir, 'include'), { recursive: true });
      if (product.excludeFromUmbrella?.length && !t.moduleMapContent && staged.hasHeaders) {
        writeUmbrellaExcludingModuleMap(t.name, join(dir, 'include'), product.excludeFromUmbrella, product.textualHeaders ?? []);
      }
      const includeDirs =(t.includeDirectories ?? []).map((d) => `-I${remap(resolve(mirror, t.path, d))}`);
      const cFlags = (lang: 'c' | 'cxx'): string[] => resolveCompilerFlags(t.compilerFlags, opts.flavor, lang).map(vars);
      const settings = (lang: 'c' | 'cxx'): string[] => {
        const defines: string[] = [];
        const unsafe: string[] = [...rnClang, ...includeDirs];
        for (const f of cFlags(lang)) {
          const m = /^-D([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(f);
          if (m?.[1]) defines.push(m[2] === undefined ? `.define(${q(m[1])})` : `.define(${q(m[1])}, to: ${q(m[2])})`);
          else unsafe.push(f);
        }
        if (t.importsSwiftHeaderOf) unsafe.push(`-I${generatedHeaders}`);
        const searchPaths = ['.', ...(staged.hasHeaders ? ['include', `include/${product.name}`, `include/${headerDir}`] : []), ...staged.extraSearchPaths];
        return [...new Set(searchPaths)].filter((p) => existsSync(join(dir, p)))
          .map((p) => `.headerSearchPath(${q(p)})`).concat(defines, `.unsafeFlags(${flagList(unsafe)})`);
      };
      targets.push({
        name: t.name, kind: 'clang', deps, publicHeaders: staged.hasHeaders && t.publicHeaders !== false,
        cSettings: settings('c'), swiftSettings: [], linkerSettings: linker,
      });
    }
  }

  // App-level RN codegen (ReactCodegen + ReactAppDependencyProvider), minus libraries that
  // compile their own codegen targets (Expo's codegenName; otherwise duplicate symbols).
  // A codegenName alone (podspec-converted packages) doesn't compile anything; the .build/ target does.
  const ownCodegen = new Set(products
    .filter((p) => p.source.kind === 'source' && p.product.targets.some((t) => t.path.startsWith('.build/')))
    .map((p) => p.product.codegenName).filter((n): n is string => n !== undefined));
  stageAppCodegen(join(opts.genDir, 'codegen/build/generated/ios'), sourcesDir, ownCodegen);
  const codegenClang = (extra: string[]): string[] => [
    `.headerSearchPath("include")`, ...extra.map((p) => `.headerSearchPath(${q(p)})`),
    `.unsafeFlags(${flagList(rnClang)})`,
  ];
  targets.push(
    { name: 'ReactCodegen', kind: 'clang', deps: [...RN_BINARIES], publicHeaders: true, cSettings: codegenClang(['include/ReactCodegen']), swiftSettings: [], linkerSettings: [] },
    { name: 'ReactAppDependencyProvider', kind: 'clang', deps: [...RN_BINARIES, 'ReactCodegen'], publicHeaders: true, cSettings: codegenClang(['include/ReactAppDependencyProvider']), swiftSettings: [], linkerSettings: [] },
  );

  // App target: AppDelegate + ExpoModulesProvider, depending on every product.
  const appDir = join(sourcesDir, opts.appName);
  mkdirSync(appDir, { recursive: true });
  for (const f of opts.appSources) copyFileSync(f, join(appDir, basename(f)));
  const appDeps = [...new Set([...RN_BINARIES, 'ReactAppDependencyProvider', ...products.flatMap((p) => productRefs(p))])]
    .filter((d) => targets.some((t) => t.name === d));
  targets.push({ name: opts.appName, kind: 'swift', deps: appDeps, publicHeaders: false, cSettings: [], linkerSettings: [], swiftSettings: [`.swiftLanguageMode(.v5)`, `.unsafeFlags(${flagList(rnSwift)})`] });

  // Exports files last: an in-product dependency is re-exported only if it produced a module.
  const modules = new Set(targets.filter((t) => t.kind === 'swift' || t.publicHeaders).map((t) => t.name));
  for (const { file, modules: wanted } of pendingExports) {
    const lines = wanted.filter((m) => modules.has(m) || !targets.some((t) => t.name === m)).map((m) => `@_exported import ${m}\n`);
    writeFileSync(file, `// Generated by expo2spm.\n${lines.join('')}`);
  }

  writeFileSync(join(outDir, 'Package.swift'), renderPackage(opts.appName, targets));
  return { warnings };
}

interface Staged {
  hasSources: boolean;
  hasHeaders: boolean;
  extraSearchPaths: string[];
}

/** Symlink sources (keeping relative paths) and hardlink headers flattened into include/<headerDir>/. */
async function stageTarget(t: SpmTarget, srcRoot: string, dir: string, headerDir: string, warnings: string[]): Promise<Staged> {
  const extraSearchPaths: string[] = [];
  if (!existsSync(srcRoot)) {
    warnings.push(`${t.name}: source path ${srcRoot} does not exist`);
    return { hasSources: false, hasHeaders: false, extraSearchPaths };
  }
  const kind = t.type === 'framework' ? 'objc' : t.type;
  const excludes = [...(t.exclude ?? []), '**/Tests/**', 'Tests/**'].map((e) => new Glob(e));
  const excluded = (f: string): boolean => excludes.some((g) => g.match(f));
  const mapped = new Set<string>();
  let hasHeaders = false;

  for (const m of t.fileMapping ?? []) {
    if (m.type === 'symlink') continue;
    for (const f of await scan(m.from, srcRoot)) {
      mapped.add(f);
      const to = m.to.replaceAll('{filename}', basename(f));
      if (m.type === 'header') {
        place(join(srcRoot, f), join(dir, 'include', to), 'hardlink');
        extraSearchPaths.push(join('include', dirname(to)));
        hasHeaders = true;
      } else {
        place(join(srcRoot, f), join(dir, to), 'symlink');
      }
    }
  }
  for (const m of t.fileMapping ?? []) {
    if (m.type !== 'symlink') continue;
    const link = join(dir, 'include', m.to);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), join(dir, 'include', m.from)), link);
  }

  const sources = t.files ?? (await scan(t.pattern ?? DEFAULT_PATTERN[kind], srcRoot)).filter((f) => !excluded(f) && !mapped.has(f));
  for (const f of sources) place(join(srcRoot, f), join(dir, f), 'symlink');
  // Quoted includes resolve next to the (symlinked) includer, so headers beside the sources are
  // staged at their relative paths as well; SwiftPM ignores headers outside include/.
  if (kind !== 'swift') {
    const sourceDirs = new Set(sources.map((f) => dirname(f)));
    for (const h of await scan('**/*.{h,hpp,hh,inc,def}', srcRoot)) {
      if (sourceDirs.has(dirname(h)) && !excluded(h)) place(join(srcRoot, h), join(dir, h), 'symlink');
    }
  }

  const headers = t.headers ?? (t.headerPattern ? (await scan(t.headerPattern, srcRoot)).filter((f) => !excluded(f) && !mapped.has(f)) : []);
  for (const h of headers) place(join(srcRoot, h), join(dir, 'include', headerDir, basename(h)), 'hardlink');
  hasHeaders ||= headers.length > 0;

  if (t.moduleMapContent) {
    mkdirSync(join(dir, 'include'), { recursive: true });
    writeFileSync(join(dir, 'include/module.modulemap'), t.moduleMapContent);
    hasHeaders = true;
  }
  return { hasSources: sources.length > 0, hasHeaders, extraSearchPaths };
}

/**
 * SwiftPM's default module is "every header under include/". Expo's excludeFromUmbrella keeps
 * headers like Swift-Bridging.h (which imports the not-yet-generated <Module>-Swift.h) out of the
 * module, so the module lists its headers explicitly instead.
 */
function writeUmbrellaExcludingModuleMap(moduleName: string, includeDir: string, exclude: string[], textual: string[]): void {
  const headers: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(includeDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (/\.(h|hpp)$/.test(e.name) && !exclude.includes(e.name)) headers.push(r);
    }
  };
  walk('');
  const lines = headers.sort().map((h) => `  ${textual.includes(basename(h)) ? 'textual header' : 'header'} ${q(h)}`);
  writeFileSync(join(includeDir, 'module.modulemap'), `module ${moduleName} {\n${lines.join('\n')}\n  export *\n}\n`);
}

async function scan(pattern: string, cwd: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Glob(pattern).scan({ cwd, onlyFiles: true, followSymlinks: true })) out.push(f);
  return out.sort();
}

function place(src: string, dst: string, how: 'symlink' | 'hardlink'): void {
  mkdirSync(dirname(dst), { recursive: true });
  rmSync(dst, { force: true });
  if (how === 'symlink') symlinkSync(src, dst);
  else {
    try {
      linkSync(src, dst);
    } catch {
      copyFileSync(src, dst);
    }
  }
}

/** rsync a package (minus JS-only and Android trees) onto ext4; incremental on rebuilds. */
async function mirrorTree(src: string, dst: string): Promise<void> {
  mkdirSync(dst, { recursive: true });
  const p = Bun.spawn(['rsync', '-a', '--delete', '--exclude=node_modules', '--exclude=android', '--exclude=/.build', `${src}/`, `${dst}/`], { stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(`rsync ${src}: ${await new Response(p.stderr).text()}`);
}

/** RN's app codegen tree → ReactCodegen (sources + include/ tree) and ReactAppDependencyProvider. */
function stageAppCodegen(root: string, sourcesDir: string, skip: ReadonlySet<string>): void {
  const cg = join(root, 'ReactCodegen');
  const dst = join(sourcesDir, 'ReactCodegen');
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(cg, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const lib = r.startsWith('react/renderer/components/') ? r.split('/')[3] : rel === '' ? e.name : undefined;
        if (lib !== undefined && skip.has(lib)) continue;
        walk(r);
      } else if (/\.(mm|cpp|m|c)$/.test(e.name)) {
        place(join(cg, r), join(dst, r), 'symlink');
      } else if (/\.(h|hpp)$/.test(e.name)) {
        place(join(cg, r), join(dst, 'include', rel === '' ? 'ReactCodegen' : '', r), 'hardlink');
        place(join(cg, r), join(dst, r), 'symlink');
      }
    }
  };
  walk('');
  // Only the top-level provider headers form the module; library headers stay textual (C++).
  const top = readdirSync(join(dst, 'include/ReactCodegen')).filter((f) => f.endsWith('.h'));
  writeFileSync(join(dst, 'include/module.modulemap'), `module ReactCodegen {\n${top.map((h) => `  header "ReactCodegen/${h}"\n`).join('')}  export *\n}\n`);

  const adp = join(root, 'ReactAppDependencyProvider');
  for (const f of readdirSync(adp)) {
    if (f.endsWith('.mm')) place(join(adp, f), join(sourcesDir, 'ReactAppDependencyProvider', f), 'symlink');
    if (f.endsWith('.h')) place(join(adp, f), join(sourcesDir, 'ReactAppDependencyProvider/include/ReactAppDependencyProvider', f), 'hardlink');
  }
}

function renderPackage(name: string, targets: PkgTarget[]): string {
  const body = targets.map((t) => {
    if (t.kind === 'binary') return `        .binaryTarget(name: ${q(t.name)}, path: ${q(t.binaryPath ?? '')}),`;
    const lines = [`        .target(`, `            name: ${q(t.name)},`, `            dependencies: ${flagList(t.deps)},`];
    if (t.publicHeaders) lines.push(`            publicHeadersPath: "include",`);
    if (t.kind === 'clang') {
      lines.push(`            cSettings: [\n${t.cSettings.map((s) => `                ${s},`).join('\n')}\n            ],`);
      lines.push(`            cxxSettings: [\n${t.cSettings.map((s) => `                ${s},`).join('\n')}\n            ],`);
    } else {
      lines.push(`            swiftSettings: [\n${t.swiftSettings.map((s) => `                ${s},`).join('\n')}\n            ],`);
    }
    if (t.linkerSettings.length) lines.push(`            linkerSettings: [${t.linkerSettings.join(', ')}],`);
    lines.push('        ),');
    return lines.join('\n');
  });
  return `// swift-tools-version: 6.0
// Generated by expo2spm. Do not edit; rerun the generator.
import PackageDescription

let package = Package(
    name: ${q(name)},
    platforms: [.iOS("16.4")],
    products: [.library(name: ${q(name)}, targets: [${q(name)}])],
    targets: [
${body.join('\n')}
    ],
    cxxLanguageStandard: .cxx20
)
`;
}

// CocoaPods compiles every pod with a generated prefix header that pulls in UIKit for ObjC.
const PREFIX_HEADER = `#ifdef __OBJC__
#import <UIKit/UIKit.h>
#else
#ifndef FOUNDATION_EXPORT
#if defined(__cplusplus)
#define FOUNDATION_EXPORT extern "C"
#else
#define FOUNDATION_EXPORT extern
#endif
#endif
#endif
`;

export function dirHasFiles(dir: string): boolean {
  return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
}
