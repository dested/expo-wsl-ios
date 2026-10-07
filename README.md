# expo-wsl-ios

Build your Expo app and run it on a real iPhone, from Windows. No Mac, no EAS, no cloud.

It compiles natively in WSL against Apple's real iOS SDK, signs with your App Store Connect key, and installs over USB.

```sh
npm i -D expo-wsl-ios
npx expo-wsl-ios setup --xip Xcode_27.xip --asc-key AuthKey_ABC123DEF4.p8 --issuer-id <uuid>
npx expo-wsl-ios run
```

## Status

Early. It has built and run two apps: a production app with 29 native modules (expo-router, react-native-screens, reanimated 4, gesture-handler, svg, in-app purchases) and a blank SDK 57 app. Both ran on one PC and one iPhone (iOS 27.2). Cold build: about 3 minutes on a desktop i9 with all cores, longer on the default 6. Install: 5 seconds.

| Works | Not yet |
| --- | --- |
| Debug builds on a USB-connected iPhone | App icon and splash screen (blank launch screen for now) |
| Expo modules, RN new architecture, Hermes | Live reload from Metro (the app runs the JS bundle embedded at build time) |
| reanimated, worklets, gesture-handler, svg, screens, expo-router | Push, iCloud, app groups and other entitlements |
| CocoaPods-only libraries: podspecs are converted, trunk pods fetched | Release and TestFlight builds |
| Signing through the App Store Connect API (no Apple ID login, no 7-day profiles) | Launching from the CLI (tap the icon) |

## Gaps: read this before you start

**What you'll hit on day one**

- **No live reload.** Every change, JS included, means a full `run`: minutes, not seconds.
- **No debugger.** Without Metro there's no React DevTools and no `console.log` in your terminal, and there's no lldb. Crash logs come from `pymobiledevice3 syslog live`.
- **No app icon or splash screen.** You get the default icon and a blank launch screen.
- **There's no Xcode project.**
  - Config plugins that only set Info.plist keys or entitlements work.
  - Plugins that edit the Xcode project, the Podfile, the AppDelegate, or add files under `ios/` do nothing.
  - Native code in a committed `ios/` folder isn't compiled.
  - To customize the AppDelegate, replace it with `expo-wsl-ios/AppDelegate.swift`.
- **The long tail of libraries.** Libraries without an Expo SwiftPM config go through a podspec converter. Popular ones work; an obscure native library may need a small override (see [troubleshooting](docs/troubleshooting.md)).

**Not supported (yet or ever)**

- Release, TestFlight and App Store builds
- Push, iCloud, app groups and other entitlements beyond the basics
- expo-dev-client's launcher UI, DOM components (`@expo/dom-webview`) and LogBox, which are excluded by default
- Launching from the CLI (tap the icon) and wireless install (USB only)
- The iOS Simulator (macOS only, so never)
- Expo SDK 56 and older, Windows on ARM, Yarn Plug'n'Play
- Local Expo modules in `modules/` and pnpm layouts are untested

**What it costs**

- A paid Apple Developer Program membership ($99/year)
- Downloading Xcode 27 by hand (2 GB, Apple ID sign-in). It has to be 27, to match the bundled Swift 6.4
- About 12 GB of disk, plus 20 GB of temporary space during setup
- Time: a cold build of the 29-module app takes about 3 minutes with all 16 cores and 6–8 minutes on the default 6. Builds aren't cached across `run`s yet, beyond what SwiftPM reuses.

## Requirements

- Windows 11 with WSL 2. About 12 GB of disk once set up, plus about 20 GB of temporary space during setup.
- Expo SDK 57 or newer.
- A paid Apple Developer Program membership, plus an App Store Connect API key with the Admin role (App Store Connect → Users and Access → Integrations → Team Keys). The key creates a development certificate, registers your iPhone and makes provisioning profiles.
- `Xcode_27.xip` from [developer.apple.com/download/all](https://developer.apple.com/download/all/?q=Xcode). Setup extracts the iOS SDK from it; Xcode itself never runs.
- [Apple Devices](https://apps.microsoft.com/detail/9np83lwlpz9k) from the Microsoft Store (the USB driver), and [uv](https://docs.astral.sh/uv/) (`winget install astral-sh.uv`) for pymobiledevice3.
- An iPhone with Developer Mode on (Settings → Privacy & Security; it appears after the first install attempt).

## Commands

| Command | What it does |
| --- | --- |
| `setup` | One time. Imports the prebuilt WSL distro, extracts the SDK from the `.xip` and stores your key. Every step is idempotent. |
| `doctor` | Checks every prerequisite and prints the fix for each failure. Run it first when something breaks. |
| `run` | Builds, signs and installs the app in the current directory. `--udid`, `--bundle-id`, `--exclude a,b`, `--no-install`. |

Builds run on 6 vCPUs at low priority so Windows stays usable. Set `EXPO_WSL_IOS_CPUS=16` if you'd rather have speed.

## How it works

```
Windows (Node)                         WSL (Arch, Swift 6.4)                    Windows
─────────────────                      ─────────────────────                    ───────
autolinking, codegen,          ──▶     Package.swift from Expo's        ──▶     pymobiledevice3
expo config, export:embed,             spm.config.json files + converted        over Apple's usbmuxd
hermesc (bytecode)                     podspecs, xtool + SwiftBuild,            ──▶ iPhone
                                       Apple SDK, rcodesign
```

Expo SDK 57 libraries ship SwiftPM build recipes (`spm.config.json`) for Expo's own move away from CocoaPods. expo-wsl-ios turns those recipes, plus a converted podspec for every library that lacks one, into a single Swift package. It then builds that package on Linux with [xtool](https://github.com/xtool-org/xtool). React Native, Hermes and a few Expo modules come prebuilt from Maven and npm. All the JS tooling stays on Windows, where your `node_modules` already lives.

The details are in [docs/how-it-works.md](docs/how-it-works.md).

## When a library won't build

`run` prints the first compiler errors, and the full log is in the distro. Most fixes are a small `spm.config.json` override in your app at `expo-wsl-ios/configs/<npm-name>/spm.config.json`, or `--exclude <npm-name>` for a library you can live without. See [docs/troubleshooting.md](docs/troubleshooting.md).

## Using an AI agent

Point your agent at [AGENTS.md](AGENTS.md). It covers setup, the build loop and how to write overrides.

## Legal

You download Xcode yourself and the SDK never leaves your machine; this project redistributes nothing from Apple. Apple's Xcode license limits the SDK to Apple-branded computers. Read it and make your own call.

## Credits

This is mostly glue on top of other people's hard work:

- [omarchy-apple-dev](https://github.com/joshuaswarren/omarchy-apple-dev) by Joshua Warren: the Linux iOS toolchain, Linux actool/ibtool, the SDK pipeline, App Store Connect provisioning.
- [xtool](https://github.com/xtool-org/xtool) by Kabir Oberai: SwiftPM for iOS on Linux.
- [rcodesign](https://github.com/indygreg/apple-platform-rs) by Gregory Szorc, for code signing.
- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) by doronz88, for install.
- Expo's SwiftPM work, which made the build recipes exist at all.

Not affiliated with Apple or Expo. MIT.
