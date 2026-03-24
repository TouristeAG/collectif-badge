#!/bin/zsh
# Adds the Node.js binary to macOS Application Firewall so that
# "npm run serve:webapp" (and dev:webapp) can accept LAN connections.
# Run once with: sudo zsh scripts/allow-firewall.sh

NODE_BIN="$(which node 2>/dev/null)"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Install Node.js first."
  exit 1
fi

FIREWALL="/usr/libexec/ApplicationFirewall/socketfilterfw"

echo "Adding $NODE_BIN to macOS Application Firewall …"
"$FIREWALL" --add "$NODE_BIN"
"$FIREWALL" --unblockapp "$NODE_BIN"

echo ""
echo "Done. Node.js is now allowed to accept incoming connections."
echo "You may need to restart your firewall for the change to take effect:"
echo "  sudo launchctl stop com.apple.alf.agent"
echo "  sudo launchctl start com.apple.alf.agent"
