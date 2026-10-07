#!/usr/bin/env bash
# User-side toolchain in the expo-wsl-ios distro: omarchy-apple-dev (pinned, patched), bun, and
# everything that does not need Apple's SDK prebuilt, so `expo-wsl-ios setup` only adds the SDK.
# The SDK step is `XCODE_XIP=... install-toolchain.sh --repair`, run by `expo-wsl-ios setup`.
# usage (as the distro's user): toolchain.sh
set -euo pipefail
OAD_REPO=https://github.com/joshuaswarren/omarchy-apple-dev
OAD_SHA="${OAD_SHA:-2386da1289e4e8cd8fe850f81d4b7faf2c5d5002}"
OAD_DIR="$HOME/omarchy-apple-dev"
export PATH="/usr/lib/swift/usr/bin:$HOME/.local/bin:$PATH"

if [ ! -d "$OAD_DIR/.git" ]; then
  git clone "$OAD_REPO" "$OAD_DIR"
fi
git -C "$OAD_DIR" fetch --quiet origin
git -C "$OAD_DIR" checkout --quiet "$OAD_SHA"

cd "$OAD_DIR"
# Local fixes on top of the pinned commit (upstream candidates):
# 1. asc.py signs JWTs with exp = now + 1200, Apple's hard maximum; any clock skew ahead
#    of Apple's makes every call 401. Use 19 minutes.
sed -i 's/"exp": now + 1200,/"exp": now + 1140,/' tools/asc.py

yay -S --needed --noconfirm bun-bin

ulimit -n 65536 || true
# Without XCODE_XIP the installer does steps 1-5 and exits 1 at the SDK step, by design.
env -u XCODE_XIP ./install-toolchain.sh || true
for t in swift xtool rcodesign bun ruby rsync; do
  command -v "$t" >/dev/null || { echo "toolchain: $t missing after install" >&2; exit 1; }
done
[ -x "$HOME/pymobile3-venv/bin/python" ] || { echo "toolchain: pymobiledevice3 venv missing" >&2; exit 1; }

# install_darwin_tools patches three SwiftBuild xcspecs inside the toolchain, which pacman's
# swift-bin owns as root; the patch runs as the user and dies with EPERM.
for spec in SwiftBuild_SWBUniversalPlatform.bundle/CopyStringsFile.xcspec \
            SwiftBuild_SWBCore.bundle/CoreBuildSystem.xcspec \
            SwiftBuild_SWBCore.bundle/NativeBuildSystem.xcspec; do
  f="/usr/lib/swift/usr/share/pm/$spec"
  if [ -f "$f" ] && [ ! -w "$f" ]; then sudo chown "$USER:" "$f"; fi
done

# Prebuild what the SDK step compiles (actool, the OpenAppleMacros server) so that step only
# links them. Same source dirs and flags as install_darwin_tools / install_oam.
(cd tools/darwin-tools && swift build -c release --product actool >/dev/null)
oam_repo=$(sed -n 's/^OAM_REPO=//p' install-toolchain.sh)
oam_sha=$(sed -n 's/^OAM_SHA=//p' install-toolchain.sh)
oam="$HOME/.cache/omarchy-apple-dev/oam-$oam_sha"
if [ ! -d "$oam/.git" ]; then
  git init -q "$oam"
  git -C "$oam" fetch -q --depth 1 "$oam_repo" "$oam_sha"
  git -C "$oam" checkout -q FETCH_HEAD
fi
(cd "$oam" && swift build -c release --build-system native --static-swift-stdlib --product OpenAppleMacrosServer >/dev/null)
echo "toolchain ok"
