// Pods that npm packages depend on but npm doesn't ship (expo-iap -> openiap): resolved on the
// CocoaPods trunk CDN, fetched from their declared source, and converted like any other podspec.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

const CDN = 'https://cdn.cocoapods.org';

const podSource = z.object({
  git: z.string().optional(),
  tag: z.string().optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  http: z.string().optional(),
});
const podspecJson = z.object({ name: z.string(), version: z.string(), source: podSource }).passthrough();

export interface FetchedPod {
  name: string;
  version: string;
  /** Source checkout; the .podspec.json sits at its root so file patterns resolve. */
  root: string;
  podspec: string;
}

function shard(name: string): string[] {
  const h = createHash('md5').update(name).digest('hex');
  return [h[0] ?? '0', h[1] ?? '0', h[2] ?? '0'];
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res;
}

type Version = number[];
const parse = (v: string): Version => v.split(/[.-]/).map((x) => Number.parseInt(x, 10)).map((n) => (Number.isNaN(n) ? 0 : n));
function cmp(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** CocoaPods requirement semantics: `1.2`, `= 1.2`, `~> 1.2` (>= 1.2, < 2.0), `>=`, `>`, `<=`, `<`, `!=`. */
export function satisfies(version: string, req: string): boolean {
  const m = /^\s*(~>|>=|<=|!=|=|>|<)?\s*(\S+)\s*$/.exec(req);
  if (!m?.[2]) return true;
  const op = m[1] ?? '=';
  const v = parse(version);
  const r = parse(m[2]);
  const c = cmp(v, r);
  switch (op) {
    case '=': return c === 0;
    case '!=': return c !== 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    default: {
      // ~> 1.2.3 means >= 1.2.3 and < 1.3; ~> 1.2 means >= 1.2 and < 2.
      const upper = r.length > 1 ? [...r.slice(0, -2), (r[r.length - 2] ?? 0) + 1] : [(r[0] ?? 0) + 1];
      return c >= 0 && cmp(v, upper) < 0;
    }
  }
}

async function resolveVersion(name: string, reqs: string[]): Promise<string> {
  const [a, b, c] = shard(name);
  const index = await (await get(`${CDN}/all_pods_versions_${a}_${b}_${c}.txt`)).text();
  const line = index.split('\n').find((l) => l.split('/')[0] === name);
  if (!line) throw new Error(`pod ${name} is not on CocoaPods trunk`);
  const candidates = line.split('/').slice(1).filter((v) => !/[a-z]/i.test(v) || reqs.some((r) => r.includes(v)));
  const ok = candidates.filter((v) => reqs.every((r) => satisfies(v, r))).sort((x, y) => cmp(parse(y), parse(x)));
  const best = ok[0];
  if (!best) throw new Error(`pod ${name}: no version satisfies ${reqs.join(', ')}`);
  return best;
}

async function run(cmd: string[], cwd?: string): Promise<void> {
  const p = Bun.spawn(cmd, { ...(cwd === undefined ? {} : { cwd }), stdout: 'pipe', stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(' ')}: ${err.slice(-1000)}`);
}

/** Resolve, download and cache one remote pod at <cacheDir>/<name>-<version>/. */
export async function fetchPod(name: string, reqs: string[], cacheDir: string): Promise<FetchedPod> {
  const version = await resolveVersion(name, reqs);
  const root = join(cacheDir, `${name}-${version}`);
  const podspec = join(root, `${name}.podspec.json`);
  if (existsSync(podspec)) return { name, version, root, podspec };

  const [a, b, c] = shard(name);
  const raw = await (await get(`${CDN}/Specs/${a}/${b}/${c}/${name}/${version}/${name}.podspec.json`)).text();
  const spec = podspecJson.parse(JSON.parse(raw));
  const tmp = `${root}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const src = spec.source;
  if (src.git) {
    const ref = src.tag ?? src.branch;
    if (ref) await run(['git', 'clone', '--quiet', '--depth', '1', '--branch', ref, src.git, tmp]);
    else {
      await run(['git', 'clone', '--quiet', src.git, tmp]);
      if (src.commit) await run(['git', 'checkout', '--quiet', src.commit], tmp);
    }
    rmSync(join(tmp, '.git'), { recursive: true, force: true });
  } else if (src.http) {
    mkdirSync(tmp, { recursive: true });
    const archive = join(tmp, '.download');
    writeFileSync(archive, new Uint8Array(await (await get(src.http)).arrayBuffer()));
    await run(/\.zip($|\?)/.test(src.http) ? ['unzip', '-q', archive, '-d', tmp] : ['tar', '-xf', archive, '-C', tmp]);
    rmSync(archive);
  } else {
    throw new Error(`pod ${name} ${version}: unsupported source ${JSON.stringify(src)}`);
  }
  writeFileSync(join(tmp, `${name}.podspec.json`), raw);
  renameSync(tmp, root);
  return { name, version, root, podspec };
}
