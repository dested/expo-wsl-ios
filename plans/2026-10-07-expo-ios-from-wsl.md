# Expo iOS builds from WSL: viability and plan

Status: active (released 2026-10-07: repo public at github.com/dested/expo-wsl-ios, rootfs-1 GitHub
release live as two parts + sha256, fresh-distro setup from the parts passed. Installs come from GitHub,
`npm i -D github:dested/expo-wsl-ios`; Sal decided not to publish to npm, so dist/cli.js is committed and
src/cli/dist.test.ts keeps it in sync.)

State at 17:10:
- create-expo-app template: crashed at launch (SDWebImage spm-deps not embedded). Fixed, plus a post-build
  check that every @rpath framework is embedded. Reinstalled; waiting on Sal to tap it to confirm.
- pickleball (G:/code/pickleball/apps/mobile, Bun monorepo, 43 native packages, Skia, vision Metal/CoreML,
  ARKit): builds and signs in 262 s as com.dested.dink.wsl (APP_VARIANT=development, --port 7413). Needs
  apps/mobile/expo-wsl-ios/AppDelegate.swift (scene life cycle; untracked there, another session has
  uncommitted work in that tree). Not yet installed: phone was off USB.
- Next: Sal taps Myapp; install Dink.ipa when the phone is back (`pymobiledevice3 apps install
  G:/code/pickleball/apps/mobile/.expo/wsl-ios/Dink.ipa`), launch-test it.
- Done: blog published (casualdeveloper c93464f, https://casualdeveloper.net/post/2026-10-07-expo-ios-from-windows/);
  expo-wsl-ios-fresh unregistered and .wsl/home-test removed; serve-parts stopped.
- Known gaps found on pickleball: withAppDelegate plugins don't run; expo-updates' resource script
  phase is skipped; xtool links with -all_load (worked around for multi-archive products only).

## Verdict

Viable. Expect about 75% odds of kidsize25 running on a phone, built entirely in
WSL on Windows 11. No one has shipped React Native for iOS without xcodebuild yet.
Two things published in the last 60 days make it tractable now:

1. **omarchy-apple-dev** (on xtool + SwiftBuild) gives Linux the full Apple
   toolchain surface. That covers swiftc/clang for arm64-apple-ios, ld64.lld, the
   iPhoneOS 27 SDK, and actool, ibtool (byte-identical storyboards), momc and
   xcstringstool. It also covers rcodesign, App Store Connect provisioning, offline
   .ipa validation and TestFlight upload. It has produced VALID TestFlight builds of
   NetNewsWire, IceCubes and Mastodon from Linux, and runs on x86_64 Arch.
2. **Expo SDK 56+ SwiftPM recipes.** Most Expo modules and the top third-party
   libraries (reanimated, worklets, screens, svg, safe-area, skia, async-storage)
   ship `spm.config.json` build recipes. Only four ship prebuilt in npm as dynamic
   `.framework`s with a `.swiftinterface` (ExpoModulesCore, ExpoModulesWorklets,
   ExpoFileSystem, ExpoFont; built by Swift 6.3.1, which 6.4 imports). React Native
   core, ReactNativeDependencies and Hermes come prebuilt from Maven. (Correction:
   the first draft of this plan said every Expo module ships prebuilt; it doesn't.)

## Architecture (Path B: Expo → SwiftPM, no CocoaPods, no xcodebuild)

```
expo prebuild -p ios --no-install   (Node; Info.plist, entitlements, AppDelegate, assets, splash storyboard)
        │
expo2spm (new)  ── autolinking resolve → per pod:
        │            prebuilt xcframework (npm tarball / Maven)  → .binaryTarget
        │            spm.config.json (Expo or external-configs)    → source targets (port Expo's SPMPackage.ts)
        │            neither                                        → podspec → spm.config translator + overrides
        │          + RN codegen target + ExpoModulesProvider.swift + app target
        ▼
Package.swift + xtool.yml  →  xtool dev build (SwiftPM/SwiftBuild, darwin SDK)  →  .app
        │
embed frameworks, main.jsbundle (expo export:embed + hermesc linux64), sign (rcodesign)
        ▼
install: Windows Apple Mobile Device Service (usbmuxd :27015) + pymobiledevice3   |   TestFlight: ship.sh --upload
```

Dev loop: build an `expo-dev-client` debug app once per native fingerprint. Metro
runs **on Windows** (no WSL networking) and JS hot-reloads over the LAN. The WSL
build runs only when native dependencies change.

Rejected:
- **CocoaPods + xcodeproj→PIF + SwiftBuild.** It's generic, but the PIF converter
  is a large unbuilt piece (xtool#144 plans it), and CocoaPods goes read-only on
  2026-12-02. Keep it as the fallback for the long tail.
- **macOS VM (OSX-KVM/Docker-OSX).** It breaks the EULA, macOS 26 is the last
  Intel release, it needs about 100 GB, and it's slow.
- **EAS cloud.** It costs money and isn't self-contained.

## Goal: a public release (Sal, 2026-10-07)

Stable enough to post on Hacker News and open-source, so other people can try it.
Priorities:
1. kidsize25 (the games app) built by the generator and running.
2. Live updating: Metro (`expo start`) on Windows serves a debug build over the LAN.
   An embedded bundle is the fallback.
3. reanimated + worklets (+ gesture-handler, svg) exercised at runtime, not just
   compiled. kidsize25's own code doesn't use them, so `fixtures/hello-expo` gets a
   demo screen.
4. Assets (images, fonts) working.
5. Nice to have: capabilities, the Expo macros plugin, a debugger.

Acceptance test (Sal): take a fresh `create-expo-app` (default template), run the
generator, and it works. Docs must be good enough that a user can point their own
Claude at the repo to handle their app's odd pods.

Not needed: release builds and TestFlight.

The blog post goes on G:\code\casualdeveloper, drafted from
`plans/2026-10-07-blog-notes.md`. Confirm with Sal before publishing or deploying.

The README must be honest about gaps: where mileage may vary, and what users must
do themselves (download Xcode.xip, own an App Store Connect API key, plug in USB,
use Apple Devices on Windows, add overrides for odd pods).

## Decision: per-app package now, shared xcframework cache later (2026-10-07)

- **B (now):** `expo2spm` emits one SwiftPM package per app. Every source module
  is a target in it, linked statically; only the prebuilt xcframeworks are binary
  targets. `spm.config.json` is read as a map of files, targets and flags, not as
  Expo's packaging. This skips Expo's post-build "fake single module" rewrite
  (modulemap, swiftinterface and -Swift.h rewriting). Proven by hand in
  `scripts/slice-hello-expo.sh`.
- **A (later, and a section of the blog post):** mirror Expo's pipeline. Each npm
  package becomes its own dynamic xcframework, cached by (package, version, RN,
  Hermes, flavor) and shared across apps, so app builds become link jobs. Research:
  `plans/2026-10-07-expo-spm-generator.md` (vendor SPMGenerator/SPMPackage from
  the sdk-57 branch). A sits under B as a cache layer and changes nothing for the app.
- Packages without a config: evaluate the podspec under a stub CocoaPods DSL (Ruby
  in WSL), then apply the mixed Swift/ObjC split. Truly odd packages get a
  committed override config. Builds stay deterministic; no LLM in the loop.

## Decisions: the deliverable (Sal, 2026-10-07 afternoon)

- **Name:** `expo-wsl-ios` (npm package and GitHub repo).
- **Our distro only.** `setup` creates a WSL distro named `expo-wsl-ios`; the user's own
  WSL is never touched. Why: omarchy is Arch-only, the toolchain is pinned tightly (Swift
  6.4, patched xtool, `AssumeResilientCxxTypes`, the swiftinterface sed), and an identical box
  makes bug reports reproducible. `wsl --unregister expo-wsl-ios` is the uninstall.
- **Prebuilt rootfs on GitHub Releases.** Arch + Swift + xtool + omarchy tools (MIT) + bun,
  ruby, rsync. Built by `wsl --install archlinux`, bootstrap, `install-toolchain.sh` without
  `XCODE_XIP` (it stops right before the SDK step), then `wsl --export`. Nothing from Apple
  is in it: each user's `setup` extracts the SDK from their own Xcode.xip.
- **Paid Apple Developer account required in v1** (Sal had no preference; it's the only
  proven signing path: the App Store Connect API key). Free Apple IDs via xtool's own login
  (7-day profiles) are future work.
- **Setup's SDK step is omarchy's `install-toolchain.sh --repair`** (SDK, darwin tools, OAM
  only). A full rerun would `yay -S --needed swift-bin` and could pull a newer AUR swift-bin
  that no longer matches the Xcode 27 SDK. The rootfs prebuilds actool and the OAM server
  so `--repair` only links them.
- **Generator runs from TS source in WSL** (bun), not bundled: `import.meta.dir`/`import.meta.main`
  break in a single-file bundle. zod is a real dependency. Only the Windows CLI is bundled
  (`bun build --target node --packages external` → `dist/cli.js`, 24 kB).
- **Apple driver check = TCP probe of 127.0.0.1:27015.** The Store "Apple Devices" app runs
  usbmuxd as `AppleMobileDeviceProcess`, with no Windows service to `sc query`.
- **No bundle id → `com.<windows user>.<slug>`** (like `expo run:ios`'s prompt default), so a
  fresh `create-expo-app` runs without editing app.json.
- **Build CPU cap.** The hello-expo rebuild (reanimated/worklets C++) plus the node_modules
  mirror from `G:` took every thread WSL had (16 of 32, 24 GB) and froze Sal's machine. All
  WSL work now runs under `taskset` + `nice` on a few vCPUs (default 6, configurable) instead
  of changing `.wslconfig` globally.

## The deliverable

```
npm i -D expo-wsl-ios        # in the Expo project, on Windows
npx expo-wsl-ios setup --xip <Xcode_27.xip> --asc-key <AuthKey_XXXX.p8> --issuer-id <id>   # key id from the file name
npx expo-wsl-ios doctor      # every prerequisite, with the fix for each
npx expo-wsl-ios run         # prep, build, sign, install; then `npx expo start` for live reload
```

Two halves, each where it has to run:
- **Windows (Node, in the npm package):** autolinking, codegen, `expo config`, `export:embed`,
  hermesc, and install through Apple's usbmuxd with pymobiledevice3. These need the
  Windows-installed node_modules (win32 binaries, fast NTFS).
- **WSL (bun, run from the package path via /mnt):** expo2spm, the framework cache,
  SwiftPM/SwiftBuild through xtool, rcodesign signing.

Per project: `.expo/wsl-ios/` for prep output and the .ipa (`.expo/` is already gitignored by
Expo templates) and an optional `expo-wsl-ios/configs/<pkg>/spm.config.json` for overrides.
Build output lives in the distro (`~/build/<app>`).

What a user brings: Windows 11 + WSL2, a paid Apple Developer account and an App Store
Connect API key (Admin or Developer role), Xcode.xip (about 3 GB, Apple ID sign-in), Apple
Devices from the Microsoft Store (usbmuxd), an iPhone on USB with Developer Mode on, `uv`
(for pymobiledevice3), and about 15 GB of disk.

## Where it stands (2026-10-07 14:30)

- Generator end to end: Windows prep (8 s hello-expo, 24 s kidsize25) → WSL frameworks
  cache (Maven RN/RND/Hermes, npm Expo xcframeworks, ExpoModulesJSI built from source in
  17 s) → expo2spm → xtool → rcodesign → pymobiledevice3 install (5 s).
- kidsize25: 29 native packages + the remote pod openiap, 177 s cold build, 34 MB .ipa,
  runs (Sal: "the build fully works"). hello-expo: runs; the reanimated/worklets/
  gesture-handler/svg demo screen built (not yet looked at on the phone).
- Podspec converter: `src/expo2spm/podspec` (Ruby stub DSL, 12 tests). Remote pods:
  `src/expo2spm/remote-pods.ts` (CocoaPods trunk CDN, version requirements, git/http source).

## Remaining work for v1 (in order)

1. ~~Package~~ done: `src/cli` (setup/doctor/run/prep), `npm pack` = 18 files, 51 kB. `doctor`
   verified on Windows against a missing distro. `setup` and `run` through the packaged CLI
   are **not yet exercised** (needs the rootfs, or Sal's `wslosx` distro, see below).
2. Rootfs: `bun rootfs/build.ts [--tag 1] [--keep]` is written (fresh Arch as
   `expo-wsl-ios-build` in `.wsl/rootfs-build` → `bootstrap.sh expo` → `toolchain.sh` →
   `clean.sh` → `wsl --export --format tar.gz` to `out/` + `.sha256`). **Not run yet**
   (heavy: xtool from source; capped to 6 vCPUs). Unverified: `wsl --import` of a .tar.gz
   (expected to work, it's the .wsl format), final size vs GitHub's 2 GiB asset limit.
   Then upload as release `rootfs-1` (URL baked into `src/cli/env.ts`).
3. ~~README, docs, AGENTS.md~~ done: `README.md`, `docs/how-it-works.md`,
   `docs/troubleshooting.md`, `AGENTS.md`, `LICENSE` (MIT), `.gitattributes` (LF for .sh/.rb/.ts).
4. ~~Blog draft~~ done: `G:\code\casualdeveloper\content\post6-10-07-expo-ios-from-windows.md`,
   `draft: true`, not committed. Sal reviews before commit/deploy. Placeholder claims to
   recheck once the rootfs exists: "setup imports a prebuilt Arch distro".
4b. Validate on Sal's existing distro before the rootfs exists:
   `EXPO_WSL_IOS_DISTRO=wslosx EXPO_WSL_IOS_PMD=G:\code\wslosx\.venv-win\Scripts\pymobiledevice3.exe`.
   First, in that distro: `mv ~/.cache/wslosx ~/.cache/expo-wsl-ios` (keeps the JSI build),
   copy `.secrets/AuthKey_*.p8` + asc env into `~/.config/expo-wsl-ios/` via `setup --asc-key`,
   and copy `.secrets/dev` to `~/.config/expo-wsl-ios/dev` so no new Apple dev cert is minted.
   Its user is `sal`, not `expo`; nothing in the scripts depends on the name.
5. Live reload proof on kidsize25 (`expo start --port 4766`). Two findings so far:
   - iOS blocks the first Metro probe with "Local network prohibited" until the user
     allows the Local Network prompt (needs `NSLocalNetworkUsageDescription`; kidsize25 has
     it via the dev-client plugin, a fresh app may not: the generator should add it).
   - `ip.txt` holds `host:port` and RN's bundle URL uses it, but something else still
     probes `:8081` (the compiled-in RCT_METRO_PORT), likely the dev-tools/packager
     websocket. Not yet fixed.
6. Icon and splash: AppIcon asset catalog via actool, `SplashScreen.storyboard` via ibtool
   (both from omarchy). Today the icon is missing and the launch screen is blank.
7. Acceptance test: fresh `create-expo-app` (default template) → `expo-wsl-ios run` → works.
8. Speed: skip native rebuilds when the native fingerprint is unchanged; stop re-mirroring
   node_modules on every run (about 60 s on kidsize25).

## Known gaps to document (not v1)

- SwiftPM resource bundles (ExpoSystemUI privacy manifest, RNSVG Metal filters) are not
  bundled. CocoaPods `resources` are copied to the .app root.
- Entitlement-heavy capabilities (push, iCloud, app groups): dev signing keeps only the
  basic entitlements.
- expo-dev-client (launcher UI), `@expo/dom-webview` and `@expo/log-box` are excluded.
- Release / TestFlight builds (omarchy's ship.sh exists; untested here).
- No lldb. RN DevTools over Metro is the debugger.
- The app launches by tapping it (iOS 17+ remote launch needs an RSD tunnel).
- Phase A (shared xcframework cache per package version) comes after v1.

## Machine notes (Sal's box, not product)

- `~/.wslconfig`: `autoMemoryReclaim` and `sparseVhd` sit under `[wsl2]`, where WSL ignores
  them; they belong under `[experimental]`. Not changed.

## Reuse vs build

| Reuse as-is | Build new |
|---|---|
| omarchy `install-toolchain.sh` (Swift 6.4, xtool 1.20.1+fixes, SDK, actool/ibtool) | WSL Arch distro bootstrap (user, yay, systemd quirks) |
| `ship.sh`, `tools/asc.py` (sign, validate, upload) | `expo2spm` generator (TS/Bun): autolinking → Package.swift |
| `tools/provision-dev.py` (dev cert + profile via ASC key) | spm.config → Package.swift renderer (port of Expo's MIT `SPMPackage.ts`) |
| Expo `spm.config.json` + external-configs | podspec → spm.config translator for the long tail |
| RN codegen, expo-modules-autolinking, hermesc linux64 | Maven fetch for React/ReactNativeDependencies/Hermes xcframeworks |
| pymobiledevice3 (Windows-native) | `wslosx` CLI: `build`, `run`, `ship`, fingerprint cache |

## Milestones (each has a hard exit check)

- **M0 toolchain. Done.** Arch WSL distro on G:, omarchy installer, Xcode 27 SDK.
  Exit: `xtool dev build` of a template emits an arm64 Mach-O.
- **M1 phone. Done.** A SwiftUI hello app, provisioned through the ASC key and installed
  from WSL through the Windows usbmuxd. Exit: it runs on the phone.
- **M1.5 Expo slice. Done.** `fixtures/hello-expo` (blank Expo SDK 57 app),
  hand-assembled package, ExpoModulesJSI built on Linux, Hermes bytecode from
  linux64 hermesc. Exit: it renders on the phone and handles taps.
- **M2 link. Done.** kidsize25 debug .app (dev-client excluded) built by the generator in
  WSL, frameworks embedded and signed.
- **M3 run.** kidsize25 on the phone (done, embedded JS), loading JS from Metro on Windows.
  Exit: hot reload works.
- **M4 ship.** A release build to TestFlight. Exit: App Store Connect says VALID.
- **M5 long tail.** kitchensink (skia, audio-api, camera, doc-scanner, expo-iap)
  and a polished `wslosx` CLI.

## Risks (ranked)

1. **C++ third-party libraries via SwiftPM on Linux** (reanimated/worklets).
   Mitigation: build once per version and cache, or use Expo's remote prebuilts
   if a public base URL exists.
2. **Dynamic-framework embedding in xtool** (binaryTarget). Mitigation:
   post-process in our packer, the way `ship.sh` wraps dylibs.
3. **Long-tail pods with no spm.config** (expo-iap→openiap, audio-api,
   doc-scanner, view-shot). Mitigation: translator + per-library overrides.
4. **iOS 17+ launch needs an RSD tunnel**, which requires admin/TUN on Windows.
   Install alone needs no tunnel.

## Hard walls (not solvable here)

- No iOS Simulator on Windows. Device only, plus Expo web.
- Xcode 27 `.xip` has to be downloaded by hand once with an Apple ID sign-in.
- Wireless install from non-Mac hosts is blocked on iOS 26 (FINDINGS 17). USB for
  install; Metro reload is wireless anyway.

## Disk

About 10 GB steady state in a sparse VHDX on G:: Arch about 1, Swift about 3.3, SDK
cache about 3, plus per-app builds. The transient peak during SDK extraction is
around 20 GB, and the `.xip` is deleted afterwards.
