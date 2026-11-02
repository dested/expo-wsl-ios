#!/usr/bin/env bash
# WSL half of `expo-wsl-ios run`: framework cache -> expo2spm -> xtool dev build -> dev-sign -> .ipa.
# usage: wsl-build.sh <app dir> <prep dir> <ProductName> <bundle id> <udid> <exclude,csv> <out.ipa>
set -euo pipefail
export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
ulimit -n 65536 || true
app=$1; gen=$2; name=$3; bid=$4; udid=$5; exclude=$6; ipa=$7
pkg=$(cd "$(dirname "$0")/.." && pwd)
out="$HOME/build/$(basename "$app")"
fw="$out/.fw"
mkdir -p "$out"

# Node's lookup: the nearest node_modules above the app that holds react-native. In a hoisted
# monorepo (Bun/Yarn/npm workspaces) that's the workspace root's, not the app's.
nm=$app
until [ -f "$nm/node_modules/react-native/package.json" ]; do
  [ "$nm" = / ] && { echo "no node_modules/react-native in $app or above it: run your package manager's install" >&2; exit 1; }
  nm=$(dirname "$nm")
done
nm="$nm/node_modules"

# Bun runs the generator from its TypeScript source, in the repo and in the published package.
gen_cli="$pkg/src/expo2spm/cli.ts"

echo "== frameworks =="
bash "$pkg/scripts/frameworks.sh" "$nm" "$fw" debug

echo "== expo2spm =="
bun "$gen_cli" --app "$app" --node-modules "$nm" --gen "$gen" --out "$out" --fw "$fw" --name "$name" --bundle-id "$bid" --exclude "$exclude"

echo "== xtool dev build (log: $out/build.log) =="
cd "$out"
start=$(date +%s)
set +e
xtool dev build > build.log 2>&1
code=$?
set -e
if [ $code -ne 0 ]; then
  echo "xtool dev build failed ($code). First errors:" >&2
  sed 's/\x1b\[[0-9;]*m//g' build.log | grep -E 'error:' | sort -u | head -30 >&2 || true
  echo "full log: $out/build.log (in the WSL distro)" >&2
  exit $code
fi
echo "   built in $(( $(date +%s) - start )) s"
bundle=$(ls -d xtool/*.app | head -n1)

assets="$gen/native-assets"
min_ios=$(cat deployment-target)
oad="$HOME/omarchy-apple-dev"
actool=
if [ -d "$oad/tools/darwin-tools/.build" ]; then
  actool=$(find "$oad/tools/darwin-tools/.build" -type f -name actool -perm /111 -print -quit)
fi
ibtool="$oad/tools/ibtool"
if [ -d "$assets/Assets.xcassets" ]; then
  [ -x "$actool" ] || { echo "actool missing from $oad/tools/darwin-tools/.build" >&2; exit 1; }
  echo "== compile app icon + image assets =="
  icon_args=()
  has_icon=$("$HOME/pymobile3-venv/bin/python" -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("appIcon") else "0")' "$gen/native-assets.json")
  [ "$has_icon" = 1 ] && [ -d "$assets/Assets.xcassets/AppIcon.appiconset" ] && icon_args=(--app-icon AppIcon)
  "$actool" --compile "$bundle" --platform iphoneos --target-device iphone --target-device ipad \
    --minimum-deployment-target "$min_ios" "${icon_args[@]}" \
    --output-partial-info-plist "$out/actool-info.plist" "$assets/Assets.xcassets"
  "$HOME/pymobile3-venv/bin/python" - "$bundle/Info.plist" "$out/actool-info.plist" <<'PY'
import plistlib, sys
app_path, partial_path = sys.argv[1:]
with open(app_path, 'rb') as f:
    app = plistlib.load(f)
with open(partial_path, 'rb') as f:
    partial = plistlib.load(f)
for key in ('CFBundleIcons', 'CFBundleIcons~ipad'):
    if key in partial:
        app[key] = partial[key]
with open(app_path, 'wb') as f:
    plistlib.dump(app, f, fmt=plistlib.FMT_XML, sort_keys=False)
PY
fi
if [ -f "$assets/SplashScreen.storyboard" ]; then
  [ -x "$ibtool" ] || { echo "ibtool missing at $ibtool" >&2; exit 1; }
  echo "== compile splash storyboard =="
  ib_storyboard="$out/SplashScreen.storyboard"
  python3 - "$assets/SplashScreen.storyboard" "$ib_storyboard" <<'PY'
import re, sys
source = open(sys.argv[1], encoding='utf-8').read()
# The distro ibtool uses device IDs to size simulated previews. A launch storyboard
# has explicit frames and Auto Layout constraints, so drop this Xcode-only annotation.
source = re.sub(r'(?m)^[ \t]*<device\b[^>]*/>[ \t]*\r?\n?', '', source, count=1)
open(sys.argv[2], 'w', encoding='utf-8').write(source)
PY
  "$ibtool" --minimum-deployment-target "$min_ios" "$ib_storyboard" \
    --compilation-directory "$bundle"
fi

# Every @rpath framework the app or an embedded framework links must be embedded too; otherwise
# dyld kills the app at launch ("Library not loaded") and the phone shows nothing useful.
missing=$(for bin in "$bundle/$name" "$bundle"/Frameworks/*.framework; do
  [ -d "$bin" ] && bin="$bin/$(basename "$bin" .framework)"
  llvm-objdump --macho --dylibs-used "$bin" | sed -n 's|^[[:space:]]*@rpath/\([^/]*\.framework\)/.*|\1|p'
done | sort -u | while read -r f; do [ -e "$bundle/Frameworks/$f" ] || echo "$f"; done)
if [ -n "$missing" ]; then
  echo "the app links frameworks that aren't embedded, so it would crash at launch:" >&2
  echo "$missing" | sed 's/^/  /' >&2
  exit 1
fi

echo "== sign =="
EXPO_WSL_IOS_UDID=$udid bash "$pkg/scripts/dev-sign.sh" "$bundle" "$ipa"
