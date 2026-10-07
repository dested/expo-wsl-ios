// Podspec -> SpmConfig for native packages that ship no spm.config.json.
//
// eval.rb runs the podspec under a stub CocoaPods DSL and prints what it declared; this module
// expands its file patterns with CocoaPods semantics and reduces the pod to ONE product in the
// spm.config.json model (see ../spm-config.ts and plans/2026-10-07-expo-spm-generator.md section 1):
//   <Module>            swift target (all .swift)
//   <Module>_objc       ObjC/C/C++ sources + public headers staged as include/<HeaderDir>/X.h
//                       (named <Module> itself when the pod has no Swift)
//   <Module>_objc_late  ObjC sources that #import "<Module>-Swift.h" (built after the swift target)
//   <Module>_<Subspec>  sources of a merged subspec with its own compiler_flags (per-file flags)
//   <Framework>         vendored_frameworks
// Everything that cannot be expressed (script phases, prepare_command, vendored libraries, ...) is
// returned as a warning for a hand override.
//
// CLI: bun src/expo2spm/podspec/convert.ts <outDir> <node_modules dir> <npm name>...
import { Glob } from 'bun';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { spmConfig, type SpmConfig, type SpmProduct, type SpmTarget } from '../spm-config.ts';

// ---------------------------------------------------------------------------------------------
// eval.rb output (boundary)
// ---------------------------------------------------------------------------------------------

const strList = z.array(z.string());
const rawSpecBase = z.object({
  name: z.string().nullable(),
  version: z.string().nullable(),
  module_name: z.string().nullable(),
  header_dir: z.string().nullable(),
  header_mappings_dir: z.string().nullable(),
  source_files: strList,
  exclude_files: strList,
  public_header_files: strList,
  private_header_files: strList,
  dependencies: z.record(z.string(), strList),
  dependency_configurations: z.record(z.string(), strList),
  frameworks: strList,
  weak_frameworks: strList,
  libraries: strList,
  compiler_flags: strList,
  pod_target_xcconfig: z.record(z.string(), z.string()),
  user_target_xcconfig: z.record(z.string(), z.string()),
  xcconfig: z.record(z.string(), z.string()),
  resource_bundles: z.record(z.string(), strList),
  resources: strList,
  vendored_frameworks: strList,
  vendored_libraries: strList,
  preserve_paths: strList,
  script_phases: z.array(z.object({ name: z.string(), script: z.string(), execution_position: z.string().nullable() })),
  platforms: z.record(z.string(), z.string().nullable()),
  swift_versions: strList,
  static_framework: z.boolean().nullable(),
  prepare_command: z.string().nullable(),
  requires_arc: z.union([z.boolean(), strList]).nullable(),
  module_map: z.string().nullable(),
  rn_deps: z.boolean(),
  default_subspecs: strList,
  test_specs: z.array(z.object({ name: z.string(), source_files: strList })),
  other: strList,
});
export interface RawSpec extends z.infer<typeof rawSpecBase> {
  subspecs: RawSpec[];
}
export const rawSpec: z.ZodType<RawSpec> = rawSpecBase.extend({ subspecs: z.lazy(() => z.array(rawSpec)) });
const evalOutput = z.object({ error: z.string().nullable(), warnings: strList, spec: rawSpec.nullable() });

/** A RawSpec with every field empty; tests and callers override what they need. */
export function emptyRawSpec(name: string): RawSpec {
  return {
    name, version: null, module_name: null, header_dir: null, header_mappings_dir: null,
    source_files: [], exclude_files: [], public_header_files: [], private_header_files: [],
    dependencies: {}, dependency_configurations: {}, frameworks: [], weak_frameworks: [], libraries: [],
    compiler_flags: [], pod_target_xcconfig: {}, user_target_xcconfig: {}, xcconfig: {}, resource_bundles: {},
    resources: [], vendored_frameworks: [], vendored_libraries: [], preserve_paths: [], script_phases: [],
    platforms: {}, swift_versions: [], static_framework: null, prepare_command: null, requires_arc: null,
    module_map: null, rn_deps: false, default_subspecs: [], test_specs: [], other: [], subspecs: [],
  };
}

const EVAL_RB = path.join(import.meta.dir, 'eval.rb');

/** Run eval.rb on a podspec. */
export async function evalPodspec(podspecPath: string, projectRoot: string): Promise<{ spec: RawSpec; warnings: string[] }> {
  const proc = Bun.spawn(['ruby', EVAL_RB, podspecPath], {
    env: { ...process.env, EXPO2SPM_PROJECT_ROOT: projectRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`eval.rb ${podspecPath} exited ${code} without JSON:\n${stderr.slice(-2000)}`);
  }
  const out = evalOutput.parse(json);
  if (!out.spec) throw new Error(`eval.rb ${podspecPath}: ${out.error ?? 'no Pod::Spec'}\n${stderr.slice(-2000)}`);
  const warnings = out.error ? [`podspec raised: ${out.error}`, ...out.warnings] : out.warnings;
  return { spec: out.spec, warnings };
}

// ---------------------------------------------------------------------------------------------
// File patterns (CocoaPods semantics)
// ---------------------------------------------------------------------------------------------

const toPosix = (p: string): string => p.split(path.sep).join('/');
const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', '.build']);

export interface FileTree {
  files: string[];
  dirs: string[];
}

/** Every file and directory under `root`, as posix paths relative to it (node_modules etc. pruned). */
export function listTree(root: string): FileTree {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? path.join(root, rel) : root;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try {
          if (statSync(path.join(abs, ent.name)).isDirectory()) continue; // never follow dir links
        } catch {
          continue;
        }
        isDir = false;
      }
      if (isDir) {
        if (SKIP_DIRS.has(ent.name)) continue;
        dirs.push(childRel);
        walk(childRel);
      } else {
        files.push(childRel);
      }
    }
  };
  walk('');
  files.sort();
  dirs.sort();
  return { files, dirs };
}

/** `a/{b,c{d,e}}` -> `a/b`, `a/cd`, `a/ce` (CocoaPods expands braces before globbing). */
export function expandBraces(pattern: string): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const inner = pattern.slice(start + 1, i);
        const head = pattern.slice(0, start);
        const tail = pattern.slice(i + 1);
        return splitTopLevel(inner).flatMap((part) => expandBraces(head + part + tail));
      }
    }
  }
  return [pattern];
}

function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

const SOURCE_EXTS = new Set(['swift', 'm', 'mm', 'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'inc', 'def', 'ipp', 'tpp']);
const ext = (f: string): string => {
  const base = f.slice(f.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
};

function normalizePattern(p: string): string {
  let out = p.trim();
  while (out.startsWith('./')) out = out.slice(2);
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export class PatternSet {
  private readonly globs: Glob[];
  readonly outside: string[] = [];
  constructor(patterns: string[]) {
    const expanded = patterns.flatMap((p) => expandBraces(normalizePattern(p))).filter((p) => p !== '');
    for (const p of expanded) if (p.startsWith('../') || p.startsWith('/')) this.outside.push(p);
    this.globs = expanded.filter((p) => !p.startsWith('../') && !p.startsWith('/')).map((p) => new Glob(p));
  }
  get empty(): boolean {
    return this.globs.length === 0;
  }
  /** A file matches when a pattern names it, or names one of its directories (a directory pattern
   *  means everything under it: all files for exclude_files, source-like files for source_files). */
  matches(file: string, mode: 'source' | 'exclude'): boolean {
    for (const g of this.globs) {
      if (g.match(file)) return true;
    }
    if (mode === 'source' && !SOURCE_EXTS.has(ext(file))) return false;
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      for (const g of this.globs) if (g.match(dir)) return true;
    }
    return false;
  }
  matchDirs(dirs: string[]): string[] {
    return dirs.filter((d) => this.globs.some((g) => g.match(d)));
  }
}

const isTestPath = (f: string): boolean => f.split('/').some((seg) => seg === 'Tests' || seg === 'UITests');

/** Expand source/exclude patterns over a file list: CocoaPods semantics, tests and node_modules dropped. */
export function expandFiles(tree: FileTree, sources: string[], excludes: string[], testPatterns: string[] = []): string[] {
  const inc = new PatternSet(sources);
  if (inc.empty) return [];
  const exc = new PatternSet(excludes);
  const tests = new PatternSet(testPatterns);
  return tree.files.filter(
    (f) =>
      !isTestPath(f) &&
      !f.split('/').includes('node_modules') &&
      inc.matches(f, 'source') &&
      !exc.matches(f, 'exclude') &&
      !tests.matches(f, 'exclude'),
  );
}

// ---------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------

const RN_CORE = /^(React|React-.*|ReactCommon.*|Yoga|RCTRequired|RCTTypeSafety|RCTDeprecation|RCTSwiftUI.*|FBLazyVector|FBReactNativeSpec|ReactCodegen|ReactAppDependencyProvider|React-Core-prebuilt)$/;
const RN_DEPS = /^(RCT-Folly.*|glog|boost|boost-for-react-native|DoubleConversion|fmt|fast_float|SocketRocket|ReactNativeDependencies)$/;
const TOKEN_ORDER = ['Hermes', 'React', 'ReactNativeDependencies', 'expo-modules-jsi/ExpoModulesJSI', 'expo-modules-core/ExpoModulesCore'];

/** CocoaPods pod name (subspec path allowed) -> spm.config dependency token. */
export function mapPodDependency(pod: string): string {
  const base = pod.split('/')[0] ?? pod;
  if (base === 'hermes-engine') return 'Hermes';
  if (RN_CORE.test(base)) return 'React';
  if (RN_DEPS.test(base)) return 'ReactNativeDependencies';
  if (base === 'ExpoModulesCore') return 'expo-modules-core/ExpoModulesCore';
  if (base === 'ExpoModulesJSI') return 'expo-modules-jsi/ExpoModulesJSI';
  return `pod:${base}`;
}

/** Dependency tokens for a set of pod names, in a stable order (RN trio first, as Expo's configs do). */
export function dependencyTokens(pods: Iterable<string>, rnDeps: boolean): string[] {
  const set = new Set<string>();
  for (const p of pods) set.add(mapPodDependency(p));
  // Anything that sees React or ExpoModulesCore headers needs the whole RN header set (folly, jsi).
  if (rnDeps || set.has('React') || set.has('expo-modules-core/ExpoModulesCore')) {
    set.add('React');
    set.add('ReactNativeDependencies');
    set.add('Hermes');
  }
  const fixed = TOKEN_ORDER.filter((t) => set.has(t));
  const rest = [...set].filter((t) => !TOKEN_ORDER.includes(t)).sort();
  return [...fixed, ...rest];
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

/** Shell-like split of an xcconfig / compiler_flags string, honoring quotes. */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < s.length) cur += s.charAt(++i);
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < s.length) {
      cur += s.charAt(++i);
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const INHERITED = /^\$[({]inherited[)}]$/;
const tokens = (s: string): string[] => shellSplit(s).filter((t) => t !== '' && !INHERITED.test(t));
/** Drop exact repeats of single-token flags (-D/-W/-f/-U), keep pairs like `-include X` intact. */
function dedupeFlags(flags: string[]): string[] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    if (!/^-[DWfU]/.test(f)) return true;
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });
}

type FlavorKey = 'common' | 'debug' | 'release';
const ALL_FLAVORS: FlavorKey[] = ['common', 'debug', 'release'];
interface LangFlags {
  c: string[];
  cxx: string[];
}
type FlavoredFlags = Record<FlavorKey, LangFlags>;
const emptyFlavored = (): FlavoredFlags => ({
  common: { c: [], cxx: [] },
  debug: { c: [], cxx: [] },
  release: { c: [], cxx: [] },
});

const BENIGN_XCCONFIG = new Set([
  'DEFINES_MODULE', 'SWIFT_COMPILATION_MODE', 'USE_HEADERMAP', 'CLANG_ENABLE_MODULES', 'SWIFT_VERSION',
  'APPLICATION_EXTENSION_API_ONLY', 'ENABLE_BITCODE', 'CLANG_CXX_LIBRARY', 'SWIFT_INSTALL_OBJC_HEADER',
  'GCC_WARN_INHIBIT_ALL_WARNINGS', 'CLANG_WARN_DOCUMENTATION_COMMENTS', 'SKIP_INSTALL', 'BUILD_LIBRARY_FOR_DISTRIBUTION',
]);

interface XcconfigResult {
  cc: FlavoredFlags; // GCC_PREPROCESSOR_DEFINITIONS + OTHER_CFLAGS/OTHER_CPLUSPLUSFLAGS (reach Swift via -Xcc too)
  swift: string[];
  linker: string[];
  /** Absolute include dirs from $(PODS_TARGET_SRCROOT)/... */
  includes: string[];
}

/** Translate pod_target_xcconfig + xcconfig (already concatenated per key). */
export function translateXcconfig(
  settings: Map<string, string[]>,
  podDir: string,
  podsRoot: string | null,
  warn: (m: string) => void,
): XcconfigResult {
  const res: XcconfigResult = { cc: emptyFlavored(), swift: [], linker: [], includes: [] };
  const dropped: string[] = [];
  const cppOnly: Record<FlavorKey, { flags: string[]; inheritsC: boolean }> = {
    common: { flags: [], inheritsC: true },
    debug: { flags: [], inheritsC: true },
    release: { flags: [], inheritsC: true },
  };
  const cflags: Record<FlavorKey, string[]> = { common: [], debug: [], release: [] };
  for (const [rawKey, values] of settings) {
    const m = /^([A-Z0-9_]+)(?:\[(.+)\])?$/.exec(rawKey);
    const key = m?.[1] ?? rawKey;
    const cond = m?.[2];
    let flavor: FlavorKey = 'common';
    if (cond) {
      if (/^config=\*?Debug\*?$/i.test(cond)) flavor = 'debug';
      else if (/^config=\*?Release\*?$/i.test(cond)) flavor = 'release';
      else if (/^sdk=iphoneos\*?$/.test(cond)) flavor = 'common';
      else {
        warn(`xcconfig ${rawKey} dropped (condition not supported)`);
        continue;
      }
    }
    const joined = values.join(' ');
    switch (key) {
      case 'GCC_PREPROCESSOR_DEFINITIONS':
        cflags[flavor].push(...tokens(joined).map((d) => `-D${d}`));
        break;
      case 'OTHER_CFLAGS':
        cflags[flavor].push(...tokens(joined));
        break;
      case 'OTHER_CPLUSPLUSFLAGS': {
        const t = shellSplit(joined);
        cppOnly[flavor].inheritsC = t.some((x) => INHERITED.test(x) || /\$[({]OTHER_CFLAGS[)}]/.test(x));
        cppOnly[flavor].flags.push(...t.filter((x) => !INHERITED.test(x) && !/\$[({]OTHER_CFLAGS[)}]/.test(x)));
        break;
      }
      case 'OTHER_SWIFT_FLAGS':
        if (flavor === 'common') res.swift.push(...tokens(joined));
        else if (tokens(joined).length) warn(`${rawKey} '${tokens(joined).join(' ')}' dropped: swiftFlags has no ${flavor} variant`);
        break;
      case 'OTHER_LDFLAGS': {
        // Paths into Pods/ or build dirs mean nothing here; drop them with the flag that takes them.
        const t = tokens(joined);
        const kept: string[] = [];
        const lost: string[] = [];
        for (let i = 0; i < t.length; i++) {
          const x = t[i] ?? '';
          const next = t[i + 1] ?? '';
          if (/^-(force_load|L|F)$/.test(x) && next.includes('$(')) {
            lost.push(x, next);
            i++;
          } else if (x.includes('$(')) lost.push(x);
          else kept.push(x);
        }
        if (lost.length) warn(`OTHER_LDFLAGS dropped (build-var paths; needs a hand override): ${lost.join(' ')}`);
        if (flavor !== 'common' && kept.length) warn(`${rawKey} applied to every flavor (linkerFlags has no flavors)`);
        res.linker.push(...kept);
        break;
      }
      case 'HEADER_SEARCH_PATHS':
      case 'USER_HEADER_SEARCH_PATHS':
        for (const raw of tokens(joined)) {
          let p = raw.replace(/\$\{([A-Za-z_]+)\}/g, '$($1)');
          if (p.endsWith('/**')) {
            warn(`${key} ${raw}: recursive search path flattened to its root`);
            p = p.slice(0, -3);
          }
          let abs: string | null = null;
          if (p.startsWith('$(PODS_TARGET_SRCROOT)')) abs = path.join(podDir, p.slice('$(PODS_TARGET_SRCROOT)'.length));
          // "$(PODS_ROOT)/../node_modules/<this package>/x" is the pod's own tree spelled from Pods/.
          if (p.startsWith('$(PODS_ROOT)/') && podsRoot) {
            const r = path.resolve(podsRoot, p.slice('$(PODS_ROOT)/'.length));
            if (r === podDir || r.startsWith(podDir + path.sep)) abs = r;
          }
          if (abs !== null) {
            if (existsSync(abs)) {
              if (!res.includes.includes(abs)) res.includes.push(abs);
            } else warn(`${key} ${raw} does not exist; dropped`);
          } else if (/\$\((PODS_ROOT|PODS_CONFIGURATION_BUILD_DIR|PODS_XCFRAMEWORKS_BUILD_DIR)\)/.test(p)) {
            dropped.push(raw);
          } else {
            warn(`${key} ${raw} dropped (not under PODS_TARGET_SRCROOT)`);
          }
        }
        break;
      case 'CLANG_CXX_LANGUAGE_STANDARD':
        if (!/^(gnu|c)\+\+20$/.test(joined.trim())) warn(`CLANG_CXX_LANGUAGE_STANDARD=${joined.trim()} (package builds C++20)`);
        break;
      case 'SWIFT_OPTIMIZATION_LEVEL': {
        // A pod that pins its optimization (hot loops that crawl at -Onone) keeps it in debug builds.
        const level = joined.trim();
        if (flavor === 'common' && /^-O(none|size|unchecked)?$/.test(level)) res.swift.push(level);
        else warn(`xcconfig ${rawKey}=${level} ignored`);
        break;
      }
      case 'FRAMEWORK_SEARCH_PATHS':
        warn(`FRAMEWORK_SEARCH_PATHS ${joined} dropped`);
        break;
      default:
        if (!BENIGN_XCCONFIG.has(key)) warn(`xcconfig ${rawKey}=${joined} ignored`);
    }
  }
  if (dropped.length) warn(`header search paths into Pods/ dropped (generator supplies RN headers): ${dropped.join(' ')}`);
  for (const f of ALL_FLAVORS) {
    const c = dedupeFlags(cflags[f]);
    const cxx = dedupeFlags([...(cppOnly[f].inheritsC ? c : []), ...cppOnly[f].flags]);
    res.cc[f] = { c, cxx };
  }
  // A flavored setting that repeats the common one (OTHER_CFLAGS + OTHER_CFLAGS[config=*Debug*]) adds nothing.
  for (const f of ALL_FLAVORS.filter((x) => x !== 'common')) {
    const notCommon = (lang: 'c' | 'cxx') => (x: string) => !(/^-[DWfU]/.test(x) && res.cc.common[lang].includes(x));
    res.cc[f] = { c: res.cc[f].c.filter(notCommon('c')), cxx: res.cc[f].cxx.filter(notCommon('cxx')) };
  }
  res.swift = dedupeFlags(res.swift);
  return res;
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** FlavoredFlags -> the compilerFlags field (smallest shape that says the same thing). */
function toCompilerFlags(f: FlavoredFlags): SpmTarget['compilerFlags'] {
  const lang = (l: LangFlags): string[] | { c?: string[]; cxx?: string[] } | undefined => {
    if (!l.c.length && !l.cxx.length) return undefined;
    if (sameList(l.c, l.cxx)) return l.c;
    const o: { c?: string[]; cxx?: string[] } = {};
    if (l.c.length) o.c = l.c;
    if (l.cxx.length) o.cxx = l.cxx;
    return o;
  };
  const common = lang(f.common);
  const debug = lang(f.debug);
  const release = lang(f.release);
  if (!debug && !release) {
    if (common === undefined) return undefined;
    return Array.isArray(common) ? common : { common };
  }
  const out: Exclude<NonNullable<SpmTarget['compilerFlags']>, string[]> = {};
  if (common) out.common = common;
  if (debug) out.debug = debug;
  if (release) out.release = release;
  return out;
}

function addFlags(base: FlavoredFlags, extra: string[], flavor: FlavorKey = 'common'): FlavoredFlags {
  const out = structuredClone(base);
  out[flavor].c = dedupeFlags([...out[flavor].c, ...extra]);
  out[flavor].cxx = dedupeFlags([...out[flavor].cxx, ...extra]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

export interface ConvertOptions {
  /** The npm package directory; every path in the config is relative to it. */
  packageRoot: string;
  /** npm name (for messages and output naming). */
  packageName: string;
  /** Pod::Config.instance.project_root (the app's ios/ dir). Defaults to EXPO2SPM_PROJECT_ROOT or <app>/ios. */
  projectRoot?: string;
}

export interface ConvertResult {
  config: SpmConfig;
  warnings: string[];
  codegen: boolean;
  /** Pods the product depends on that are not RN/Expo core (`pod:X` tokens), with their
   *  CocoaPods version requirements; the caller resolves them to npm packages or remote pods. */
  externalPods: Record<string, string[]>;
}

const c99 = (s: string): string => {
  const id = s.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(id) ? `_${id}` : id;
};

interface SpecNode {
  spec: RawSpec;
  fullName: string;
  chain: RawSpec[]; // root .. this spec
}

/** Root + the subspecs a plain `pod 'X'` gets: default_subspecs (or all), recursively, plus any
 *  own subspec another selected spec depends on. */
export function selectSpecs(root: RawSpec, warn: (m: string) => void): SpecNode[] {
  const rootName = root.name ?? '';
  const all = new Map<string, SpecNode>();
  const index = (spec: RawSpec, fullName: string, chain: RawSpec[]): void => {
    all.set(fullName, { spec, fullName, chain });
    for (const sub of spec.subspecs) index(sub, `${fullName}/${sub.name ?? ''}`, [...chain, sub]);
  };
  index(root, rootName, [root]);

  const selected = new Set<string>();
  const include = (fullName: string): void => {
    const node = all.get(fullName);
    if (!node || selected.has(fullName)) return;
    selected.add(fullName);
    // A subspec implies its ancestors' own files (CocoaPods always includes the parent's files).
    const parent = fullName.slice(0, fullName.lastIndexOf('/'));
    if (fullName.includes('/')) include(parent);
    const subs = node.spec.subspecs;
    if (!subs.length) return;
    const defaults = node.spec.default_subspecs;
    if (defaults.includes(':none') || defaults.includes('none')) return;
    const picks = defaults.length ? defaults : subs.map((s) => s.name ?? '');
    for (const p of picks) include(`${fullName}/${p}`);
  };
  include(rootName);
  // Own-subspec dependencies (expo-dev-launcher/Main -> expo-dev-launcher/Unsafe), to a fixpoint.
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of [...selected]) {
      for (const dep of Object.keys(all.get(name)?.spec.dependencies ?? {})) {
        if (dep.startsWith(`${rootName}/`) && !selected.has(dep) && all.has(dep)) {
          include(dep);
          changed = true;
        }
      }
    }
  }
  const nodes = [...all.values()].filter((n) => selected.has(n.fullName));
  const merged = nodes.filter((n) => n.fullName !== rootName).map((n) => n.fullName);
  const left = [...all.keys()].filter((k) => !selected.has(k));
  if (merged.length) warn(`subspecs merged into the product: ${merged.join(', ')}`);
  if (left.length) warn(`non-default subspecs left out (need an override if the app uses them): ${left.join(', ')}`);
  return nodes;
}

const INCLUDE_RE = /^[ \t]*#[ \t]*(?:import|include)[ \t]*[<"]([^>"]+)[>"]/gm;
const includesOf = (text: string): string[] => [...text.matchAll(INCLUDE_RE)].map((m) => m[1] ?? '');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type FileKind = 'swift' | 'objc' | 'c' | 'header' | 'textual' | 'other';
function kindOf(f: string): FileKind {
  const e = ext(f);
  if (e === 'swift') return 'swift';
  if (e === 'm' || e === 'mm') return 'objc';
  if (e === 'c' || e === 'cc' || e === 'cpp' || e === 'cxx') return 'c';
  if (e === 'h' || e === 'hh' || e === 'hpp' || e === 'hxx') return 'header';
  if (e === 'inc' || e === 'def' || e === 'ipp' || e === 'tpp') return 'textual';
  return 'other';
}

interface HeaderInfo {
  file: string; // relative to the podspec dir
  isPublic: boolean;
  headerDir: string;
  mappingsDir: string | null;
}

interface SourceGroup {
  key: string; // '' for the main group, else the subspec full name
  flags: string[]; // effective s.compiler_flags
  files: string[];
}

export interface ConvertContext {
  podspecDir: string;
  packageRoot: string;
  packageName: string;
  /** $(PODS_ROOT): <project root>/Pods. Lets "$(PODS_ROOT)/../node_modules/<pkg>/x" resolve. */
  podsRoot?: string;
  tree?: FileTree;
  readText?: (abs: string) => string;
}

/** The pure half: a RawSpec + the file tree -> one product. */
export function convertSpec(root: RawSpec, ctx: ConvertContext): { product: SpmProduct; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const tree = ctx.tree ?? listTree(ctx.podspecDir);
  const readText = ctx.readText ?? ((abs: string) => readFileSync(abs, 'utf8'));
  const podName = root.name ?? path.basename(ctx.podspecDir);
  // CocoaPods: module_name || c99(header_dir) || c99(name).
  const moduleName = c99(root.module_name ?? root.header_dir ?? podName);
  const headerDir = root.header_dir ?? root.module_name ?? podName;
  const podRel = toPosix(path.relative(ctx.packageRoot, ctx.podspecDir));
  const pkgRel = (fromPod: string): string => toPosix(path.normalize(path.join(podRel, fromPod)));

  const nodes = selectSpecs(root, warn);
  const testPatterns = nodes.flatMap((n) => n.spec.test_specs.flatMap((t) => t.source_files));

  // --- files per spec -------------------------------------------------------------------------
  const rootFlags = root.compiler_flags.flatMap(tokens);
  const groups = new Map<string, SourceGroup>();
  groups.set('', { key: '', flags: rootFlags, files: [] });
  const owner = new Map<string, string>(); // source file -> group key
  const headers = new Map<string, HeaderInfo>();
  const textual = new Set<string>();
  const others = new Set<string>();

  for (const node of nodes) {
    const { spec, chain } = node;
    const set = new PatternSet(spec.source_files);
    for (const p of set.outside) warn(`${node.fullName}: source pattern outside the pod dir ignored: ${p}`);
    const files = expandFiles(tree, spec.source_files, spec.exclude_files, testPatterns);
    if (spec.source_files.length && !files.length) warn(`${node.fullName}: source_files ${spec.source_files.join(', ')} matched nothing`);
    const effFlags = chain.flatMap((s) => s.compiler_flags.flatMap(tokens));
    const ownFlags = spec !== root && spec.compiler_flags.length > 0;
    const groupKey = ownFlags ? node.fullName : '';
    if (ownFlags && !groups.has(groupKey)) groups.set(groupKey, { key: groupKey, flags: effFlags, files: [] });
    const nearest = (pick: (s: RawSpec) => string | null): string | null => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const v = chain[i];
        if (v) {
          const x = pick(v);
          if (x) return x;
        }
      }
      return null;
    };
    const pubPatterns = (() => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const s = chain[i];
        if (s?.public_header_files.length) return new PatternSet(s.public_header_files);
      }
      return null;
    })();
    const privPatterns = new PatternSet(chain.flatMap((s) => s.private_header_files));
    const hdrDir = nearest((s) => s.header_dir) ?? headerDir;
    const mappings = nearest((s) => s.header_mappings_dir);

    for (const f of files) {
      const kind = kindOf(f);
      if (kind === 'header') {
        if (headers.has(f)) continue;
        const isPublic = (pubPatterns ? pubPatterns.matches(f, 'exclude') : true) && !privPatterns.matches(f, 'exclude');
        headers.set(f, { file: f, isPublic, headerDir: hdrDir, mappingsDir: mappings ? normalizePattern(mappings) : null });
      } else if (kind === 'textual') {
        textual.add(f);
      } else if (kind === 'other') {
        others.add(f);
      } else {
        const prev = owner.get(f);
        // A flagged subspec wins over the plain group (miniaudio_impl's "-x objective-c++").
        if (prev === undefined || (prev === '' && groupKey !== '')) owner.set(f, groupKey);
        else if (prev !== groupKey && groupKey !== '') warn(`${f} listed by ${prev} and ${groupKey}; kept in ${prev}`);
      }
    }
    if (spec.requires_arc === false || Array.isArray(spec.requires_arc)) warn(`${node.fullName}: requires_arc=${JSON.stringify(spec.requires_arc)} (non-ARC files need -fno-objc-arc by hand)`);
    if (spec.header_mappings_dir) warn(`${node.fullName}: header_mappings_dir ${spec.header_mappings_dir}: headers reached through includeDirectories, not staged`);
    if (spec.module_map) warn(`${node.fullName}: custom module_map ${spec.module_map} ignored`);
    if (spec.prepare_command) warn(`prepare_command needs a hand override: ${spec.prepare_command.trim().split('\n').join(' ; ')}`);
    for (const sp of spec.script_phases) warn(`script phase '${sp.name}' (${sp.execution_position ?? 'default'}) needs a hand override`);
    if (spec.vendored_libraries.length) warn(`vendored_libraries need a hand override: ${spec.vendored_libraries.join(', ')}`);
    for (const [dep, cfgs] of Object.entries(spec.dependency_configurations)) warn(`dependency ${dep} limited to configurations ${cfgs.join(',')}`);
    for (const k of Object.keys(spec.user_target_xcconfig)) {
      const v = spec.user_target_xcconfig[k] ?? '';
      if (!(k === 'HEADER_SEARCH_PATHS' && /Swift Compatibility Header|PODS_ROOT/.test(v))) warn(`user_target_xcconfig ${k}=${v} (app-level setting) ignored`);
    }
  }
  if (others.size) warn(`non-source files in source_files ignored: ${[...others].slice(0, 6).join(', ')}${others.size > 6 ? ` (+${others.size - 6})` : ''}`);
  for (const [f, g] of owner) groups.get(g)?.files.push(f);
  const swiftFiles = [...owner].filter(([f, g]) => g === '' && kindOf(f) === 'swift').map(([f]) => f);
  for (const [f, g] of owner) if (g !== '' && kindOf(f) === 'swift') warn(`${f}: Swift in flagged subspec ${g} moved to the swift target`);
  const flaggedSwift = [...owner].filter(([f, g]) => g !== '' && kindOf(f) === 'swift').map(([f]) => f);
  swiftFiles.push(...flaggedSwift);

  // --- own Swift header detection ---------------------------------------------------------------
  const swiftHeaderRe = new RegExp(`[<"](?:[^<>"]*/)?${escapeRe(moduleName)}-Swift\\.h[>"]`);
  const fileText = new Map<string, string>();
  const textOf = (f: string): string => {
    let t = fileText.get(f);
    if (t === undefined) {
      try {
        t = readText(path.join(ctx.podspecDir, f));
      } catch {
        t = '';
      }
      fileText.set(f, t);
    }
    return t;
  };
  const headerByBase = new Map<string, string[]>();
  for (const h of [...headers.keys(), ...textual]) {
    const b = h.slice(h.lastIndexOf('/') + 1);
    headerByBase.set(b, [...(headerByBase.get(b) ?? []), h]);
  }
  const ownHeadersIncluded = (f: string): string[] =>
    includesOf(textOf(f)).flatMap((inc) => headerByBase.get(inc.slice(inc.lastIndexOf('/') + 1)) ?? []);
  const swifty = new Set<string>([...headers.keys()].filter((h) => swiftHeaderRe.test(textOf(h))));
  for (let changed = true; changed; ) {
    changed = false;
    for (const h of headers.keys()) {
      if (!swifty.has(h) && ownHeadersIncluded(h).some((x) => swifty.has(x))) {
        swifty.add(h);
        changed = true;
      }
    }
  }
  const importsOwnSwift = (f: string): boolean => swiftHeaderRe.test(textOf(f)) || ownHeadersIncluded(f).some((h) => swifty.has(h));

  // --- dependencies, flags ----------------------------------------------------------------------
  const pods = new Set<string>();
  let rnDeps = false;
  for (const n of nodes) {
    rnDeps ||= n.spec.rn_deps;
    for (const d of Object.keys(n.spec.dependencies)) if (!d.startsWith(`${podName}/`) && d !== podName) pods.add(d);
  }
  const productDeps = dependencyTokens(pods, rnDeps);

  const settings = new Map<string, string[]>();
  for (const n of nodes) {
    for (const src of [n.spec.xcconfig, n.spec.pod_target_xcconfig]) {
      for (const [k, v] of Object.entries(src)) settings.set(k, [...(settings.get(k) ?? []), v]);
    }
  }
  const xc = translateXcconfig(settings, ctx.podspecDir, ctx.podsRoot ?? null, warn);
  const frameworks = [...new Set(nodes.flatMap((n) => [...n.spec.frameworks, ...n.spec.weak_frameworks]))];
  const libs = [...new Set(nodes.flatMap((n) => n.spec.libraries))].map((l) => `-l${l.replace(/^lib/, '')}`);
  const linkerFlags = [...libs, ...xc.linker];

  // --- vendored frameworks ------------------------------------------------------------------------
  const frameworkTargets: SpmTarget[] = [];
  for (const n of nodes) {
    for (const pattern of n.spec.vendored_frameworks) {
      const norm = normalizePattern(pattern);
      const found = new PatternSet([norm]).matchDirs(tree.dirs).filter((d) => /\.(xc)?framework$/.test(d));
      const paths = found.length ? found : /[*?[{]/.test(norm) ? [] : [norm];
      if (!found.length) warn(`vendored framework ${norm} not on disk (downloaded by prepare_command/script phase?)`);
      for (const p of paths) {
        const name = c99(path.posix.basename(p).replace(/\.(xc)?framework$/, ''));
        if (!frameworkTargets.some((t) => t.name === name)) frameworkTargets.push({ type: 'framework', name, path: pkgRel(p) });
      }
    }
  }
  const frameworkNames = frameworkTargets.map((t) => t.name);

  // --- targets ------------------------------------------------------------------------------------
  const main = groups.get('') ?? { key: '', flags: rootFlags, files: [] };
  const mainObjc = main.files.filter((f) => kindOf(f) !== 'swift');
  const hasSwift = swiftFiles.length > 0;
  const lateFiles = hasSwift ? mainObjc.filter(importsOwnSwift) : [];
  if (!hasSwift && mainObjc.some(importsOwnSwift)) warn(`sources import ${moduleName}-Swift.h but the pod has no Swift`);
  const earlyFiles = mainObjc.filter((f) => !lateFiles.includes(f));
  const publicHeaders = [...headers.values()].filter((h) => h.isPublic && !h.mappingsDir);
  const earlyHeaders = publicHeaders.filter((h) => !swifty.has(h.file));
  const lateHeaders = hasSwift ? publicHeaders.filter((h) => swifty.has(h.file)) : [];
  for (const h of publicHeaders) {
    if (h.headerDir !== headerDir) warn(`${h.file}: header_dir ${h.headerDir} differs from ${headerDir}; staged under ${headerDir}`);
  }
  const baseSeen = new Map<string, string>();
  for (const h of publicHeaders) {
    const b = path.posix.basename(h.file);
    const prev = baseSeen.get(b);
    if (prev) warn(`public headers ${prev} and ${h.file} collide when flattened`);
    else baseSeen.set(b, h.file);
  }
  for (const h of lateHeaders) warn(`${h.file} imports ${moduleName}-Swift.h: staged with ${moduleName}_objc_late`);

  const objcName = hasSwift ? `${moduleName}_objc` : moduleName;
  const lateName = `${moduleName}_objc_late`;
  const mainTargetName = hasSwift ? moduleName : objcName;
  const includeAbs = xc.includes;
  for (const n of nodes) {
    const md = n.spec.header_mappings_dir;
    if (md) {
      // <header_dir/x.h> resolves from the mappings dir's parent when the dir is named like header_dir.
      const hd = n.chain.reduceRight<string | null>((acc, s) => acc ?? s.header_dir, null);
      const mdAbs = path.join(ctx.podspecDir, normalizePattern(md));
      if (hd && toPosix(mdAbs).endsWith(`/${hd}`)) includeAbs.push(mdAbs.slice(0, mdAbs.length - hd.length - 1));
      else includeAbs.push(mdAbs);
    }
  }

  const targets: SpmTarget[] = [];
  const commonDir = (files: string[]): string => {
    const dirs = files.map((f) => path.posix.dirname(pkgRel(f)).split('/'));
    const first = dirs[0];
    if (!first) return podRel || '.';
    let n = first.length;
    for (const d of dirs) {
      let i = 0;
      while (i < n && d[i] === first[i]) i++;
      n = i;
    }
    const joined = first.slice(0, n).join('/');
    return joined === '' ? '.' : joined;
  };
  const relTo = (targetPath: string, fromPod: string): string => {
    const r = path.posix.relative(targetPath === '.' ? '' : targetPath, pkgRel(fromPod));
    return r === '' ? '.' : r;
  };
  const includeDirsFor = (targetPath: string, sources: string[], staged: Set<string>): string[] => {
    const out: string[] = [];
    const push = (d: string): void => {
      if (!out.includes(d)) out.push(d);
    };
    for (const abs of includeAbs) push(relTo(targetPath, toPosix(path.relative(ctx.podspecDir, abs)) || '.'));
    // CocoaPods' header map: a bare #import "X.h" finds any header of the pod. Headers this target
    // does not stage itself are reached in the source tree.
    const referenced = new Set<string>();
    for (const f of [...sources, ...headers.keys()]) {
      for (const inc of includesOf(textOf(f))) if (!inc.includes('/')) referenced.add(inc);
    }
    for (const [base, files] of headerByBase) {
      if (!referenced.has(base)) continue;
      for (const h of files) if (!staged.has(h) && !headers.get(h)?.mappingsDir) push(relTo(targetPath, path.posix.dirname(h)));
    }
    return out;
  };
  const withCommon = (t: SpmTarget, deps: string[]): SpmTarget => {
    if (deps.length) t.dependencies = deps;
    if (frameworks.length) t.linkedFrameworks = frameworks;
    if (linkerFlags.length) t.linkerFlags = linkerFlags;
    return t;
  };
  const objcTarget = (name: string, files: string[], hdrs: HeaderInfo[], flags: string[], deps: string[]): SpmTarget => {
    const all = [...files, ...hdrs.map((h) => h.file)];
    const tPath = commonDir(all);
    const t: SpmTarget = {
      type: files.some((f) => kindOf(f) === 'objc') || !files.length ? 'objc' : 'cpp',
      name,
      moduleName: headerDir,
      path: tPath,
      files: files.map((f) => relTo(tPath, f)).sort(),
    };
    if (hdrs.length) t.headers = hdrs.map((h) => relTo(tPath, h.file)).sort();
    const inc = includeDirsFor(tPath, files, new Set(hdrs.map((h) => h.file)));
    if (inc.length) t.includeDirectories = inc;
    const cf = toCompilerFlags(addFlags(xc.cc, flags));
    if (cf !== undefined) t.compilerFlags = cf;
    return withCommon(t, deps);
  };

  if (hasSwift) {
    const tPath = commonDir(swiftFiles);
    const t: SpmTarget = { type: 'swift', name: moduleName, path: tPath, files: swiftFiles.map((f) => relTo(tPath, f)).sort() };
    const cf = toCompilerFlags(xc.cc);
    if (cf !== undefined) t.compilerFlags = cf;
    if (xc.swift.length) t.swiftFlags = xc.swift;
    const hasObjc = earlyFiles.length > 0 || earlyHeaders.length > 0;
    targets.push(withCommon(t, [...productDeps, ...frameworkNames, ...(hasObjc ? [objcName] : [])]));
  }
  if (earlyFiles.length || earlyHeaders.length) {
    if (!earlyFiles.length) warn(`${objcName} has public headers but no ObjC sources (SwiftPM needs one; generator must add a stub)`);
    targets.push(objcTarget(objcName, earlyFiles, earlyHeaders, main.flags, [...productDeps, ...frameworkNames]));
  }
  const hasEarly = targets.some((t) => t.name === objcName);
  if (lateFiles.length || lateHeaders.length) {
    const t = objcTarget(lateName, lateFiles, lateHeaders, main.flags, [
      ...productDeps,
      ...frameworkNames,
      moduleName,
      ...(hasEarly ? [objcName] : []),
    ]);
    t.importsSwiftHeaderOf = moduleName;
    targets.push(t);
  }
  for (const g of groups.values()) {
    if (g.key === '') continue;
    const files = g.files.filter((f) => kindOf(f) !== 'swift');
    if (!files.length) continue;
    const name = `${moduleName}_${c99(g.key.slice(podName.length + 1))}`;
    const late = hasSwift && files.some(importsOwnSwift);
    const t = objcTarget(name, files, [], g.flags, [
      ...productDeps,
      ...frameworkNames,
      ...(late ? [moduleName] : []),
      ...(hasEarly ? [objcName] : []),
    ]);
    if (late) t.importsSwiftHeaderOf = moduleName;
    warn(`${g.key}: own compiler_flags '${g.flags.join(' ')}' -> separate target ${name}`);
    targets.push(t);
  }
  targets.push(...frameworkTargets);

  // Resources ride on the main target.
  const mainTarget = targets.find((t) => t.name === mainTargetName) ?? targets.find((t) => t.type !== 'framework');
  const bundles: Record<string, string[]> = {};
  const resources: string[] = [];
  for (const n of nodes) {
    for (const [name, globs] of Object.entries(n.spec.resource_bundles)) bundles[name] = [...(bundles[name] ?? []), ...globs.map((g) => pkgRel(normalizePattern(g)))];
    resources.push(...n.spec.resources.map((g) => pkgRel(normalizePattern(g))));
  }
  if (resources.length) warn(`resources (${resources.join(', ')}) go to the app bundle root under CocoaPods; the model puts them in a target bundle`);
  if (mainTarget) {
    if (Object.keys(bundles).length) mainTarget.resourceBundles = bundles;
    if (resources.length) mainTarget.resources = resources;
  } else if (Object.keys(bundles).length || resources.length) {
    warn('resources declared but the pod has no sources to carry them');
  }
  if (!targets.length) warn('no source files: a dependency-only pod (no targets)');

  const product: SpmProduct = { name: moduleName, podName, targets };
  const ios = root.platforms['ios'];
  if (ios) product.platforms = [`iOS("${ios}")`];
  else if (!Object.keys(root.platforms).length) product.platforms = ['iOS("15.1")'];
  if (productDeps.length) product.externalDependencies = productDeps;
  if (root.swift_versions.length) product.swiftLanguageVersions = root.swift_versions;
  return { product, warnings };
}

function defaultProjectRoot(packageRoot: string): string {
  const env = process.env['EXPO2SPM_PROJECT_ROOT'];
  if (env) return env;
  let dir = path.resolve(packageRoot);
  while (path.basename(dir) !== 'node_modules') {
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(packageRoot);
    dir = up;
  }
  const app = path.dirname(dir);
  const ios = path.join(app, 'ios');
  // CNG apps have no ios/ yet; helpers `cd` into project_root, so it must exist.
  return existsSync(ios) ? ios : app;
}

const packageJson = z.object({ codegenConfig: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough();

/** Podspec -> SpmConfig with one product. */
export async function convertPodspec(podspecPath: string, opts: ConvertOptions): Promise<ConvertResult> {
  const podspecAbs = path.resolve(podspecPath);
  const projectRoot = opts.projectRoot ?? defaultProjectRoot(opts.packageRoot);
  const { spec, warnings: evalWarnings } = await evalPodspec(podspecAbs, projectRoot);
  const { product, warnings } = convertSpec(spec, {
    podsRoot: path.join(projectRoot, 'Pods'),
    podspecDir: path.dirname(podspecAbs),
    packageRoot: path.resolve(opts.packageRoot),
    packageName: opts.packageName,
  });
  let codegen = false;
  const pj = path.join(opts.packageRoot, 'package.json');
  if (existsSync(pj)) {
    const parsed = packageJson.safeParse(JSON.parse(readFileSync(pj, 'utf8')));
    const cg = parsed.success ? parsed.data.codegenConfig : undefined;
    if (cg) {
      codegen = true;
      if (cg.name) product.codegenName = cg.name;
    }
  }
  const config = spmConfig.parse({ products: [product] });
  return { config, warnings: [...evalWarnings, ...warnings], codegen, externalPods: externalPods(spec, product) };
}

function externalPods(spec: RawSpec, product: SpmProduct): Record<string, string[]> {
  const wanted = new Set(product.targets.flatMap((t) => t.dependencies ?? []).filter((d) => d.startsWith('pod:')).map((d) => d.slice(4)));
  const out: Record<string, string[]> = {};
  const walk = (s: RawSpec): void => {
    for (const [dep, reqs] of Object.entries(s.dependencies)) {
      const base = dep.split('/')[0] ?? dep;
      if (wanted.has(base)) out[base] = [...new Set([...(out[base] ?? []), ...reqs])];
    }
    s.subspecs.forEach(walk);
  };
  walk(spec);
  for (const name of wanted) out[name] ??= [];
  return out;
}

/** The package's podspec: <pkg>/*.podspec, else <pkg>/ios/*.podspec. */
export function findPodspec(packageRoot: string): string | null {
  for (const dir of [packageRoot, path.join(packageRoot, 'ios')]) {
    if (!existsSync(dir)) continue;
    const found = readdirSync(dir).filter((f) => f.endsWith('.podspec')).sort();
    const first = found[0];
    if (first) return path.join(dir, first);
  }
  return null;
}

if (import.meta.main) {
  const [outDir, nodeModules, ...names] = process.argv.slice(2);
  if (!outDir || !nodeModules || !names.length) {
    console.error('usage: bun convert.ts <outDir> <node_modules dir> <npm name>...');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const packageRoot = path.join(nodeModules, name);
    const podspec = findPodspec(packageRoot);
    if (!podspec) {
      console.error(`${name}: no podspec`);
      continue;
    }
    try {
      const res = await convertPodspec(podspec, { packageRoot, packageName: name });
      const file = path.join(outDir, `${name.replaceAll('/', '__')}.json`);
      await Bun.write(file, `${JSON.stringify(res, null, 2)}\n`);
      const ts = res.config.products.flatMap((p) => p.targets.map((t) => `${t.name}:${t.type}`));
      console.log(`${name}: ${ts.join(' ')} | ${res.warnings.length} warnings${res.codegen ? ' | codegen' : ''}`);
    } catch (e) {
      console.error(`${name}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
