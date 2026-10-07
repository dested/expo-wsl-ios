#!/usr/bin/env bash
# Root-side bootstrap of the expo-wsl-ios Arch distro: packages, the build user, wsl.conf, yay. Idempotent.
# usage (as root in the distro): bootstrap.sh [user]   (default user: expo)
set -euo pipefail
USER_NAME="${1:-expo}"

if [ ! -f /etc/pacman.d/gnupg/trustdb.gpg ]; then
  pacman-key --init
  pacman-key --populate archlinux
fi
pacman -Syu --noconfirm
# ruby runs the podspec evaluator, rsync stages frameworks, nodejs reads package versions.
pacman -S --needed --noconfirm sudo git base-devel which unzip zip python nodejs npm ruby rsync

if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -G wheel -s /bin/bash "$USER_NAME"
fi
# Single-user build VM: passwordless sudo so the installers run unattended.
echo '%wheel ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/10-wheel
chmod 440 /etc/sudoers.d/10-wheel

# Default user, systemd, and no Windows PATH: a Windows clang/node/swift ahead of
# the toolchain's breaks SDK builds.
cat > /etc/wsl.conf <<CONF
[user]
default=$USER_NAME
[boot]
systemd=true
[interop]
appendWindowsPath=false
CONF

if ! command -v yay >/dev/null 2>&1; then
  sudo -u "$USER_NAME" bash -c '
    set -e
    d=$(mktemp -d) && cd "$d"
    git clone --depth 1 https://aur.archlinux.org/yay-bin.git
    cd yay-bin && makepkg -si --noconfirm
    rm -rf "$d"'
fi
echo "bootstrap ok: user=$USER_NAME"
