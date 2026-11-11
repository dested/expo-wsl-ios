// `expo-wsl-ios run`: prep on Windows, build + sign in WSL, install over USB or Wi-Fi.
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_ROOT, pymobiledevice3, toPosixPath, usbDevices, wifiDevices, wslInherit, type Device } from './env.ts';
import { prep } from './prep.ts';
import { run, step } from './proc.ts';

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

interface WifiTunnel {
  check(): void;
  close(): void;
}

async function tunnelDevices(): Promise<Record<string, unknown[]> | undefined> {
  try {
    const response = await fetch('http://127.0.0.1:49151', { signal: AbortSignal.timeout(500) });
    if (!response.ok) return undefined;
    const listing: unknown = await response.json();
    if (listing && typeof listing === 'object' && !Array.isArray(listing)) {
      return Object.fromEntries(Object.entries(listing).filter(([, entries]) => Array.isArray(entries) && entries.length > 0));
    }
  } catch {
    // The daemon may still be starting.
  }
  return undefined;
}

async function openWifiTunnel(pmd: string): Promise<WifiTunnel> {
  // Reuse a user's running daemon without terminating it at the end.
  if (await tunnelDevices() !== undefined) return { check() {}, close() {} };
  const child = spawn(pmd, ['remote', 'tunneld', '--wifi', '--no-usb', '--no-usbmux', '--no-mobdev2'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let failure: Error | undefined;
  const capture = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-6000); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', (error) => { failure = error; });
  child.on('exit', (code, signal) => {
    failure ??= new Error(`tunneld exited ${code ?? signal}`);
  });
  return {
    check() {
      if (failure) throw new Error(`Wi-Fi tunnel failed: ${failure.message}\n${output.trim()}\nIf access was denied, run the command in an elevated Windows terminal.`);
    },
    close() {
      if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
    },
  };
}

async function waitForTunneld(tunnel: WifiTunnel, udid?: string, timeoutMs = 30_000): Promise<Record<string, unknown[]>> {
  const deadline = Date.now() + timeoutMs;
  let devices: Record<string, unknown[]> = {};
  while (Date.now() < deadline) {
    tunnel.check();
    devices = await tunnelDevices() ?? {};
    if (udid ? devices[udid]?.length : Object.keys(devices).length) return devices;
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

async function scanWifiDevice(pmd: string, tunnel?: WifiTunnel): Promise<Device> {
  console.log('Scanning for paired iPhones over Wi-Fi...');
  // `remote browse` supplies the authenticated RemotePairing identifiers,
  // while usbmux listings are the reliable source of the human-readable name.
  // Merge them so Wi-Fi discovery does not fall back to showing only a UDID.
  const networkDevices = await wifiDevices(pmd).catch(() => []);
  const usb = await usbDevices(pmd).catch(() => []);
  const names = new Map([...networkDevices, ...usb].map((device) => [device.UniqueDeviceID, device.DeviceName]));
  const addNames = (devices: Device[]): Device[] => devices.map((device) => ({
    ...device,
    DeviceName: device.DeviceName ?? names.get(device.UniqueDeviceID),
  }));

  const remoteDevices = addNames(await remoteWifiDevices(pmd));
  if (remoteDevices.length) return chooseWifiDevice(remoteDevices);

  if (networkDevices.length) return chooseWifiDevice(networkDevices);

  const pairedDevices = localWifiPairings().map((UniqueDeviceID) => ({
    UniqueDeviceID,
    DeviceName: names.get(UniqueDeviceID),
  }));
  if (pairedDevices.length) return chooseWifiDevice(pairedDevices);

  // A normal USB Trust does not create the RemotePairing record required for
  // Bonjour Wi-Fi discovery. If the phone is still attached, bootstrap that
  // record now instead of making the user discover the extra command.
  if (usb.length) {
    const device = await chooseWifiDevice(usb);
    console.log('Creating the Wi-Fi pairing record over USB...');
    await run(pmd, ['lockdown', 'remotepairing', '--udid', device.UniqueDeviceID, '--pair'], { quiet: true });
    return device;
  }

  const devices = tunnel ? await waitForTunneld(tunnel) : {};
  const udids = Object.keys(devices);
  if (!udids.length) {
    throw new Error('no paired iPhone found over Wi-Fi; connect it by USB once to bootstrap RemotePairing, then keep the phone and PC on the same LAN');
  }
  return chooseWifiDevice(addNames(udids.map((UniqueDeviceID) => ({ UniqueDeviceID }))));
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
  // The same phone can be reported by RemotePairing, usbmuxd, and multiple
  // Bonjour interfaces. Present one selectable entry per UDID.
  const uniqueDevices = [...new Map(devices.map((device) => [device.UniqueDeviceID, device])).values()];
  console.log('Wi-Fi iPhones found:');
  uniqueDevices.forEach((device, index) => console.log(`  ${index + 1}. ${device.DeviceName ?? 'iPhone'} (${device.UniqueDeviceID})`));
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`Select a device [1-${uniqueDevices.length}]: `);
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= uniqueDevices.length) {
      throw new Error(`invalid device selection: ${answer}`);
    }
    return uniqueDevices[index]!;
  } finally {
    readline.close();
  }
}

async function requireWifiDevice(tunnel: WifiTunnel, udid: string): Promise<void> {
  const devices = await waitForTunneld(tunnel, udid);
  if (!devices[udid]?.length) {
    throw new Error(`Wi-Fi tunnel did not discover ${udid}; unlock the phone and check RemotePairing and the LAN connection. To refresh pairing over USB, run: pymobiledevice3 lockdown remotepairing --udid ${udid} --pair`);
  }
}

export async function runCommand(o: RunCommandOptions): Promise<void> {
  const t0 = performance.now();
  const pmd = pymobiledevice3();
  if (!pmd) throw new Error('pymobiledevice3 not found: `uv tool install pymobiledevice3` (or set EXPO_WSL_IOS_PMD)');
  // Own one daemon for the whole run, including selection, build, and install.
  // Validate reachability before spending time on a native build.
  const tunnel = o.wifi && o.install ? await openWifiTunnel(pmd) : undefined;
  try {
    // Signing registers the device in the provisioning profile, so pick it before building.
    const device: Device = o.wifi
      ? o.udid ? { UniqueDeviceID: o.udid } : await scanWifiDevice(pmd, tunnel)
      : await pickDevice(pmd, o.udid);
    console.log(`   device: ${device.DeviceName ?? '?'} (${device.UniqueDeviceID})`);
    if (tunnel) await requireWifiDevice(tunnel, device.UniqueDeviceID);

    const p = await prep({ app: o.app, exclude: o.exclude, host: o.host, port: o.port, bundleId: o.bundleId });
    const ipa = join(o.app, '.expo', 'wsl-ios', `${p.productName}.ipa`);

    step('generate + build + sign in WSL');
    await wslInherit(['bash', toPosixPath(join(PKG_ROOT, 'scripts/wsl-build.sh')),
      toPosixPath(o.app), toPosixPath(p.dir), p.productName, p.bundleId, device.UniqueDeviceID, o.exclude.join(','), toPosixPath(ipa)]);

    if (o.install) {
      step('install');
      if (tunnel) {
        await requireWifiDevice(tunnel, device.UniqueDeviceID);
        await run(pmd, ['apps', 'install', '--tunnel', device.UniqueDeviceID, ipa], { quiet: true });
      } else await run(pmd, ['apps', 'install', ipa], { quiet: true });
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    console.log(`\n${o.install ? 'Installed' : 'Built'} ${p.name} in ${secs} s${o.install ? '. Tap it on the phone to launch.' : `: ${ipa}`}`);
    console.log(`Live reload: run \`npx expo start --port ${p.metro.split(':')[1] ?? '8081'}\` here, and allow Local Network access when iOS asks.`);
    console.log('Without Metro the app runs the JS bundle embedded at build time.');
  } finally {
    tunnel?.close();
  }
}
