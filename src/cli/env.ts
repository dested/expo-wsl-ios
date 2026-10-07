// Where things live: the npm package, the WSL distro, per-project state, device tooling.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { run, runInherit, succeeds, which } from './proc.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** Package root: this code is dist/cli.js when published, src/cli/env.ts in the repo. */
export const PKG_ROOT = basename(here) === 'dist' ? resolve(here, '..') : resolve(here, '../..');

export const DISTRO = process.env['EXPO_WSL_IOS_DISTRO'] ?? 'expo-wsl-ios';
export const ROOTFS_URL = process.env['EXPO_WSL_IOS_ROOTFS_URL']
  ?? 'https://github.com/dested/expo-wsl-ios/releases/download/rootfs-1/expo-wsl-ios-rootfs-1.tar.gz';

/** G:\code\x -> /mnt/g/code/x; POSIX paths pass through. */
export function toPosixPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replaceAll('\\', '/');
  const [, drive = '', rest = ''] = m;
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`;
}

/** WSL work runs on a few vCPUs at low priority so the Windows desktop stays usable. */
export function cpuCap(): number {
  const n = Number(process.env['EXPO_WSL_IOS_CPUS'] ?? 6);
  return Number.isInteger(n) && n > 0 ? n : 6;
}

const wslEnv = { WSL_UTF8: '1' };

/** argv inside the distro, capped to cpuCap() vCPUs and niced. */
function capped(cmd: string[]): string[] {
  return ['-d', DISTRO, '--exec', 'taskset', '-c', `0-${cpuCap() - 1}`, 'nice', '-n', '10', ...cmd];
}

export function wsl(cmd: string[], quiet = true): Promise<string> {
  return run('wsl.exe', capped(cmd), { env: wslEnv, quiet });
}

export function wslInherit(cmd: string[]): Promise<void> {
  return runInherit('wsl.exe', capped(cmd), { env: wslEnv });
}

/** `bash -c` in the distro with the toolchain on PATH. */
export function wslBash(script: string, quiet = true): Promise<string> {
  return wsl(['bash', '-c', `export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"; ${script}`], quiet);
}

/** `test -<kind> $HOME/<rel>` in the distro (uncapped; trivially cheap). */
export function wslHas(kind: 'f' | 'd', homeRel: string): Promise<boolean> {
  return succeeds('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', `test -${kind} "$HOME/${homeRel}"`], { env: wslEnv });
}

export async function distroExists(): Promise<boolean> {
  try {
    const out = await run('wsl.exe', ['--list', '--quiet'], { env: wslEnv, quiet: true });
    return out.split(/\r?\n/).map((l) => l.trim()).includes(DISTRO);
  } catch {
    return false;
  }
}

/** pymobiledevice3 (Windows build, talks to Apple's usbmuxd). */
/** Apple's usbmuxd (from the "Apple Devices" Store app or iTunes) listens on 127.0.0.1:27015. */
export function usbmuxdUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: 27015, timeout: 1500 });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

export function pymobiledevice3(): string | undefined {
  const env = process.env['EXPO_WSL_IOS_PMD'];
  if (env && existsSync(env)) return env;
  // `uv tool install` puts it in ~/.local/bin, which is often not on PATH yet.
  const uvBin = join(process.env['USERPROFILE'] ?? '', '.local', 'bin', 'pymobiledevice3.exe');
  return which('pymobiledevice3') ?? (existsSync(uvBin) ? uvBin : undefined);
}

const usbmuxList = z.array(z.object({ UniqueDeviceID: z.string(), DeviceName: z.string().optional() }));
export type Device = z.infer<typeof usbmuxList>[number];

export async function usbDevices(pmd: string): Promise<Device[]> {
  return usbmuxList.parse(JSON.parse(await run(pmd, ['usbmux', 'list', '--usb'], { quiet: true })));
}

/** Resolve a package's directory the way Node would from `from` (handles hoisting). */
export function packageDir(name: string, from: string): string {
  return dirname(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`));
}

const binField = z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]).optional() });

/** A package's JS bin entry, run with this Node (no .cmd shims, no shell). */
export async function binPath(pkgDir: string, bin: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const pj = binField.parse(JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')));
  const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[bin];
  if (!rel) throw new Error(`${pkgDir}: no bin "${bin}"`);
  return join(pkgDir, rel);
}
