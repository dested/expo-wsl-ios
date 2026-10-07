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

# Bun runs the generator from its TypeScript source, in the repo and in the published package.
gen_cli="$pkg/src/expo2spm/cli.ts"

echo "== frameworks =="
bash "$pkg/scripts/frameworks.sh" "$app/node_modules" "$fw" debug

echo "== expo2spm =="
bun "$gen_cli" --app "$app" --gen "$gen" --out "$out" --fw "$fw" --name "$name" --bundle-id "$bid" --exclude "$exclude"

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

echo "== sign =="
EXPO_WSL_IOS_UDID=$udid bash "$pkg/scripts/dev-sign.sh" "$bundle" "$ipa"
