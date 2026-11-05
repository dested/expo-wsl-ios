// `expo-wsl-ios run`: prep on Windows, build + sign in WSL, install over USB or Wi-Fi.
import { createInterface } from 'node:readline/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_ROOT, pymobiledevice3, toPosixPath, usbDevices, wifiDevices, wslInherit, type Device } from './env.ts';
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

function localWifiPairings(): string[] {
  const folder = join(process.env['USERPROFILE'] ?? '', '.pymobiledevice3');
  try {
    return readdirSync(folder)
      .map((name) => /^remote_(.+?)(?:\.plist)?$/.exec(name)?.[1])
      .filter((id): id is string => id !== undefined);
  } catch {
    return [];
  }
}

async function scanWifiDevice(pmd: string): Promise<Device> {
  console.log('Scanning for paired iPhones over Wi-Fi...');
  const remoteDevices = await remoteWifiDevices(pmd);
  if (remoteDevices.length) return chooseWifiDevice(remoteDevices);

  const networkDevices = await wifiDevices(pmd).catch(() => []);
  if (networkDevices.length) return chooseWifiDevice(networkDevices);

  const pairedDevices = localWifiPairings().map((UniqueDeviceID) => ({ UniqueDeviceID }));
  if (pairedDevices.length) return chooseWifiDevice(pairedDevices);

  // A normal USB Trust does not create the RemotePairing record required for
  // Bonjour Wi-Fi discovery. If the phone is still attached, bootstrap that
  // record now instead of making the user discover the extra command.
  const usb = await usbDevices(pmd).catch(() => []);
  if (usb.length) {
    const device = await chooseWifiDevice(usb);
    console.log('Creating the Wi-Fi pairing record over USB...');
    await run(pmd, ['lockdown', 'remotepairing', '--udid', device.UniqueDeviceID, '--pair'], { quiet: true });
    return device;
  }

  const tunneld = start(pmd, ['remote', 'tunneld', '--wifi', '--no-usb', '--no-usbmux', '--no-mobdev2']);
  try {
    const devices = await waitForTunneld();
    // The live tunneld listing can remain empty when Bonjour discovery is
    // blocked by Windows firewall/profile settings. Pairing records still
    // provide the real UDIDs, so use them as a selection fallback and let the
    // install step perform the final reachability check.
    const udids = Object.keys(devices).length ? Object.keys(devices) : localWifiPairings();
    if (!udids.length) {
      throw new Error('no paired iPhone found over Wi-Fi; connect it by USB once to bootstrap RemotePairing, then keep the phone and PC on the same LAN');
    }
    return await chooseWifiDevice(udids.map((UniqueDeviceID) => ({ UniqueDeviceID })));
  } finally {
    if (!tunneld.killed) tunneld.kill();
  }
}

async function remoteWifiDevices(pmd: string): Promise<Device[]> {
  try {
    const result: unknown = JSON.parse(await run(pmd, ['remote', 'browse', '--no-native', '--timeout', '5'], { quiet: true }));
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const wifi = (result as { wifi?: unknown }).wifi;
    if (!Array.isArray(wifi)) return [];
    return wifi.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const id = (entry as { identifier?: unknown }).identifier;
      return typeof id === 'string' ? [{ UniqueDeviceID: id }] : [];
    });
  } catch {
    return [];
  }
}

async function chooseWifiDevice(devices: Device[]): Promise<Device> {
    console.log('Wi-Fi iPhones found:');
    devices.forEach((device, index) => console.log(`  ${index + 1}. ${device.DeviceName ?? 'iPhone'} (${device.UniqueDeviceID})`));
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await readline.question(`Select a device [1-${devices.length}]: `);
      const index = Number(answer) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= devices.length) {
        throw new Error(`invalid device selection: ${answer}`);
      }
      return devices[index]!;
    } finally {
      readline.close();
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
