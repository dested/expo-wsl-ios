# Blog notes: iOS apps from Windows 11 + WSL, no Mac

Status: active (raw material, append as we go)

## Timeline (2026-10-07, all times MST)

- 11:28. Kickoff. The question: can omarchy-apple-dev (Linux iOS toolchain, a month
  old) build Expo apps on a stock Windows 11 PC through WSL, fully self-contained?
- ~11:40. Research verdict: viable. Two enablers landed in the last 60 days:
  omarchy-apple-dev (xtool + SwiftBuild + Linux actool/ibtool + rcodesign + App Store
  Connect API), and Expo SDK 56+ precompiled XCFrameworks / SwiftPM configs.
- 11:41. First detour. The WSL VM kept dying mid-install. The cause wasn't WSL: a
  leaking TUI on the same box had reserved 68 GB of commit and Windows ran out.
  Killed it and the installs ran clean. (Lesson: commit is not RSS. Watch
  Resource-Exhaustion-Detector event 2004.)
- 12:05–12:20. Toolchain in an Arch WSL distro: swift-bin 6.4, xtool built from
  source (28 CPU-min), rcodesign, pymobiledevice3.
- 12:12. Xcode 27 .xip (2.0 GB) downloaded by hand: the one manual step. The SDK
  build extracted iPhoneOS27.0.sdk from it.
- 12:31. First WSL-built iOS binary: xtool SwiftUI template, `Build complete! (11.42
  secs)`, `Mach-O 64-bit arm64 executable`.
- 12:32. 401 from App Store Connect. omarchy signs JWTs with exp = now + 1200,
  exactly Apple's limit, and this PC's clock runs a few seconds ahead of Apple's. An
  A/B test settled it: ttl 1200 → 401, ttl 1190 → 200.
- 12:33. Dev cert, device registration and profile created through the team API key
  (pulled from EAS). Signed with rcodesign, then installed over USB through Windows'
  own Apple Devices service (usbmuxd on 127.0.0.1:27015) with Windows-native
  pymobiledevice3. `Installation succeed.` The app opened on an iPhone 18,1 running
  iOS 27.2 beta.

- 13:08. ExpoModulesJSI (Expo's Swift + C++ interop JSI layer, which Expo itself only
  ever builds with xcodebuild at pod-install time) compiles on Linux. Three fixes:
  `<swift/bridging>` lives in the host toolchain, not the SDK bundle; a fake
  `Pods/Headers/Public` pointing at the Hermes and RN-deps headers from the Maven
  tarballs; and `-enable-experimental-feature AssumeResilientCxxTypes`, because Swift
  6.4 rejects C++ types in library-evolution API where Expo's 6.3.1 accepted them.
- 13:15. JS side, all on Windows/Linux with stock tools: `expo export:embed` (6 s),
  the linux64 `hermesc` from the `hermes-compiler` npm package (3.5 s, bytecode v98,
  matches hermesvm 250829098.0.17), `expo-modules-autolinking
  generate-modules-provider`, RN's `generate-codegen-artifacts.js`.
- 13:20. A whole Expo app (prebuilt React/Hermes/ExpoModulesCore + Linux-built JSI +
  source-built Expo, EXConstants, ExpoAsset, ExpoKeepAwake + codegen) links in 16 s.
  Swift 6.4 prints module selectors in .swiftinterface (`__ObjC::expo.__ObjC::CppError`),
  which slipped past Expo's interface-stripping sed; widened it.
- 13:22. First launch: React Native's RedBox ("RCTStatusBarManager module requires
  UIViewControllerBasedStatusBarAppearance=NO"). The best error ever: JS ran,
  expo-status-bar called native, React rendered. One Info.plist key away.

- 13:55. Generator end to end on hello-expo: Windows prep (autolinking, codegen,
  config, bundle, hermesc) 8 s, then WSL frameworks cache + expo2spm + xtool 15.5 s +
  rcodesign. The hand-written slice script is retired. The podspec converter (a Ruby
  stub DSL that evaluates real podspecs) split `expo` into exactly the targets I had
  written by hand.
- 13:58. The jsi `#pragma once` trap: RN's `ReactCommon/jsi/jsi.h` and Hermes's
  `include/jsi/jsi.h` are byte-identical but different files, so a module whose
  umbrella is one and whose `-I` reaches the other defines everything twice. Fix:
  make both paths the same inode (a `React-jsi` symlink to the Hermes headers).

- 14:15. kidsize25 (the real games app, 29 native packages) built by the generator and
  installed. Four fixes on the way, each a gap between "spm.config.json" and what
  Expo's own generator does around it: remote CocoaPods pods (expo-iap → openiap,
  fetched from the trunk CDN by version, then converted like any podspec), converted
  codegen libraries depending on the app's ReactCodegen, `${PACKAGE_VERSION}` /
  `${REACT_NATIVE_MINOR_VERSION}` flag substitution, and Expo's `.build/generated/
  <Product>/<Target>` include paths plus `excludeFromUmbrella`. 177 s cold build,
  158 MB .app, 34 MB .ipa, 5 s install.

## Architecture worth explaining

- WSL builds and Windows installs. No USB passthrough (usbipd): the iPhone stays
  owned by Windows' Apple Mobile Device Service, and the .ipa crosses over the
  shared drive.
- No Mac anywhere. The only Apple artifact is Xcode.xip, used as a box of SDK files
  that never runs.
- Signing goes through the App Store Connect API key (team, ADMIN), with no Apple
  ID, no 2FA and no 7-day profiles.

## Numbers

- Arch WSL base VHDX: 620 MB. Swift toolchain: about 3.3 GB. SDK cache: about 3 GB.
- Template build: 14 s wall clock on an i9-14900K. Install: about 1 s.

## Bugs found upstream (file issues / PRs)

- omarchy `asc.py` JWT exp = 1200 s: fails under any clock skew ahead of Apple.
- omarchy `install-toolchain.sh` patches root-owned SwiftBuild xcspecs as the user
  (EPERM on pacman swift-bin).
- WSL: `.wslconfig` `sparseVhd`/`autoMemoryReclaim` under `[wsl2]` are silently
  ignored (they belong in `[experimental]`).
