// `expo-wsl-ios run`: prep on Windows, build + sign in WSL, install over USB.
import { join } from 'node:path';
import { PKG_ROOT, pymobiledevice3, toPosixPath, usbDevices, wslInherit, type Device } from './env.ts';
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

export async function runCommand(o: RunCommandOptions): Promise<void> {
  const t0 = performance.now();
  const pmd = pymobiledevice3();
  if (!pmd) throw new Error('pymobiledevice3 not found: `uv tool install pymobiledevice3` (or set EXPO_WSL_IOS_PMD)');
  // Signing registers the device in the provisioning profile, so pick it before building.
  const device = await pickDevice(pmd, o.udid);
  console.log(`   device: ${device.DeviceName ?? '?'} (${device.UniqueDeviceID})`);

  const p = await prep({ app: o.app, exclude: o.exclude, host: o.host, port: o.port, bundleId: o.bundleId });
  const ipa = join(o.app, '.expo', 'wsl-ios', `${p.productName}.ipa`);

  step('generate + build + sign in WSL');
  await wslInherit(['bash', toPosixPath(join(PKG_ROOT, 'scripts/wsl-build.sh')),
    toPosixPath(o.app), toPosixPath(p.dir), p.productName, p.bundleId, device.UniqueDeviceID, o.exclude.join(','), toPosixPath(ipa)]);

  if (o.install) {
    step('install');
    await run(pmd, ['apps', 'install', ipa], { quiet: true });
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`\n${o.install ? 'Installed' : 'Built'} ${p.name} in ${secs} s${o.install ? '. Tap it on the phone to launch.' : `: ${ipa}`}`);
  console.log(`Live reload: run \`npx expo start --port ${p.metro.split(':')[1] ?? '8081'}\` here, and allow Local Network access when iOS asks.`);
  console.log('Without Metro the app runs the JS bundle embedded at build time.');
}
