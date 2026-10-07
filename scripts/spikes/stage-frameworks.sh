#!/usr/bin/env bash
# Extract the prebuilt RN core / deps / Hermes (Maven) and Expo (npm) xcframeworks into $1.
# usage: stage-frameworks.sh <dest> <app node_modules> [debug|release]
set -euo pipefail
dest=$1; nm=$2; flavor=${3:-debug}
maven=/mnt/g/code/wslosx/.cache/maven
rn=$(node -p "require('$nm/react-native/package.json').version")
hermes=$(sed -n 's/^HERMES_V1_VERSION_NAME=//p' "$nm/react-native/sdks/hermes-engine/version.properties")
mkdir -p "$dest"; cd "$dest"
tmp=$(mktemp -d)

tar -xzf "$maven/react-native-artifacts-$rn-reactnative-core-$flavor.tar.gz" -C "$tmp" 2>/dev/null
rm -rf React.xcframework && mv "$tmp/React.xcframework" .

tar -xzf "$maven/react-native-artifacts-$rn-reactnative-dependencies-$flavor.tar.gz" -C "$tmp" 2>/dev/null
rm -rf ReactNativeDependencies.xcframework
mv "$tmp/packages/react-native/third-party/ReactNativeDependencies.xcframework" .

tar -xzf "$maven/hermes-ios-$hermes-hermes-ios-$flavor.tar.gz" -C "$tmp" 2>/dev/null
rm -rf hermesvm.xcframework
mv "$tmp/destroot/Library/Frameworks/universal/hermesvm.xcframework" .
# The framework ships no headers; the hermes-engine pod maps destroot/include instead.
rm -rf hermes-headers && mv "$tmp/destroot/include" hermes-headers

# Expo packages that ship prebuilt tarballs in npm.
for t in "$nm"/*/prebuilds/output/"$flavor"/xcframeworks/*.tar.gz "$nm"/@*/*/prebuilds/output/"$flavor"/xcframeworks/*.tar.gz; do
  [ -f "$t" ] || continue
  name=$(basename "$t" .tar.gz)
  rm -rf "$name.xcframework"
  tar -xzf "$t" -C . 2>/dev/null
done
rm -rf "$tmp"
find . -name '._*' -delete
ls -d *.xcframework
