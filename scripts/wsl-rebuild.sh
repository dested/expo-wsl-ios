#!/usr/bin/env bash
# Dev loop for the generator itself: rerun expo2spm + xtool on an existing prep dir, no Windows prep.
# usage: wsl-rebuild.sh <app dir> <prep dir (app/.expo/wsl-ios/prep)> <ProductName> <bundle id> [exclude,csv]
set -euo pipefail
export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
ulimit -n 65536 || true
app=$1; gen=$2; name=$3; bid=$4; exclude=${5:-}
repo=$(cd "$(dirname "$0")/.." && pwd)
out="$HOME/build/$(basename "$app")"
(cd "$repo" && bun src/expo2spm/cli.ts --app "$app" --gen "$gen" --out "$out" --fw "$out/.fw" \
  --name "$name" --bundle-id "$bid" --exclude "$exclude" | tail -12)
cd "$out"
start=$(date +%s)
set +e; xtool dev build > build.log 2>&1; code=$?; set -e
echo "xtool: exit $code in $(( $(date +%s) - start )) s"
sed 's/\x1b\[[0-9;]*m//g' build.log | grep -E 'error:' | sort | uniq -c | sort -rn | cut -c1-300 | head -30 || true
exit $code
