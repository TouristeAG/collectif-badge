#!/bin/zsh
# Runs automatically after "npm run build" (postbuild hook).
# Ad-hoc signs every .app produced by electron-builder so that
# macOS Application Firewall can create a stable, permanent rule for it.
# Also removes the quarantine flag and registers the app with Gatekeeper
# so it can be launched from Finder without the "unidentified developer" block.
# Ad-hoc signing is free and requires no Apple Developer account.

setopt null_glob 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

sign_app() {
  local app_path="$1"
  if [ -d "$app_path" ]; then
    echo "Ad-hoc signing: $app_path"
    # Electron's darwin-x64 zip ships nested Mach-O binaries unsigned; sealing the .app requires
    # `--deep`. Explicit `--options runtime` pairs with entitlements (allow-jit, etc.) the same
    # way notarized Developer ID builds do — omitting it can yield odd JIT behavior on macOS 15.
    local entitlements="$ROOT/build/entitlements.mac.plist"
    local sign_args=(--deep --force -s - --options runtime)
    if [ -f "$entitlements" ]; then
      sign_args+=(--entitlements "$entitlements")
    fi
    if ! codesign "${sign_args[@]}" "$app_path"; then
      echo "  ERROR: codesign failed for $app_path (other architectures may still be OK)."
      return 1
    fi

    # Remove quarantine flag if present (set by browser downloads, AirDrop, etc.)
    xattr -rd com.apple.quarantine "$app_path" 2>/dev/null || true

    # Register with Gatekeeper (spctl) so macOS 15+ allows it to launch from Finder.
    # This is equivalent to "Open Anyway" in System Settings → Privacy & Security.
    # Falls back silently if spctl is unavailable or rejects unsigned ad-hoc builds.
    if spctl --add "$app_path" 2>/dev/null; then
      echo "  Registered with Gatekeeper."
    else
      echo "  Note: could not auto-register with Gatekeeper (may need manual 'Open Anyway')."
    fi
  fi
}

# electron-builder output directory (see package.json build.directories.output)
for dir in "$ROOT/release/mac" "$ROOT/release/mac-arm64" "$ROOT/release/mac-x64" "$ROOT/release/mac-universal"; do
  [ -d "$dir" ] || continue
  for app in "$dir"/*.app; do
    [ -d "$app" ] || continue
    sign_app "$app" || true
  done
done

echo "Ad-hoc signing complete."
