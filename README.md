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

## From create-expo-app to your phone

The whole trip in PowerShell, from nothing to an app on the phone. Steps 3 and 4 happen only once per PC.

```powershell
# 1. A new app (or cd into an existing SDK 57+ app)
npx create-expo-app@latest myapp
cd myapp

# 2. Add expo-wsl-ios to the project
npm i -D expo-wsl-ios

# 3. One-time machine setup (see "Setup, step by step" for where these three come from)
npx expo-wsl-ios setup `
  --xip $HOME\Downloads\Xcode_27.xip `
  --asc-key $HOME\Downloads\AuthKey_ABC123DEF4.p8 `
  --issuer-id 69a6de7f-1234-47e3-e053-5b8c7c11a4d1

# 4. Plug in the iPhone, unlock it, tap Trust, then check everything
npx expo-wsl-ios doctor

# 5. Build, sign, install
npx expo-wsl-ios run
```

This is what step 5 printed for a fresh `create-expo-app` (SDK 57 default template, 24 native modules). It was cold, on the default 6 vCPUs, on an i9-14900K, trimmed:

```
   device: Dstd (00008150-001C58D40280401C)
== autolinking
== codegen (app)
== app config
== JS bundle + Hermes bytecode (embedded fallback when Metro is not running)
== generate + build + sign in WSL
== frameworks ==
== expo2spm ==
native packages (24):
  expo                             podspec       Expo
  expo-router                      podspec       ExpoRouter
  react-native-reanimated          spm-external  RNReanimated
  react-native-screens             spm-external  RNScreens
  ...
== xtool dev build (log: /home/you/build/myapp/build.log) ==
   built in 267 s
== provision com.you.myapp for 00008150-001C58D40280401C ==
signature verifies
ipa: .expo/wsl-ios/Myapp.ipa (26M)
== install

Installed myapp in 495 s. Tap it on the phone to launch.
```

Then tap the app on the phone. To change something, edit `src/app/index.tsx` and run `npx expo-wsl-ios run` again. There's no live reload yet, so every change is a rebuild. Reruns reuse the framework cache and SwiftPM's incremental build.

## Examples

```powershell
# What's missing on this machine, with the fix for each item
npx expo-wsl-ios doctor

# Build and install the app in the current folder
npx expo-wsl-ios run

# Build only. The .ipa lands in .expo\wsl-ios\
npx expo-wsl-ios run --no-install

# Several phones plugged in? Pick one (run lists the ids)
npx expo-wsl-ios run --udid 00008150-001C58D40280401C

# A different bundle id without touching app.json
npx expo-wsl-ios run --bundle-id com.you.myapp.dev

# Leave out native libraries that won't build yet
npx expo-wsl-ios run --exclude react-native-foo,react-native-bar

# Go faster: give the build 12 vCPUs instead of 6
$env:EXPO_WSL_IOS_CPUS = 12; npx expo-wsl-ios run

# Only the Windows-side JS work (autolinking, codegen, config, bundle)
npx expo-wsl-ios prep

# Read the full native build log, or see which route each library took
wsl -d expo-wsl-ios -- less ~/build/myapp/build.log
wsl -d expo-wsl-ios -- cat ~/build/myapp/expo2spm-report.json

# Start an override from the config a library actually used
wsl -d expo-wsl-ios -- cat ~/build/myapp/configs/react-native-foo/spm.config.json

# Crash on launch? Watch the phone's log
pymobiledevice3 syslog live | Select-String Myapp

# Give WSL's memory back to Windows after a build session
wsl --shutdown

# Swap in a new App Store Connect key
npx expo-wsl-ios setup --asc-key $HOME\Downloads\AuthKey_NEWKEY1234.p8 --issuer-id <uuid>

# Remove everything
wsl --unregister expo-wsl-ios
Remove-Item -Recurse -Force $env:LOCALAPPDATA\expo-wsl-ios
```

## Running it from source

Until it's on npm, or to hack on it, you need git, [bun](https://bun.sh) and Node 20+:

```powershell
git clone https://github.com/dested/expo-wsl-ios
cd expo-wsl-ios
bun install
bun run build                      # the Windows CLI: dist\cli.js
npm pack                           # expo-wsl-ios-0.1.0.tgz, exactly what npm would ship

cd ..\myapp
npm i -D ..\expo-wsl-ios\expo-wsl-ios-0.1.0.tgz
npx expo-wsl-ios doctor
```

To hack on it, link the clone instead with `npm i -D ..\expo-wsl-ios`. Edits to the generator and the shell scripts apply on the next `run`; edits to `src/cli` need `bun run build` first.

Until the prebuilt distro is published as a release, build it yourself. It takes about 45 minutes on 6 vCPUs and makes `out\expo-wsl-ios-rootfs-1.tar.gz`:

```powershell
cd expo-wsl-ios
bun rootfs/build.ts
cd ..\myapp
npx expo-wsl-ios setup --rootfs ..\expo-wsl-ios\out\expo-wsl-ios-rootfs-1.tar.gz --xip ... --asc-key ... --issuer-id ...
```

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
