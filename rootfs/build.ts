// Build the prebuilt rootfs that `expo-wsl-ios setup` imports: fresh Arch WSL distro -> bootstrap ->
// toolchain (everything but Apple's SDK, which can't be redistributed) -> clean -> tar.gz + sha256.
// Resumable: rerun after a failure and finished steps are cheap no-ops.
//   bun rootfs/build.ts [--tag 1] [--keep]     (maintainers only; runs on 6 vCPUs by default)
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { cpuCap, toPosixPath } from '../src/cli/env.ts';
import { run, runInherit, step } from '../src/cli/proc.ts';

const { values } = parseArgs({ options: { tag: { type: 'string', default: '1' }, keep: { type: 'boolean' } } });
const ROOT = resolve(import.meta.dir, '..');
const NAME = 'expo-wsl-ios-build';
const USER = 'expo';
const location = resolve(ROOT, '.wsl', 'rootfs-build');
const out = resolve(ROOT, 'out', `expo-wsl-ios-rootfs-${values.tag}.tar.gz`);
const env = { WSL_UTF8: '1' };
const script = (name: string): string => toPosixPath(resolve(ROOT, 'rootfs', name));

/** Run inside the build distro, capped like every other WSL step. */
const inDistro = (user: string, cmd: string[]): Promise<void> =>
  runInherit('wsl.exe', ['-d', NAME, '-u', user, '--exec', 'taskset', '-c', `0-${cpuCap() - 1}`, 'nice', '-n', '10', ...cmd], { env });
const terminate = (): Promise<string> => run('wsl.exe', ['--terminate', NAME], { env, quiet: true });

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

const t0 = performance.now();
const distros = (await run('wsl.exe', ['--list', '--quiet'], { env })).split(/\r?\n/).map((s) => s.trim());
if (!distros.includes(NAME)) {
  step(`install Arch as ${NAME} in ${location}`);
  mkdirSync(location, { recursive: true });
  await runInherit('wsl.exe', ['--install', 'archlinux', '--name', NAME, '--location', location, '--no-launch'], { env });
}

step('bootstrap (root)');
await inDistro('root', ['bash', script('bootstrap.sh'), USER]);
await terminate(); // wsl.conf (default user, systemd) applies from the next start

step(`toolchain (${USER}; xtool builds from source, about 15 minutes on ${cpuCap()} vCPUs)`);
await inDistro(USER, ['bash', '-lc', `ulimit -n 65536; bash ${script('toolchain.sh')}`]);

step('clean');
await inDistro('root', ['bash', script('clean.sh'), USER]);
await terminate();

step(`export ${basename(out)}`);
mkdirSync(resolve(ROOT, 'out'), { recursive: true });
await runInherit('wsl.exe', ['--export', NAME, out, '--format', 'tar.gz'], { env });
const sum = await sha256(out);
writeFileSync(`${out}.sha256`, `${sum}  ${basename(out)}\n`);
const size = statSync(out).size;
console.log(`\n${out}\n  ${(size / 1024 ** 3).toFixed(2)} GiB, sha256 ${sum}`);
// GitHub release assets max out at 2 GiB: upload <name>.part1..N instead; `setup` reassembles them
// and checks the whole file against <name>.sha256.
const PART = 1900 * 1024 ** 2;
if (size >= 2 * 1024 ** 3) {
  for (let i = 0; i * PART < size; i++) {
    const part = `${out}.part${i + 1}`;
    await pipeline(createReadStream(out, { start: i * PART, end: Math.min(size, (i + 1) * PART) - 1 }), createWriteStream(part));
    console.log(`  ${basename(part)}  ${(statSync(part).size / 1024 ** 3).toFixed(2)} GiB`);
  }
  console.log('  release assets: the .partN files + the .sha256 (not the whole .tar.gz)');
}
if (!values.keep) {
  step(`unregister ${NAME}`);
  await run('wsl.exe', ['--unregister', NAME], { env, quiet: true });
}
console.log(`done in ${((performance.now() - t0) / 60000).toFixed(1)} min`);
