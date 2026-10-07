// `expo-wsl-ios doctor`: every prerequisite, and the fix for each one that fails.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DISTRO, cpuCap, distroExists, packageDir, pymobiledevice3, usbDevices, usbmuxdUp, wslBash, wslHas } from './env.ts';
import { succeeds } from './proc.ts';

interface Check {
  name: string;
  ok: boolean;
  fix?: string;
}

const version = z.object({ version: z.string() });

export async function doctor(app: string): Promise<boolean> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, fix?: string): void => {
    checks.push(fix === undefined ? { name, ok } : { name, ok, fix });
  };

  const hasWsl = await succeeds('wsl.exe', ['--version']);
  add('WSL 2', hasWsl, 'wsl --install --no-distribution (admin), then reboot');
  const hasDistro = hasWsl && (await distroExists());
  add(`WSL distro "${DISTRO}"`, hasDistro, 'npx expo-wsl-ios setup');
  if (hasDistro) {
    const tools = await wslBash('for t in swift xtool bun ruby rsync rcodesign taskset; do command -v $t >/dev/null || echo "$t"; done').catch(() => 'unreachable');
    add('toolchain in the distro (swift, xtool, bun, ruby, rsync, rcodesign)', tools.trim() === '', `missing: ${tools.trim()}; re-import the distro (wsl --unregister ${DISTRO}, then setup)`);
    add('iOS SDK (from Xcode.xip)', await wslHas('d', '.swiftpm/swift-sdks/darwin.artifactbundle'),
      'npx expo-wsl-ios setup --xip <Xcode_27.xip>');
    add('App Store Connect API key', await wslHas('f', '.config/expo-wsl-ios/asc.env'),
      'npx expo-wsl-ios setup --asc-key <AuthKey_XXXX.p8> --issuer-id <uuid>');
  }
  add('Apple device driver (usbmuxd)', await usbmuxdUp(), 'install "Apple Devices" from the Microsoft Store and open it once');
  const pmd = pymobiledevice3();
  add('pymobiledevice3', pmd !== undefined, 'uv tool install pymobiledevice3');
  if (pmd) {
    const devices = await usbDevices(pmd).catch(() => []);
    add(`iPhone on USB${devices[0] ? `: ${devices[0].DeviceName ?? devices[0].UniqueDeviceID}` : ''}`, devices.length > 0, 'plug it in, unlock it, tap Trust');
  }

  if (existsSync(join(app, 'package.json'))) {
    try {
      const expo = version.parse(JSON.parse(readFileSync(join(packageDir('expo', app), 'package.json'), 'utf8'))).version;
      const major = Number(expo.split('.')[0]);
      add(`Expo SDK ${major}`, major >= 57, 'expo-wsl-ios needs Expo SDK 57+ (the SwiftPM configs it builds from)');
    } catch {
      add('Expo project', false, 'run doctor inside an Expo project with node_modules installed');
    }
  }

  for (const c of checks) console.log(`${c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.name}${c.ok || !c.fix ? '' : `\n    fix: ${c.fix}`}`);
  console.log(`\nWSL builds run on ${cpuCap()} vCPUs at low priority (EXPO_WSL_IOS_CPUS to change).`);
  return checks.every((c) => c.ok);
}
