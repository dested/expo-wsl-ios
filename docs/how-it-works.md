# How it works

`npx expo-wsl-ios run` runs in three stages: JS work on Windows, then the native build and signing in WSL, then install on Windows.

## 1. Windows: prep (Node, about 10–25 s)

Everything that needs your `node_modules` runs where they already are, with the same tools `expo run:ios` uses:

| Step | Tool | Output |
| --- | --- | --- |
| Which native packages are linked | `expo-modules-autolinking resolve` + `react-native-config` | `expo-resolve.json`, `rn-config.json` |
| Expo module registry | `expo-modules-autolinking generate-modules-provider` | `ExpoModulesProvider.swift` |
| TurboModule / Fabric codegen | `react-native/scripts/generate-codegen-artifacts.js` | `codegen/`, `libs/<pkg>/codegen/` |
| App config | `expo config --type introspect` | `introspect.json` (Info.plist, entitlements, after config plugins) |
| `expo-constants` manifest | `expo-constants/scripts/getAppConfig.js` | `EXConstants.bundle` |
| JS bundle | `expo export:embed` then `hermesc` (the win64 build that ships in `hermes-compiler`) | `main.hbc` + assets |
| Metro address | your LAN IPv4 | `ip.txt` (`host:port`) |

Everything lands in `<app>/.expo/wsl-ios/prep`.

## 2. WSL: generate, build, sign

The distro is Arch Linux with the toolchain from [omarchy-apple-dev](https://github.com/joshuaswarren/omarchy-apple-dev): Swift 6.4, xtool, SwiftBuild, ld64.lld, rcodesign, Linux ports of actool and ibtool, and the iOS 27 SDK extracted from your `Xcode.xip`. The build runs under `taskset` and `nice`.

**Frameworks** (`scripts/frameworks.sh`). Downloaded once per version into `~/.cache/expo-wsl-ios`:

- React Native core and ReactNativeDependencies xcframeworks from Maven (`react-native-artifacts`)
- Hermes from Maven (`hermes-ios`)
- Expo's prebuilt xcframeworks from npm (ExpoModulesCore and a few more)
- ExpoModulesJSI, built from source here (Expo only ever builds it with xcodebuild)

**Generator** (`src/expo2spm`). Turns the app into one Swift package. Each native package resolves to an `spm.config.json`, taken from the first of these that exists:

1. `override`: your app's `expo-wsl-ios/configs/<npm-name>/spm.config.json`
2. `spm`: the package's own `spm.config.json` (Expo SDK 57 modules and a growing list of libraries)
3. `spm-external`: the configs Expo ships for popular third-party libraries in `expo-modules-autolinking/external-configs`
4. `podspec`: the package's `.podspec`, run under a stub CocoaPods DSL in Ruby and converted
5. `remote-pod`: a CocoaPods dependency that isn't in `node_modules` (e.g. expo-iap → openiap), fetched from the trunk CDN at a version that satisfies the podspec, then converted like 4

Then it renders `Package.swift` (a port of Expo's MIT `SPMPackage.ts`), the app target (`AppDelegate.swift` from Expo's template, `ExpoModulesProvider.swift`, codegen), the `Info.plist` from `introspect.json`, and `xtool.yml`. `expo2spm-report.json` records which tier every package took.

**Build.** `xtool dev build` compiles the package with SwiftBuild against the SDK and produces an `.app`.

**Sign** (`scripts/dev-sign.sh`). Through the App Store Connect API, with no Apple ID login: it creates a development certificate once, registers the device, makes a profile per bundle id, signs with `rcodesign` inside-out, and zips an `.ipa`. The cert and profiles live in `~/.config/expo-wsl-ios/dev`.

Build trees live in `~/build/<app folder>` inside the distro. The `.ipa` is written back to `<app>/.expo/wsl-ios/<Product>.ipa`.

## 3. Windows: install

`pymobiledevice3 apps install` talks to the usbmuxd that comes with Apple's "Apple Devices" app (`127.0.0.1:27015`). The iPhone stays owned by Windows; there's no USB passthrough into WSL.

## Where things live

| Where | What |
| --- | --- |
| `%LOCALAPPDATA%\expo-wsl-ios` | the downloaded rootfs and the distro's VHDX (`--location` to move it) |
| `<app>/.expo/wsl-ios` | prep output and the `.ipa` |
| distro `~/build/<app>` | generated package, `build.log`, `expo2spm-report.json` |
| distro `~/.cache/expo-wsl-ios` | framework and pod cache, shared across apps |
| distro `~/.config/expo-wsl-ios` | App Store Connect key, dev certificate, profiles |
| distro `~/.swiftpm/swift-sdks` | the iOS SDK |

## Defaults worth knowing

- Debug builds only. The app loads JS from Metro when it can reach it, and falls back to the embedded Hermes bundle when it can't.
- Excluded by default: `expo-dev-client`, `expo-dev-launcher`, `expo-dev-menu`, `expo-dev-menu-interface`, `@expo/dom-webview` and `@expo/log-box`. They're dev tooling with a lot of native weight, and a plain debug build already talks to Metro.
- The launch storyboard isn't compiled yet, so the app uses a blank `UILaunchScreen`.
- `NSLocalNetworkUsageDescription` gets a default, because iOS blocks Metro until the user allows Local Network access.
- Entitlements from your config are written out but not provisioned. Dev signing keeps `application-identifier`, team id, `keychain-access-groups` and `get-task-allow`.
- No bundle id in `app.json` means `com.<windows user>.<slug>`.
