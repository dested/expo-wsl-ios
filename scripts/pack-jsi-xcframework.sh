#!/usr/bin/env bash
# Wrap the SwiftBuild output of ExpoModulesJSI as ExpoModulesJSI.xcframework (ios-arm64 only),
# mirroring expo-modules-jsi/apple/scripts/build-xcframework.sh's layout.
# usage: pack-jsi-xcframework.sh <jsi package dir (built)> <dest dir>
set -euo pipefail
src=$1; dest=$2
name=ExpoModulesJSI
out="$src/.build/out"
objs="$out/Intermediates.noindex/$name.build/Release-iphoneos/$name-t.build/Objects-normal/arm64"
xcf="$dest/$name.xcframework"
fw="$xcf/ios-arm64/$name.framework"
rm -rf "$xcf"; mkdir -p "$fw/Headers" "$fw/Modules/$name.swiftmodule"

cp "$out/Products/Release-iphoneos/lib$name.dylib" "$fw/$name"
for ext in swiftdoc abi.json; do cp "$out/Products/Release-iphoneos/$name.swiftmodule/arm64-apple-ios.$ext" "$fw/Modules/$name.swiftmodule/"; done
# Public interface only, with the declarations consumers can't resolve stripped (Expo's sed, widened:
# Swift 6.4 prints module selectors, `extension __ObjC::expo.__ObjC::CppError`, where 6.3 printed dots).
sed '/^extension __ObjC\(\.\|::\)/,/^}/d;/^@usableFromInline$/{N;/_ConstraintThatIsNotPartOfTheAPIOfThisLibrary/d;};/_ConstraintThatIsNotPartOfTheAPIOfThisLibrary/d' \
  "$objs/$name.swiftinterface" > "$fw/Modules/$name.swiftmodule/arm64-apple-ios.swiftinterface"

cp "$out/Intermediates.noindex/GeneratedModuleMaps-iphoneos/$name-Swift.h" "$fw/Headers/"
pub="$src/Sources/$name-Cxx/include/Public"
headers=$(cd "$pub" && ls *.h)
cp "$pub"/*.h "$fw/Headers/"
{
  echo "module $name {"
  echo "  header \"$name-Swift.h\""
  echo "  export *"
  echo ""
  echo "  explicit module Cxx {"
  echo "    requires cplusplus"
  for h in $headers; do echo "    header \"$h\""; done
  echo "    export *"
  echo "  }"
  echo "}"
} > "$fw/Headers/module.modulemap"

python3 - "$fw/Info.plist" "$xcf/Info.plist" "$name" <<'PY'
import plistlib, sys
fw_plist, xcf_plist, name = sys.argv[1:]
plistlib.dump({
    "CFBundleDevelopmentRegion": "en", "CFBundleExecutable": name,
    "CFBundleIdentifier": f"host.exp.{name}", "CFBundleInfoDictionaryVersion": "6.0",
    "CFBundleName": name, "CFBundlePackageType": "FMWK", "CFBundleShortVersionString": "1.0",
    "CFBundleVersion": "1", "CFBundleSupportedPlatforms": ["iPhoneOS"], "MinimumOSVersion": "16.4",
}, open(fw_plist, "wb"))
plistlib.dump({
    "AvailableLibraries": [{
        "BinaryPath": f"{name}.framework/{name}", "LibraryIdentifier": "ios-arm64",
        "LibraryPath": f"{name}.framework", "SupportedArchitectures": ["arm64"],
        "SupportedPlatform": "ios",
    }],
    "CFBundlePackageType": "XFWK", "XCFrameworkFormatVersion": "1.0",
}, open(xcf_plist, "wb"))
PY
find "$xcf" -type f | sed "s|$dest/||"
