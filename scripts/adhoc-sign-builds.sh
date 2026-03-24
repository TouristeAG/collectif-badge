#!/bin/zsh
# Runs automatically after "npm run build" (postbuild hook).
# Ad-hoc signs every .app produced by electron-builder so that
# macOS Application Firewall can create a stable, permanent rule for it.
# Ad-hoc signing is free and requires no Apple Developer account.

set -e

DIST="$(cd "$(dirname "$0")/.." && pwd)/dist"

sign_app() {
  local app_path="$1"
  if [ -d "$app_path" ]; then
    echo "Ad-hoc signing: $app_path"
    codesign --deep --force -s - "$app_path"
  fi
}

sign_app "$DIST/mac/COLLECTIF BADGE.app"
sign_app "$DIST/mac-arm64/COLLECTIF BADGE.app"

echo "Ad-hoc signing complete."
