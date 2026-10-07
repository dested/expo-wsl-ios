#!/usr/bin/env bash
# M1: SwiftUI template app built in WSL, dev-signed for the plugged-in phone, packaged to out/.
set -euo pipefail
export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$PATH"
ulimit -n 65536 || true
work="$HOME/work"; mkdir -p "$work" && cd "$work"
if [ ! -d HelloWslosx ]; then
  xtool new HelloWslosx --skip-setup
fi
cd HelloWslosx
sed -i 's/^bundleID:.*/bundleID: com.dested.wslosx.hello/' xtool.yml
cat xtool.yml
time xtool dev build
app=$(ls -d xtool/*.app | head -n1)
file "$app/$(basename "$app" .app)" || true
bash /mnt/g/code/wslosx/scripts/dev-sign.sh "$app" /mnt/g/code/wslosx/out/HelloWslosx.ipa
