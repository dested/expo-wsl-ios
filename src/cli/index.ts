#!/usr/bin/env node
// expo-wsl-ios: build Expo apps for a real iPhone on Windows. Compiles natively in WSL; no Mac.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { doctor } from './doctor.ts';
import { DEFAULT_EXCLUDE, runCommand } from './run.ts';
import { prep } from './prep.ts';
import { setup } from './setup.ts';

const USAGE = `expo-wsl-ios <command> [options]

  setup    One-time machine setup: WSL distro, iOS SDK, signing key, device tooling
           --xip <Xcode.xip>  --asc-key <AuthKey_XXXX.p8>  --issuer-id <uuid>  [--key-id <id>]
           [--rootfs <tar or url>]  [--location <dir for the distro>]
  doctor   Check every prerequisite and print the fix for each failure
  run      Build, sign and install the Expo app in the current directory on the USB iPhone
           [--udid <id>] [--bundle-id <id>] [--exclude a,b] [--host <lan ip>] [--port <metro port>]
           [--no-install]
  prep     Only the Windows-side JS steps (codegen, config, bundle), for debugging

Environment: EXPO_WSL_IOS_CPUS (default 6), EXPO_WSL_IOS_DISTRO, EXPO_WSL_IOS_PMD`;

async function main(): Promise<number> {
  if (process.platform !== 'win32') {
    console.error('expo-wsl-ios runs on Windows (it drives WSL from the Windows side). On a Mac, use `npx expo run:ios`.');
    return 1;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      xip: { type: 'string' },
      'asc-key': { type: 'string' },
      'key-id': { type: 'string' },
      'issuer-id': { type: 'string' },
      rootfs: { type: 'string' },
      location: { type: 'string' },
      udid: { type: 'string' },
      'bundle-id': { type: 'string' },
      exclude: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'no-install': { type: 'boolean' },
      app: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd] = positionals;
  const app = resolve(values.app ?? positionals[1] ?? process.cwd());
  const exclude = [...DEFAULT_EXCLUDE, ...(values.exclude?.split(',').filter(Boolean) ?? [])];
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !Number.isInteger(port)) throw new Error('--port must be a number');

  switch (cmd) {
    case 'setup':
      await setup({ rootfs: values.rootfs, location: values.location, xip: values.xip, ascKey: values['asc-key'], keyId: values['key-id'], issuerId: values['issuer-id'] });
      return 0;
    case 'doctor':
      return (await doctor(app)) ? 0 : 1;
    case 'run':
      await runCommand({ app, exclude, host: values.host, port, bundleId: values['bundle-id'], udid: values.udid, install: values['no-install'] !== true });
      return 0;
    case 'prep': {
      const p = await prep({ app, exclude, host: values.host, port, bundleId: values['bundle-id'] });
      console.log(`prep output: ${p.dir}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd === undefined || values.help === true ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`\x1b[31merror:\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
