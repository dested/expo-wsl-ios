#!/usr/bin/env bash
# Development-sign an .app for one device through the App Store Connect API, then package an .ipa.
# usage: dev-sign.sh <path/to/App.app> <out.ipa>
# env:   EXPO_WSL_IOS_UDID (device). The App Store Connect key lives in ~/.config/expo-wsl-ios
#        (asc.env + AuthKey_<id>.p8, written by `expo-wsl-ios setup`), or ASC_KEY_ID /
#        ASC_ISSUER_ID / ASC_KEY_PATH in the environment.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
app=$(realpath "$1"); ipa=$(realpath -m "$2")
oad="$HOME/omarchy-apple-dev"
py="$HOME/pymobile3-venv/bin/python"
udid="${EXPO_WSL_IOS_UDID:?set EXPO_WSL_IOS_UDID}"
conf="$HOME/.config/expo-wsl-ios"
if [ -z "${ASC_KEY_ID:-}" ]; then
  [ -f "$conf/asc.env" ] || { echo "no App Store Connect key: run expo-wsl-ios setup --asc-key ..." >&2; exit 1; }
  export ASC_KEY_ID=$(sed -n 's/^ASC_KEY_ID=//p' "$conf/asc.env")
  export ASC_ISSUER_ID=$(sed -n 's/^ASC_ISSUER_ID=//p' "$conf/asc.env")
  export ASC_KEY_PATH="$conf/AuthKey_$ASC_KEY_ID.p8"
fi
# Development certificate (private key) and per-bundle profiles, created through the API on first use.
dev="$conf/dev"

bundle_id=$("$py" -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["CFBundleIdentifier"])' "$app/Info.plist")
echo "== provision $bundle_id for $udid =="
"$py" "$oad/tools/provision-dev.py" --bundle-id "$bundle_id" --udid "$udid" --name "expo-wsl-ios device" --out "$dev"

prov="$dev/$bundle_id.mobileprovision"
cp "$prov" "$app/embedded.mobileprovision"
ent=$(mktemp --suffix=.plist)
"$py" - "$prov" "$ent" <<'PY'
import plistlib, sys
raw = open(sys.argv[1], "rb").read()
payload = plistlib.loads(raw[raw.index(b"<?xml"):raw.index(b"</plist>") + len(b"</plist>")])
granted = payload["Entitlements"]
ent = {k: granted[k] for k in ("application-identifier", "com.apple.developer.team-identifier",
                               "keychain-access-groups", "get-task-allow") if k in granted}
plistlib.dump(ent, open(sys.argv[2], "wb"))
print("entitlements:", ", ".join(f"{k}={v}" for k, v in ent.items()))
PY
team=$("$py" -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["com.apple.developer.team-identifier"])' "$ent")
"$py" "$oad/tools/fill-team-prefix.py" --team "$team" "$app"

echo "== sign (inside-out) =="
sign=(--pem-file "$dev/key.pem" --certificate-der-file "$dev/cert.der" --team-name "$team")
shopt -s nullglob
# rcodesign is chatty; show its output only when it fails.
quiet() { local log; log=$("$@" 2>&1) || { echo "$log" >&2; return 1; }; }
for fw in "$app"/Frameworks/*.framework "$app"/Frameworks/*.dylib; do quiet rcodesign sign "${sign[@]}" "$fw"; done
shopt -u nullglob
quiet rcodesign sign "${sign[@]}" --entitlements-xml-file "$ent" "$app"
rcodesign verify "$app/$("$py" -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["CFBundleExecutable"])' "$app/Info.plist")" >/dev/null 2>&1 && echo "signature verifies"

echo "== package =="
stage=$(mktemp -d); mkdir "$stage/Payload"; cp -a "$app" "$stage/Payload/"
mkdir -p "$(dirname "$ipa")"; rm -f "$ipa"
(cd "$stage" && zip -qry "$ipa" Payload)
rm -rf "$stage" "$ent"
echo "ipa: $ipa ($(du -h "$ipa" | cut -f1))"
