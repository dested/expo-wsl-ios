// `expo-wsl-ios setup`: the one-time machine setup. Every step is idempotent and skipped when done.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { DISTRO, ROOTFS_URL, distroExists, pymobiledevice3, usbmuxdUp, wslHas, toPosixPath, wslBash, wslInherit } from './env.ts';
import { CommandError, run, runInherit, step, succeeds, which } from './proc.ts';

export interface SetupOptions {
  rootfs: string | undefined;
  location: string | undefined;
  xip: string | undefined;
  ascKey: string | undefined;
  keyId: string | undefined;
  issuerId: string | undefined;
}

/** Downloads and the distro's VHDX. EXPO_WSL_IOS_HOME moves both (e.g. to a bigger drive). */
const stateDir = (): string => process.env['EXPO_WSL_IOS_HOME']
  ?? join(process.env['LOCALAPPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData/Local'), 'expo-wsl-ios');

/** The response, or undefined on 404. */
async function fetchOk(url: string): Promise<Response | undefined> {
  const res = await fetch(url);
  if (res.status === 404) return undefined;
  if (!res.ok || !res.body) throw new Error(`download ${url}: ${res.status}`);
  return res;
}

async function streamTo(res: Response, out: WriteStream, label: string): Promise<void> {
  if (!res.body) throw new Error(`download ${res.url}: empty body`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body.getReader();
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await once(out, 'drain');
    if (total && got - last > total / 50) {
      last = got;
      process.stdout.write(`\r   ${label}${(got / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`);
    }
  }
  process.stdout.write('\n');
}

/** One file, or `<url>.part1..N` when it is over GitHub's 2 GiB release-asset limit; either way one local file. */
async function download(url: string, dest: string): Promise<void> {
  const out = createWriteStream(`${dest}.part`);
  const whole = await fetchOk(url);
  if (whole) await streamTo(whole, out, '');
  else {
    for (let i = 1; ; i++) {
      const part = await fetchOk(`${url}.part${i}`);
      if (!part) {
        if (i === 1) throw new Error(`download ${url}: not found (nor ${url}.part1)`);
        break;
      }
      await streamTo(part, out, `part ${i}: `);
    }
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  renameSync(`${dest}.part`, dest);
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function ensureDistro(o: SetupOptions): Promise<void> {
  if (await distroExists()) {
    console.log(`   WSL distro "${DISTRO}" already exists`);
    return;
  }
  let tar = o.rootfs;
  if (!tar || /^https?:/.test(tar)) {
    const url = tar ?? ROOTFS_URL;
    mkdirSync(stateDir(), { recursive: true });
    tar = join(stateDir(), basename(new URL(url).pathname));
    if (!existsSync(tar)) {
      console.log(`   downloading ${url}`);
      await download(url, tar);
      const sumRes = await fetch(`${url}.sha256`);
      if (sumRes.ok) {
        const want = (await sumRes.text()).trim().split(/\s+/)[0] ?? '';
        const got = await sha256(tar);
        if (want && want !== got) throw new Error(`rootfs checksum mismatch (${got} != ${want}); delete ${tar} and retry`);
        console.log('   checksum ok');
      }
    }
  }
  if (!existsSync(tar)) throw new Error(`rootfs not found: ${tar}`);
  const location = o.location ?? join(stateDir(), 'distro');
  mkdirSync(location, { recursive: true });
  console.log(`   importing ${(statSync(tar).size / 1e9).toFixed(1)} GB into ${location}`);
  await runInherit('wsl.exe', ['--import', DISTRO, location, tar, '--version', '2']);
}

async function ensureSdk(o: SetupOptions): Promise<void> {
  if (await wslHas('d', '.swiftpm/swift-sdks/darwin.artifactbundle')) {
    console.log('   iOS SDK already installed');
    return;
  }
  if (!o.xip) {
    throw new Error('the iOS SDK comes from Xcode.xip: download Xcode 27 from https://developer.apple.com/download/all/ and pass --xip <path>');
  }
  if (!existsSync(o.xip)) throw new Error(`no such file: ${o.xip}`);
  console.log('   extracting the SDK from Xcode.xip (several minutes, about 20 GB of temporary space)');
  // --repair is omarchy's SDK-only path: no pacman/yay, so a newer AUR swift-bin can't sneak in
  // and stop matching the SDK. Stale temp dirs from an interrupted attempt are cleared first.
  const sdkStep = (): Promise<void> => wslInherit(['env', `XCODE_XIP=${toPosixPath(o.xip ?? '')}`, 'bash', '-c',
    'export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$PATH"; ulimit -n 65536; rm -rf ~/.cache/xtool/.build.* ~/.cache/xtool/pid-*; cd ~/omarchy-apple-dev && ./install-toolchain.sh --repair']);
  try {
    await sdkStep();
  } catch (e) {
    // `xtool sdk build` has segfaulted once at startup (exit 139) and then passed on the very next try.
    if (!(e instanceof CommandError) || e.code !== 139) throw e;
    console.log('   xtool crashed at startup (a known flake); retrying once');
    await sdkStep();
  }
}

async function ensureAscKey(o: SetupOptions): Promise<void> {
  const have = await wslHas('f', '.config/expo-wsl-ios/asc.env');
  if (!o.ascKey) {
    if (have) console.log('   App Store Connect key already configured');
    else throw new Error('signing needs an App Store Connect API key: pass --asc-key <AuthKey_XXXX.p8> --issuer-id <uuid> (App Store Connect > Users and Access > Integrations)');
    return;
  }
  if (!existsSync(o.ascKey)) throw new Error(`no such file: ${o.ascKey}`);
  const keyId = o.keyId ?? /AuthKey_([A-Z0-9]+)\.p8$/i.exec(o.ascKey)?.[1];
  if (!keyId) throw new Error('pass --key-id (it is also the XXXX in AuthKey_XXXX.p8)');
  if (!o.issuerId) throw new Error('pass --issuer-id (App Store Connect > Users and Access > Integrations, above the key list)');
  if (!/^[A-Z0-9]{8,12}$/i.test(keyId) || !/^[0-9a-f-]{36}$/i.test(o.issuerId)) throw new Error('key id or issuer id looks wrong');
  await wslBash([
    'set -e',
    'd=~/.config/expo-wsl-ios; mkdir -p "$d"; chmod 700 "$d"',
    `install -m600 '${toPosixPath(o.ascKey)}' "$d/AuthKey_${keyId}.p8"`,
    `printf 'ASC_KEY_ID=%s\\nASC_ISSUER_ID=%s\\n' '${keyId}' '${o.issuerId}' > "$d/asc.env"; chmod 600 "$d/asc.env"`,
  ].join('; '));
  console.log(`   key ${keyId} stored in the distro (~/.config/expo-wsl-ios)`);
}

async function ensureDeviceTools(): Promise<void> {
  if (!(await usbmuxdUp())) {
    console.log('   ! Apple device driver not running: install "Apple Devices" from the Microsoft Store, open it once, rerun setup');
  } else {
    console.log('   Apple device driver (usbmuxd) running');
  }
  if (pymobiledevice3()) {
    console.log('   pymobiledevice3 present');
    return;
  }
  const uv = which('uv');
  if (!uv) {
    console.log('   ! pymobiledevice3 missing: install uv (`winget install astral-sh.uv`), then rerun setup');
    return;
  }
  await runInherit(uv, ['tool', 'install', 'pymobiledevice3']);
}

export async function setup(o: SetupOptions): Promise<void> {
  step('WSL');
  if (!(await succeeds('wsl.exe', ['--version']))) {
    throw new Error('WSL 2 is not installed: run `wsl --install --no-distribution` in an admin terminal, reboot, rerun setup');
  }
  step(`distro "${DISTRO}"`);
  await ensureDistro(o);
  step('iOS SDK');
  await ensureSdk(o);
  step('signing key');
  await ensureAscKey(o);
  step('device tooling (Windows)');
  await ensureDeviceTools();
  console.log(`
Setup done. On the iPhone: Settings > Privacy & Security > Developer Mode (it shows up after the
first install attempt). Then, in your Expo project: npx expo-wsl-ios run`);
  await run('wsl.exe', ['--terminate', DISTRO], { quiet: true }).catch(() => undefined);
}
