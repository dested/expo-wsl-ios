# Troubleshooting

Start with `npx expo-wsl-ios doctor`. It checks everything `run` needs and prints a fix for each failure.

## A library fails to compile

`run` prints the first `error:` lines. The full log is in the distro:

```sh
wsl -d expo-wsl-ios -- less ~/build/<app folder>/build.log
```

Every package takes one of five routes into the build (see [how-it-works](how-it-works.md#2-wsl-generate-build-sign)). `~/build/<app>/expo2spm-report.json` says which route each package took. Converted podspecs (`podspec`, `remote-pod`) are where most failures come from.

You have three ways out, in order of preference:

**1. Override its config.** The generator writes every package's effective config to `~/build/<app>/configs/<npm-name>/spm.config.json`. Copy the one that fails into your app and fix it there:

```sh
mkdir -p expo-wsl-ios/configs/react-native-foo
wsl -d expo-wsl-ios -- cat ~/build/<app>/configs/react-native-foo/spm.config.json > expo-wsl-ios/configs/react-native-foo/spm.config.json
```

An override wins over everything else, and paths in it are relative to the package's folder in `node_modules`. The format is Expo's `spm.config.json`. Good examples ship in `node_modules/expo-modules-autolinking/external-configs/ios/`. The usual fixes are:

- a missing header search path: add it to `includeDirectories`
- a missing framework at link time: add it to `linkedFrameworks`
- a missing preprocessor define: add `-DFOO=1` to `compilerFlags`
- a file that shouldn't compile: add it to `exclude`
- a target that needs another target first: add it to `dependencies`. Use `React`, `ReactNativeDependencies` or `Hermes` for RN core, and the product name for other libraries, listed in `externalDependencies`.

If your override fixes a popular library, please open a PR that adds it to this repo.

**2. Exclude it.** Use `npx expo-wsl-ios run --exclude react-native-foo`, for a library you don't need on device yet. JS that calls it will throw at runtime.

**3. Open an issue** with the `build.log` errors, the package's name and version, and its route from `expo2spm-report.json`.

## Custom AppDelegate

Drop an `AppDelegate.swift` in `<app>/expo-wsl-ios/AppDelegate.swift`. By default the generator uses the one from Expo's own template.

## The app installed but won't open

- **"Untrusted Developer" / nothing happens.** Turn on Developer Mode (Settings → Privacy & Security → Developer Mode). It only appears after the first install attempt, and the phone restarts.
- **Red screen about an Info.plist key.** Add the key to `ios.infoPlist` in `app.json`.
- **Crash on launch.** Plug the phone in and run `pymobiledevice3 syslog live | findstr <YourProduct>` to see why.

## Metro

The app loads JS from Metro on your PC when it can reach it, and otherwise falls back to the bundle embedded at build time. Live reload is still being finished (see the README). What's known so far:

- iOS asks for Local Network access the first time. Allow it, or nothing reaches Metro (Settings → Privacy & Security → Local Network).
- Phone and PC must be on the same network, and Windows Firewall must allow Node on private networks.
- `run --host <ip>` overrides the auto-detected LAN address; `--port` overrides the port.

## Signing

- **401 from App Store Connect.** Your key needs the Admin role, and your PC clock must be correct (Settings → Time → Sync now). JWTs are only valid for 20 minutes, so a clock that's ahead breaks them.
- **"Maximum number of certificates".** Each account can hold only a few development certificates. Revoke an old one at developer.apple.com, then delete `~/.config/expo-wsl-ios/dev` in the distro so a new one gets made.
- **Wrong team or new key.** Rerun `setup --asc-key ... --issuer-id ...`. It replaces the stored key.

## My PC is crawling

Builds use 6 vCPUs at low priority by default (`EXPO_WSL_IOS_CPUS`). WSL also holds on to memory after a build. `wsl --shutdown` gives it all back, and the next `run` starts the distro again in a couple of seconds.

## Disk

The distro is a sparse VHDX under `%LOCALAPPDATA%\expo-wsl-ios\distro`, or wherever `--location` put it. Build trees in `~/build` and the cache in `~/.cache/expo-wsl-ios` are safe to delete.

## Uninstall

```sh
wsl --unregister expo-wsl-ios
rmdir /s %LOCALAPPDATA%\expo-wsl-ios
```

To clean up Apple's side, revoke the development certificate it created (developer.apple.com → Certificates) and remove the API key in App Store Connect.
