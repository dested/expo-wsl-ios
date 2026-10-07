# expo-wsl-ios

Build your Expo app and run it on a real iPhone, from Windows. No Mac, no EAS, no cloud.

It compiles natively in WSL against Apple's real iOS SDK, signs with your App Store Connect key, and installs over USB.

```sh
npm i -D expo-wsl-ios
npx expo-wsl-ios setup --xip Xcode_27.xip --asc-key AuthKey_ABC123DEF4.p8 --issuer-id <uuid>
npx expo-wsl-ios run
```

First time? [Setup, step by step](#setup-step-by-step) shows where each of those files comes from.

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

## Setup, step by step

This is a one-time setup, about 30 minutes plus Apple's paperwork. You'll end up with three things: a `.xip` file, a `.p8` file and an issuer id. You don't need your iPhone's UDID, because `run` finds the phone over USB.

**1. Join the Apple Developer Program.** Sign up at [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/). It costs $99/year and approval can take a day.

**2. Make an App Store Connect API key (the `.p8`).**
1. Go to [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. The first time, click **Request Access**. Only the account holder can do this, and it's approved right away.
3. Under **Team Keys**, click **+** (Generate API Key). Name it `expo-wsl-ios` and set Access to **Admin**.
4. Click **Download API Key**. You get `AuthKey_XXXXXXXXXX.p8`, and Apple only lets you download it once, so keep it somewhere safe and outside your repo.
5. Copy the **Issuer ID** from the top of that page. It looks like `69a6de7f-1234-47e3-e053-5b8c7c11a4d1`.

**3. Download Xcode 27 (the `.xip`).**
1. Go to [developer.apple.com/download/all](https://developer.apple.com/download/all/?q=Xcode%2027) and sign in with your Apple ID.
2. Download **Xcode 27** as a `.xip` file (about 2 GB). It must be 27; other versions won't match the Swift in the toolchain.
3. Don't unpack it. Setup pulls the iOS SDK out of it, and you can delete it afterwards.

**4. Install the Windows bits.**
- WSL: in an **admin** PowerShell, run `wsl --install --no-distribution` and reboot. Skip this if `wsl --version` already works.
- [Apple Devices](https://apps.microsoft.com/detail/9np83lwlpz9k) from the Microsoft Store. This is the iPhone USB driver. Open it once.
- uv: `winget install astral-sh.uv`, then open a new terminal. Setup uses it to install pymobiledevice3.

**5. Run setup** from your Expo project (Expo SDK 57 or newer), with your own paths and issuer id:

```sh
npm i -D expo-wsl-ios
npx expo-wsl-ios setup --xip C:\Users\you\Downloads\Xcode_27.xip --asc-key C:\Users\you\Downloads\AuthKey_XXXXXXXXXX.p8 --issuer-id 69a6de7f-1234-47e3-e053-5b8c7c11a4d1
```

Setup downloads the prebuilt Linux distro, extracts the SDK and stores your key inside the distro. It takes about 15 minutes and uses about 12 GB of disk, plus 20 GB of temporary space while it runs.

**6. Plug in your iPhone.** Use a USB cable, unlock the phone, and tap **Trust This Computer**. Then run `npx expo-wsl-ios doctor`, which should show a ✓ on every line.

**7. Build.** Run `npx expo-wsl-ios run`. The first install makes **Developer Mode** appear on the phone: turn it on under Settings → Privacy & Security → Developer Mode, let the phone restart, then tap the app icon.

If you have no `ios.bundleIdentifier` in `app.json`, `run` picks `com.<your windows user>.<slug>`. Set your own to keep it stable. With more than one iPhone plugged in, `run` lists them and asks for `--udid`.

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
