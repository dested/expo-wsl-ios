# expo-wsl-ios: guide for AI agents

You're helping someone build their Expo app for a real iPhone from Windows. Read this whole file before running anything.

## Ground rules

- Everything is driven from **Windows** (PowerShell or cmd), inside the user's Expo project. Never run `npx expo-wsl-ios` from inside WSL.
- **The user does some steps by hand.** You can't do these for them:
  - download `Xcode_27.xip` (Apple ID sign-in)
  - create the App Store Connect API key (Admin role) and download its `.p8`
  - install "Apple Devices" from the Microsoft Store
  - plug in the iPhone, unlock it, tap Trust
  - turn on Developer Mode
  - allow Local Network
  - tap the app icon to launch it
- **Never print, cat or paste the `.p8` key.** Pass its path to `setup`.
- **Builds are heavy.** They default to 6 vCPUs at low priority. Don't raise `EXPO_WSL_IOS_CPUS` unless the user asks. If the machine is struggling, run `wsl --shutdown`.

## Setup (once per machine)

1. `npm i -D expo-wsl-ios` in the project (Expo SDK 57+).
2. `npx expo-wsl-ios doctor` shows what's missing.
3. `npx expo-wsl-ios setup --xip <path to Xcode_27.xip> --asc-key <path to AuthKey_XXXX.p8> --issuer-id <issuer uuid>`
   - The issuer id is at the top of App Store Connect → Users and Access → Integrations → Team Keys.
   - Setup is idempotent. Rerun it after fixing whatever failed.
4. `npx expo-wsl-ios doctor` again. Everything should be ✓ except possibly "iPhone on USB".

## Build loop

```
npx expo-wsl-ios run            # prep (Windows) -> build + sign (WSL) -> install (USB)
```

- Takes the bundle id from `expo.ios.bundleIdentifier`, or uses `com.<user>.<slug>`.
- Several devices: add `--udid <id>`. To build without installing: `--no-install` (the `.ipa` lands in `.expo/wsl-ios/`).
- When it succeeds, tell the user to tap the app on the phone. The first time, iOS asks them to enable Developer Mode.

## When the build fails

1. Read the `error:` lines that `run` prints. The full log:
   `wsl -d expo-wsl-ios -- bash -lc 'grep -n "error:" ~/build/<app folder>/build.log | head -50'`
2. Find the failing package in `~/build/<app folder>/expo2spm-report.json` and check its `tier`.
3. Fix it with an **override**, never by editing `node_modules`:
   - `wsl -d expo-wsl-ios -- cat ~/build/<app folder>/configs/<npm-name>/spm.config.json` is the config that was used.
   - Copy it to `<project>/expo-wsl-ios/configs/<npm-name>/spm.config.json` and edit it. Paths are relative to the package's folder in `node_modules`. The format is documented by example in `node_modules/expo-modules-autolinking/external-configs/ios/*/spm.config.json`.
   - Typical fixes: `includeDirectories`, `compilerFlags` (`-DFOO=1`), `exclude`, `linkedFrameworks`, `dependencies` (`React`, `ReactNativeDependencies`, `Hermes`, or another product's name listed in `externalDependencies`).
4. If the library isn't needed on device yet, use `run --exclude <npm-name>` (comma-separated for several).
5. Rerun `run`. The framework cache makes reruns faster than the first build.

More fixes are in `docs/troubleshooting.md`. How the pipeline works is in `docs/how-it-works.md`.

## Known limits (don't try to fix these from the app side)

- Live reload from Metro is not finished. The app runs the JS bundle embedded at build time. After any change, JS included, `run` again.
- No debugger. Without Metro there's no `console.log` in the terminal. For crashes, use `pymobiledevice3 syslog live`, filtered by the product name.
- No app icon or splash screen yet; the launch screen is blank.
- There's no Xcode project.
  - Config plugins that set Info.plist keys or entitlements apply.
  - Plugins that edit the Xcode project, Podfile or AppDelegate don't apply.
  - Native code in a committed `ios/` folder isn't compiled.
  - A custom AppDelegate goes in `expo-wsl-ios/AppDelegate.swift`.
- Entitlements (push, iCloud, app groups) aren't provisioned.
- Debug builds only, no TestFlight.
- Device only; there's no simulator on Windows.
- `expo-dev-client`, `@expo/dom-webview` and `@expo/log-box` are excluded by default.
