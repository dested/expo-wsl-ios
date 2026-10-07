#!/usr/bin/env bash
# Shrink the distro before export (as root): package caches, build trees, logs, history.
# usage: clean.sh [user]
set -euo pipefail
USER_NAME="${1:-expo}"
home="/home/$USER_NAME"
pacman -Scc --noconfirm >/dev/null
rm -rf "$home/.cache/yay" "$home/.cache/pip" "$home/.cache/org.swift.swiftpm" "$home/.cache/clang" \
  "$home"/.cache/omarchy-apple-dev/xtool-* "$home/.config/expo-wsl-ios" "$home/.bash_history" /root/.bash_history
rm -rf /tmp/* /var/tmp/* /var/log/journal/* /var/cache/pacman/pkg/*
du -sh /usr /home /var 2>/dev/null
echo "clean ok"
