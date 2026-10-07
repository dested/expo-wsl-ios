#!/usr/bin/env bash
# Spike: build ExpoModulesJSI (Swift + C++ interop SwiftPM package) for arm64-apple-ios on Linux
# and wrap it as ExpoModulesJSI.framework, the install name the prebuilt Expo frameworks load.
set -euo pipefail
export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$PATH"
ulimit -n 65536 || true
nm=${NM:-/mnt/g/code/bland/apps/kidsize25/node_modules}
spike="$HOME/spike"
src="$spike/jsi"
fw="$spike/fw"
# Stand-in for Pods/Headers/Public with prebuilt RN: the two header roots Package.swift reads.
pub="$spike/pods/Headers/Public"
mkdir -p "$pub"
ln -sfn "$fw/hermes-headers" "$pub/hermes-engine"
ln -sfn "$fw/ReactNativeDependencies.xcframework/Headers" "$pub/ReactNativeDependencies"
rsync -a --delete --exclude .build --exclude .generated "$nm/expo-modules-jsi/apple/" "$src/"
export PODS_ROOT="$spike/pods" RN_ROOT="$nm/react-native"
bash "$src/scripts/generate-modulemap.sh"
cat "$src/.generated/module.modulemap"
cd "$src"
# Same invocation xtool uses (PackLib/BuildSettings.swift): SwiftBuild finds iPhoneOS.platform
# through XCODE_EXTRA_PLATFORM_FOLDERS, the linker/librarian through toolset-swb.json.
B="$HOME/.swiftpm/swift-sdks/darwin.artifactbundle"
export XCODE_EXTRA_PLATFORM_FOLDERS="$B/Developer/Platforms" PATH="$B/toolset/bin:$PATH"
unset SDKROOT
# <swift/bridging> (SWIFT_NAME etc. for C++ interop) ships with the host toolchain, not the SDK bundle.
inc=/usr/lib/swift/usr/include
time swift build --build-system swiftbuild --triple arm64-apple-ios --toolset "$B/toolset-swb.json" \
  -c release --product ExpoModulesJSI -Xcc -I$inc -Xcxx -I$inc \
  -Xswiftc -enable-experimental-feature -Xswiftc AssumeResilientCxxTypes \
  -Xlinker -install_name -Xlinker @rpath/ExpoModulesJSI.framework/ExpoModulesJSI 2>&1 | tail -40
ls -la .build/arm64-apple-ios/release/ | grep -i -E 'ExpoModulesJSI|\.dylib' || true
