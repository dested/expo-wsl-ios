// Collect the app's autolinked native packages and reduce each to an SpmConfig, choosing per
// product whether it links a prebuilt xcframework or builds from source.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { convertPodspec } from './podspec/convert.ts';
import { fetchPod } from './remote-pods.ts';
import { spmConfig, type Flavor, type SpmConfig, type SpmProduct } from './spm-config.ts';
import { toPosixPath, type ExpoResolve, type RnConfig } from './inputs.ts';

export type Tier = 'override' | 'spm' | 'spm-external' | 'podspec' | 'remote-pod';

export interface NativePackage {
  name: string;
  version: string;
  root: string;
  pods: string[];
  tier: Tier;
  config: SpmConfig;
  /** package.json has codegenConfig. */
  codegen: boolean;
  warnings: string[];
  /** Podspec dependencies on pods outside RN/Expo core, with version requirements. */
  externalPods: Record<string, string[]>;
}

export type ProductSource =
  | { kind: 'binary'; xcframework: string }
  | { kind: 'source' };

export interface ResolvedProduct {
  pkg: NativePackage;
  product: SpmProduct;
  source: ProductSource;
}

const packageJson = z.object({
  name: z.string(),
  version: z.string(),
  codegenConfig: z.unknown().optional(),
});

export interface CollectOptions {
  nodeModules: string;
  /** Dirs with <npm-name>/spm.config.json overrides (scoped names as @scope/name), first wins:
   *  the app's own expo-wsl-ios/configs, then the ones shipped with expo-wsl-ios. */
  overridesDirs: string[];
  exclude: ReadonlySet<string>;
  projectRoot: string;
  /** Where remote (CocoaPods trunk) pods are fetched to. */
  cacheDir: string;
}

/** Every autolinked package, Expo modules and RN community deps merged by npm name. */
export async function collectPackages(
  expo: ExpoResolve,
  rn: RnConfig,
  opts: CollectOptions,
): Promise<NativePackage[]> {
  const pods = new Map<string, Set<string>>();
  const addPod = (pkg: string, pod: string): void => {
    const set = pods.get(pkg) ?? new Set<string>();
    set.add(pod);
    pods.set(pkg, set);
  };
  for (const m of expo.modules) for (const p of m.pods) addPod(m.packageName, p.podName);
  for (const [name, dep] of Object.entries(rn.dependencies)) {
    const ios = dep.platforms.ios;
    if (!ios) continue;
    const podFile = toPosixPath(ios.podspecPath).split('/').pop() ?? '';
    addPod(name, podFile.replace(/\.podspec$/, ''));
  }

  const out: NativePackage[] = [];
  for (const [name, podSet] of pods) {
    if (opts.exclude.has(name)) continue;
    const root = packageRoot(name, opts.nodeModules, rn, expo);
    const pj = packageJson.parse(await Bun.file(join(root, 'package.json')).json());
    const base = { name, version: pj.version, root, pods: [...podSet], codegen: pj.codegenConfig !== undefined };
    const override = opts.overridesDirs.map((d) => join(d, name, 'spm.config.json')).find((f) => existsSync(f)) ?? '';
    const own = join(root, 'spm.config.json');
    const external = join(opts.nodeModules, 'expo-modules-autolinking/external-configs/ios', name, 'spm.config.json');
    const none = { warnings: [], externalPods: {} };
    if (existsSync(override)) {
      out.push({ ...base, ...none, tier: 'override', config: await readConfig(override) });
    } else if (existsSync(own)) {
      out.push({ ...base, ...none, tier: 'spm', config: await readConfig(own) });
    } else if (existsSync(external)) {
      out.push({ ...base, ...none, tier: 'spm-external', config: await readConfig(external) });
    } else {
      const podspecs = await findPodspecs(root, rn.dependencies[name]?.platforms.ios?.podspecPath, expo, name);
      const products: SpmProduct[] = [];
      const warnings: string[] = [];
      const externalPods: Record<string, string[]> = {};
      let codegen = base.codegen;
      for (const podspec of podspecs) {
        const r = await convertPodspec(podspec, { packageRoot: root, packageName: name, projectRoot: opts.projectRoot });
        products.push(...r.config.products);
        warnings.push(...r.warnings);
        mergeReqs(externalPods, r.externalPods);
        codegen ||= r.codegen;
      }
      out.push({ ...base, codegen, tier: 'podspec', config: { products }, warnings, externalPods });
    }
  }
  await addRemotePods(out, opts);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function mergeReqs(into: Record<string, string[]>, from: Record<string, string[]>): void {
  for (const [pod, reqs] of Object.entries(from)) into[pod] = [...new Set([...(into[pod] ?? []), ...reqs])];
}

/** Fetch every pod a converted podspec depends on that no autolinked package provides (transitively). */
async function addRemotePods(out: NativePackage[], opts: CollectOptions): Promise<void> {
  const provided = (): Set<string> => new Set(out.flatMap((p) => [...p.pods, ...p.config.products.map((x) => x.podName ?? x.name)]));
  for (;;) {
    const want: Record<string, string[]> = {};
    const have = provided();
    for (const p of out) for (const [pod, reqs] of Object.entries(p.externalPods)) if (!have.has(pod)) mergeReqs(want, { [pod]: reqs });
    const next = Object.entries(want);
    if (next.length === 0) return;
    for (const [pod, reqs] of next) {
      const fetched = await fetchPod(pod, reqs, opts.cacheDir);
      const r = await convertPodspec(fetched.podspec, { packageRoot: fetched.root, packageName: pod, projectRoot: opts.projectRoot });
      out.push({
        name: `pod:${pod}`, version: fetched.version, root: fetched.root, pods: [pod], tier: 'remote-pod',
        config: r.config, codegen: false, externalPods: r.externalPods,
        warnings: [`fetched ${pod} ${fetched.version} from CocoaPods trunk (${reqs.join(', ') || 'any version'})`, ...r.warnings],
      });
    }
  }
}

/** node_modules/<name>, else where autolinking found it (hoisted or linked workspaces). */
function packageRoot(name: string, nodeModules: string, rn: RnConfig, expo: ExpoResolve): string {
  const direct = join(nodeModules, name);
  if (existsSync(join(direct, 'package.json'))) return direct;
  const rnRoot = rn.dependencies[name]?.root;
  if (rnRoot) return toPosixPath(rnRoot);
  const podDir = expo.modules.find((m) => m.packageName === name)?.pods[0]?.podspecDir;
  if (podDir) {
    let dir = toPosixPath(podDir);
    while (dir.length > 1 && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return direct;
}

async function readConfig(file: string): Promise<SpmConfig> {
  return spmConfig.parse(await Bun.file(file).json());
}

async function findPodspecs(
  root: string,
  rnPodspec: string | undefined,
  expo: ExpoResolve,
  name: string,
): Promise<string[]> {
  if (rnPodspec) return [toPosixPath(rnPodspec)];
  const mod = expo.modules.find((m) => m.packageName === name);
  const found: string[] = [];
  for (const pod of mod?.pods ?? []) {
    const file = join(toPosixPath(pod.podspecDir), `${pod.podName}.podspec`);
    if (existsSync(file)) found.push(file);
  }
  if (found.length === 0) throw new Error(`${name}: no podspec found under ${root}`);
  return found;
}

/**
 * Pick the products the app links (a product whose pod isn't autolinked is skipped, except
 * sourceOnly companions whose autolinkWhen pod is present) and where each comes from.
 */
export function resolveProducts(packages: NativePackage[], flavor: Flavor, frameworksDir: string): ResolvedProduct[] {
  const allPods = new Set(packages.flatMap((p) => p.pods));
  const out: ResolvedProduct[] = [];
  for (const pkg of packages) {
    for (const product of pkg.config.products) {
      const pod = product.podName ?? product.name;
      const when = autolinkWhenPod(product.autolinkWhen);
      const linked = pkg.pods.includes(pod) || (product.sourceOnly === true && when !== undefined && allPods.has(when));
      if (!linked) continue;
      const tarball = join(pkg.root, 'prebuilds/output', flavor, 'xcframeworks', `${product.name}.tar.gz`);
      const staged = join(frameworksDir, `${product.name}.xcframework`);
      if (product.customBuild || existsSync(tarball)) {
        if (!existsSync(staged)) throw new Error(`${product.name}: expected a staged xcframework at ${staged}`);
        out.push({ pkg, product, source: { kind: 'binary', xcframework: staged } });
      } else {
        out.push({ pkg, product, source: { kind: 'source' } });
      }
    }
  }
  return out;
}

const autolinkWhen = z.object({ podName: z.string() });
function autolinkWhenPod(v: unknown): string | undefined {
  const r = autolinkWhen.safeParse(v);
  return r.success ? r.data.podName : undefined;
}
