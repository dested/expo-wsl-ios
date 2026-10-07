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
