#!/bin/zsh
# Ad-hoc signs the installed COLLECTIF BADGE app and adds it to the macOS
# Application Firewall so that "Partage réseau local" can accept LAN connections.
#
# Usage:
#   sudo zsh "/Applications/COLLECTIF BADGE.app/Contents/Resources/scripts/sign-and-allow.sh"
#
# Run this once after (re-)installing the app from the DMG.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_FROM_BUNDLE="${SCRIPT_DIR%/Contents/Resources/scripts}"
APP_DEFAULT="/Applications/COLLECTIF BADGE.app"
APP="$APP_DEFAULT"

if [[ "$SCRIPT_DIR" == *"/Contents/Resources/scripts" ]] && [ -d "$APP_FROM_BUNDLE" ]; then
  APP="$APP_FROM_BUNDLE"
fi

FIREWALL="/usr/libexec/ApplicationFirewall/socketfilterfw"

if [ ! -d "$APP" ]; then
  echo "Error: '$APP' not found."
  echo "Make sure COLLECTIF BADGE.app is installed in /Applications."
  exit 1
fi

echo "==> Ad-hoc signing $APP …"
codesign --deep --force -s - "$APP"
echo "    Done."

echo ""
echo "==> Adding to Application Firewall …"
"$FIREWALL" --add "$APP"
"$FIREWALL" --unblockapp "$APP"
echo "    Done."

echo ""
echo "==> Restarting Application Firewall …"
launchctl stop  com.apple.alf.agent 2>/dev/null || true
launchctl start com.apple.alf.agent 2>/dev/null || true
echo "    Done."

echo ""
echo "All set. Launch COLLECTIF BADGE and try 'Partage réseau local' again."
