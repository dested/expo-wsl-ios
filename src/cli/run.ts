// `expo-wsl-ios run`: prep on Windows, build + sign in WSL, install over USB or Wi-Fi.
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { PKG_ROOT, pymobiledevice3, toPosixPath, usbDevices, wslInherit, type Device } from './env.ts';
import { prep } from './prep.ts';
import { run, start, step } from './proc.ts';

export interface RunCommandOptions {
  app: string;
  exclude: string[];
  host: string | undefined;
  port: number | undefined;
  bundleId: string | undefined;
  udid: string | undefined;
  install: boolean;
  wifi: boolean;
}

/** Pods left out by default: the dev-client UI (plain debug + Metro gives live reload),
 *  Expo's DOM-components webview and LogBox, which are dev tooling with extra native weight. */
export const DEFAULT_EXCLUDE = ['expo-dev-client', 'expo-dev-launcher', 'expo-dev-menu', 'expo-dev-menu-interface', '@expo/dom-webview', '@expo/log-box'];

async function pickDevice(pmd: string, udid: string | undefined): Promise<Device> {
  const devices = await usbDevices(pmd);
  if (udid) return devices.find((d) => d.UniqueDeviceID === udid) ?? { UniqueDeviceID: udid };
  const [first, ...rest] = devices;
  if (!first) throw new Error('no iPhone on USB: plug it in, unlock it, tap Trust (or pass --udid to build without one)');
  if (rest.length) throw new Error(`several devices connected; pass --udid (${devices.map((d) => `${d.DeviceName ?? '?'} ${d.UniqueDeviceID}`).join(', ')})`);
  return first;
}

async function waitForTunneld(timeoutMs = 30_000): Promise<Record<string, unknown[]>> {
  const deadline = Date.now() + timeoutMs;
  let devices: Record<string, unknown[]> = {};
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:49151', { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const listing: unknown = await response.json();
        if (listing && typeof listing === 'object' && !Array.isArray(listing)) {
          devices = listing as Record<string, unknown[]>;
          if (Object.keys(devices).length) return devices;
        }
      }
    } catch {
      // tunneld is still starting, or its local HTTP listener is not ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return devices;
}

async function scanWifiDevice(pmd: string): Promise<Device> {
  console.log('Scanning for paired iPhones over Wi-Fi...');
  const tunneld = start(pmd, ['remote', 'tunneld', '--wifi', '--no-usb', '--no-usbmux', '--no-mobdev2']);
  try {
    const devices = await waitForTunneld();
    const udids = Object.keys(devices);
    if (!udids.length) {
      throw new Error('no paired iPhone found over Wi-Fi; pair it over USB first and put the phone and PC on the same LAN');
    }
    console.log('Wi-Fi iPhones found:');
    udids.forEach((id, index) => console.log(`  ${index + 1}. ${id}`));
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await readline.question(`Select a device [1-${udids.length}]: `);
      const index = Number(answer) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= udids.length) {
        throw new Error(`invalid device selection: ${answer}`);
      }
      return { UniqueDeviceID: udids[index]! };
    } finally {
      readline.close();
    }
  } finally {
    if (!tunneld.killed) tunneld.kill();
  }
}

async function installOverWifi(pmd: string, ipa: string, udid: string): Promise<void> {
  // Windows usbmuxd does not reliably enumerate Wi-Fi devices. pymobiledevice3's
  // tunneld watches Bonjour RemotePairing adverts and exposes the device to the
  // normal apps command through its local tunnel API.
  const tunneld = start(pmd, ['remote', 'tunneld', '--wifi', '--no-usb', '--no-usbmux', '--no-mobdev2']);
  let installError: unknown;
  try {
    const devices = await waitForTunneld();
    if (!devices[udid]) throw new Error(`Wi-Fi tunnel did not discover ${udid}; check pairing, Wi-Fi, and that both devices are on the same LAN`);
    await run(pmd, ['--tunnel', udid, 'apps', 'install', ipa], { quiet: true });
  } catch (e) {
    installError = e;
  } finally {
    if (!tunneld.killed) tunneld.kill();
  }
  if (installError) throw installError;
}

export async function runCommand(o: RunCommandOptions): Promise<void> {
  const t0 = performance.now();
  const pmd = pymobiledevice3();
  if (!pmd) throw new Error('pymobiledevice3 not found: `uv tool install pymobiledevice3` (or set EXPO_WSL_IOS_PMD)');
  // Signing registers the device in the provisioning profile, so pick it before building.
  const device: Device = o.wifi
    ? o.udid ? { UniqueDeviceID: o.udid } : await scanWifiDevice(pmd)
    : await pickDevice(pmd, o.udid);
  console.log(`   device: ${device.DeviceName ?? '?'} (${device.UniqueDeviceID})`);

  const p = await prep({ app: o.app, exclude: o.exclude, host: o.host, port: o.port, bundleId: o.bundleId });
  const ipa = join(o.app, '.expo', 'wsl-ios', `${p.productName}.ipa`);

  step('generate + build + sign in WSL');
  await wslInherit(['bash', toPosixPath(join(PKG_ROOT, 'scripts/wsl-build.sh')),
    toPosixPath(o.app), toPosixPath(p.dir), p.productName, p.bundleId, device.UniqueDeviceID, o.exclude.join(','), toPosixPath(ipa)]);

  if (o.install) {
    step('install');
    if (o.wifi) await installOverWifi(pmd, ipa, device.UniqueDeviceID);
    else await run(pmd, ['apps', 'install', ipa], { quiet: true });
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`\n${o.install ? 'Installed' : 'Built'} ${p.name} in ${secs} s${o.install ? '. Tap it on the phone to launch.' : `: ${ipa}`}`);
  console.log(`Live reload: run \`npx expo start --port ${p.metro.split(':')[1] ?? '8081'}\` here, and allow Local Network access when iOS asks.`);
  console.log('Without Metro the app runs the JS bundle embedded at build time.');
}
