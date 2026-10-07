#!/usr/bin/env bash
# Version-keyed prebuilt framework cache: React Native core, ReactNativeDependencies and Hermes
# (Maven), Expo's npm-shipped xcframeworks, and ExpoModulesJSI (built here on Linux). Each piece
# is cached once per version under $EXPO_WSL_IOS_CACHE; <dest> becomes a directory of symlinks to it.
# usage: frameworks.sh <app node_modules> <dest> [debug|release]
set -euo pipefail
export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$PATH"
nm=$1; dest=$2; flavor=${3:-debug}
cache=${EXPO_WSL_IOS_CACHE:-$HOME/.cache/expo-wsl-ios}
repo=$(cd "$(dirname "$0")/.." && pwd)
maven=https://repo1.maven.org/maven2
ver() { node -p "require('$1/package.json').version"; }

rn=$(ver "$nm/react-native")
hermes=$(sed -n 's/^HERMES_V1_VERSION_NAME=//p' "$nm/react-native/sdks/hermes-engine/version.properties")
[ -n "$hermes" ] || { echo "frameworks: no HERMES_V1_VERSION_NAME in react-native/sdks/hermes-engine/version.properties" >&2; exit 1; }

# fetch <url> -> cached path on stdout
fetch() {
  local url=$1 file; file="$cache/dl/$(basename "$1")"
  mkdir -p "$cache/dl"
  if [ ! -s "$file" ]; then
    echo "   download $(basename "$file")" >&2
    curl -fsSL --retry 3 -o "$file.part" "$url" && mv "$file.part" "$file"
  fi
  echo "$file"
}

# React Native core + dependencies + Hermes.
base="$cache/rn/$rn-hermes$hermes-$flavor"
if [ ! -d "$base/hermes-headers" ]; then
  echo "== React Native $rn / Hermes $hermes ($flavor) =="
  tmp=$(mktemp -d); stage="$base.tmp"; rm -rf "$stage"; mkdir -p "$stage"
  tar -xzf "$(fetch "$maven/com/facebook/react/react-native-artifacts/$rn/react-native-artifacts-$rn-reactnative-core-$flavor.tar.gz")" -C "$tmp" 2>/dev/null
  mv "$tmp/React.xcframework" "$stage/"
  tar -xzf "$(fetch "$maven/com/facebook/react/react-native-artifacts/$rn/react-native-artifacts-$rn-reactnative-dependencies-$flavor.tar.gz")" -C "$tmp" 2>/dev/null
  mv "$tmp/packages/react-native/third-party/ReactNativeDependencies.xcframework" "$stage/"
  tar -xzf "$(fetch "$maven/com/facebook/hermes/hermes-ios/$hermes/hermes-ios-$hermes-hermes-ios-$flavor.tar.gz")" -C "$tmp" 2>/dev/null
  mv "$tmp/destroot/Library/Frameworks/universal/hermesvm.xcframework" "$stage/"
  # The framework ships no headers; the hermes-engine pod maps destroot/include instead.
  mv "$tmp/destroot/include" "$stage/hermes-headers"
  find "$stage" -name '._*' -delete
  rm -rf "$tmp" "$base"; mv "$stage" "$base"
fi

rm -rf "$dest"; mkdir -p "$dest"
for f in React ReactNativeDependencies hermesvm; do ln -s "$base/$f.xcframework" "$dest/$f.xcframework"; done
ln -s "$base/hermes-headers" "$dest/hermes-headers"

# Expo packages that ship prebuilt xcframeworks in npm (prebuilds/output/<flavor>/xcframeworks).
shopt -s nullglob
for t in "$nm"/*/prebuilds/output/"$flavor"/xcframeworks/*.tar.gz "$nm"/@*/*/prebuilds/output/"$flavor"/xcframeworks/*.tar.gz; do
  pkgdir=${t%%/prebuilds/*}; pkg=${pkgdir#"$nm"/}; name=$(basename "$t" .tar.gz)
  dir="$cache/expo/${pkg//\//+}@$(ver "$pkgdir")-$flavor"
  if [ ! -d "$dir/$name.xcframework" ]; then
    echo "== $pkg: $name.xcframework =="
    mkdir -p "$dir"; tar -xzf "$t" -C "$dir" 2>/dev/null; find "$dir" -name '._*' -delete
  fi
  ln -s "$dir/$name.xcframework" "$dest/$name.xcframework"
done
shopt -u nullglob

# ExpoModulesJSI: Swift + C++ interop package; npm ships sources only. Built once per version.
if [ -d "$nm/expo-modules-jsi/apple" ]; then
  jsiver=$(ver "$nm/expo-modules-jsi")
  jsi="$cache/jsi/$jsiver-rn$rn-hermes$hermes"
  if [ ! -d "$jsi/ExpoModulesJSI.xcframework" ]; then
    echo "== ExpoModulesJSI $jsiver (Swift/C++ build, a few minutes the first time) =="
    work="$cache/jsi-build/$jsiver"; src="$work/src"; pub="$work/pods/Headers/Public"
    mkdir -p "$pub"
    ln -sfn "$base/hermes-headers" "$pub/hermes-engine"
    # The jsi module's umbrella must be the same file <jsi/jsi.h> resolves to through -I hermes-engine;
    # RN's identical ReactCommon copy is a different file, and #pragma once then lets both in.
    ln -sfn "$base/hermes-headers" "$pub/React-jsi"
    ln -sfn "$base/ReactNativeDependencies.xcframework/Headers" "$pub/ReactNativeDependencies"
    rsync -a --delete --exclude .build --exclude .generated "$nm/expo-modules-jsi/apple/" "$src/"
    # Package.swift reads both at manifest evaluation, so they stay exported for the build too.
    export PODS_ROOT="$work/pods" RN_ROOT="$nm/react-native"
    bash "$src/scripts/generate-modulemap.sh" >/dev/null
    B="$HOME/.swiftpm/swift-sdks/darwin.artifactbundle"
    inc=/usr/lib/swift/usr/include
    # Same environment xtool gives SwiftBuild; <swift/bridging> comes from the host toolchain.
    (cd "$src" && unset SDKROOT && XCODE_EXTRA_PLATFORM_FOLDERS="$B/Developer/Platforms" PATH="$B/toolset/bin:$PATH" \
      swift build --build-system swiftbuild --triple arm64-apple-ios --toolset "$B/toolset-swb.json" \
        -c release --product ExpoModulesJSI -Xcc -I$inc -Xcxx -I$inc \
        -Xswiftc -enable-experimental-feature -Xswiftc AssumeResilientCxxTypes \
        -Xlinker -install_name -Xlinker @rpath/ExpoModulesJSI.framework/ExpoModulesJSI 2>&1 \
      | grep -E 'error|warning: unable|Compiling|Build complete' | tail -20)
    mkdir -p "$jsi"
    bash "$repo/scripts/pack-jsi-xcframework.sh" "$src" "$jsi"
  fi
  ln -s "$jsi/ExpoModulesJSI.xcframework" "$dest/ExpoModulesJSI.xcframework"
fi
ls "$dest" | tr '\n' ' '; echo
