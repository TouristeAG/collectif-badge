# Release checklist — Collectif Badge

## TL;DR — release in 3 commands

```bash
# 1. Bump version.json (and sync package.json), commit, push
npm run sync:version
git add version.json package.json package-lock.json .github/release-notes/
git commit -m "chore: bump to 1.5.0"
git push origin main

# 2. Create & push the version tag
git tag 1.5.0
git push origin 1.5.0

# 3. That's it. GitHub Actions does the rest.
```

Pushing the tag triggers **`.github/workflows/release.yml`**, which:

- Builds **3 installers in parallel** (macOS arm64 DMG, macOS Intel DMG, Windows NSIS)
- Creates the **GitHub Release** with the tag and release notes
- Attaches every installer to the release

No manual uploads. No manual release creation.

Installed apps poll:

```
https://raw.githubusercontent.com/TouristeAG/collectif-badge/main/version.json
```

They only see the update once `version.json` is on `main`. Prefer committing the bump **before** (or with) the tag, then wait for CI to finish before announcing.

---

## Detailed checklist

### 1. Prepare the version bump

| File | Field | Example |
|------|--------|---------|
| [`version.json`](../version.json) | `version` | `1.5.0` |
| [`version.json`](../version.json) | `mandatory` | `false` unless you must force everyone |
| [`version.json`](../version.json) | `minRequiredVersion` | raise to block older builds |
| [`version.json`](../version.json) | `notes` | one-line summary (fallback if no notes file) |
| [`version.json`](../version.json) | download URLs | must match the 3 GitHub Release asset names |

Then:

```bash
npm run sync:version
```

This copies `version.json` → `package.json` so Electron and electron-builder match.

### 2. Write release notes (recommended)

Create `.github/release-notes/X.Y.Z.md`. If missing, CI uses `version.json.notes`.

See [release-notes/1.5.0.md](release-notes/1.5.0.md).

### 3. Tag & push

```bash
git tag 1.5.0
git push origin 1.5.0
```

Use **`1.5.0` without a `v` prefix** so GitHub asset URLs match `version.json`
(`…/releases/download/1.5.0/…`). A leading `v` is accepted by CI but then the
download URLs in `version.json` must use that same tag.

You can also run **Actions → Release — all platforms → Run workflow**.

### 4. Monitor the build

| Job | Runner | Role |
|-----|--------|------|
| macOS DMG (x64 + arm64) | `macos-latest` | Intel + Apple Silicon |
| Windows NSIS | `windows-latest` | `.exe` installer |
| **Publish GitHub Release** | `ubuntu-latest` | waits for both, then publishes |

Publish **fails** if any of the three files is missing.

### 5. Expected release assets

These names must match the URLs in `version.json`:

| File | Platform |
|------|----------|
| `CollectifBadge-X.Y.Z-arm64.dmg` | macOS Apple Silicon |
| `CollectifBadge-X.Y.Z-x64.dmg` | macOS Intel |
| `CollectifBadge-X.Y.Z-x64.exe` | Windows |

### 6. In-app update prompt

After `version.json` is on `main`, existing installs show the banner (or a blocking overlay if the update is mandatory). “Open update page” opens the OS-specific installer URL when present, otherwise `/releases/latest`.

macOS builds are **ad-hoc signed** in CI (not Developer ID / notarized). Users may need to right-click → Open the first time, or run the bundled `sign-and-allow.sh`.

---

## Individual platform builds (manual / debugging)

```bash
gh workflow run build.yml
```

Produces downloadable Actions artifacts only — **no GitHub Release**.

## Local builds

```bash
npm run sync:version
npm run build
# → release/CollectifBadge-X.Y.Z-arm64.dmg
# → release/CollectifBadge-X.Y.Z-x64.dmg   (on macOS)
# → release/CollectifBadge-X.Y.Z-x64.exe   (on Windows)
```

---

## Smoke test checklist (1.5)

- [ ] Firebase: scan/paste join QR, Google Sign-In, roster loads
- [ ] Reload button (bottom right) refreshes the roster
- [ ] Join code stays hidden after a QR scan
- [ ] Setup card can be collapsed
- [ ] Badge photo X / Y / Z sliders all move the photo
- [ ] Sheets backend still loads people
- [ ] Optional update banner appears on a 0.0.5 install
