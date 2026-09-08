# Collectif Badge Manager (Desktop)

Cross-platform desktop app (macOS + Windows) companion to **NoctuList**:
- Sync volunteers / guests from **Firebase** (recommended) or **Google Sheets**
- Design double-sided badges (cover + back with NanoID QR)
- Use NoctuList **profile photos** by default (Firebase), with optional local upload override
- Export PNG / PDF / Canva / Badgy Studio

## Stack

- Electron (desktop shell)
- React + TypeScript (UI)
- Google Sheets API (read-only, via service account) — legacy backend
- Firebase Auth + Firestore + Storage (join QR + Google Sign-In) — NoctuList 2.x backend

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start the desktop app in dev mode:

```bash
npm run dev
```

3. Choose a people source:

### Firebase (NoctuList)

1. In NoctuList Admin, show the organization **join QR** (`noctulist-fb:1:…`).
2. In Collectif Badgé, pick **Firebase**, paste or scan that code, then **Sign in with Google**.
3. After Google Sign-In, click **Reload** (bottom right) to refresh the roster from Firebase.
4. Open **Badge illustrator** — profile photos load from Storage when available; you can still upload a local override.

Authorized redirect URIs on the institution Web OAuth client should include:
`http://localhost:8889/Callback`, `8888`, `8765`, `9090`, and `8890`.

### Google Sheets (legacy)

1. Enter your Spreadsheet ID
2. Import your service account JSON key
3. Confirm/adjust sheet tab names
4. Click **Refresh from Sheets**
5. Select a person, then open **Badge illustrator**

Badge back QR encodes the plain **NanoID** (same as NoctuList door scanning / Lightspeed). Do not print device join QRs on badges.

## Badge cover & venue logos (bundled)

Cover and back-side venue masks are **imported from source** (not `public/`) so they ship in the app bundle:

- `src/assets/logo/collectifnocturne.png` — front cover + Collectif mask
- `src/assets/logo/legroove-logo.png` — Le Groove mask
- `src/assets/logo/logo_terreau.png` — Le Terreau mask

Replace those files and rebuild; overlay positioning stays the same for:

- QR vCard (top-right)
- NFC mark (bottom-right)

## Expected Google Sheets Tabs

Default tab names are based on your Android `EventManagerApp`:

- `Volunteers` (`A2:K`)
- `Guest List` (`A2:I`)
- `Volunteer Guest List` (`A2:H`)
- `Temp Guest List` (`A2:F`)

You can override names directly in the app UI.

## Send to Canva (Connect API + Autofill)

The app fills a **Canva brand template** using the [Autofill](https://www.canva.dev/docs/connect/autofill-guide/) API so **text and images are native, editable elements** in Canva (not a single flattened PDF/JPG). You design the layout once in Canva (fonts, positions, frames); this app sends strings and PNGs for each **data field** name.

**With a brand template ID:** the app uses **Autofill** so text and images are editable in Canva (see `docs/CANVA_BRAND_TEMPLATE.md`; typically **Canva Enterprise** or approved dev access).

**Without a brand template ID:** the app falls back to **importing a 2‑page PDF** (same as the PDF export — flattened front + back). Canva treats it as an imported design, not separate data fields.

### One-time setup

**Open Canva settings in the app:** click the **gear icon** in the main header, to the **left** of the blue **Refresh from Sheets** button. The modal walks through the same steps below.

1. **Developer Portal:** create a **Connect API** integration in the [Canva Developer Portal](https://www.canva.com/developers/integrations/connect-api).
2. **Redirect URL:** in the integration’s authentication settings, add this **exact** URL (OAuth will not work otherwise):

   `http://127.0.0.1:32887/canva/oauth/callback`

   The app listens on **127.0.0.1:32887** only while you click “Connect to Canva”. Keep that port free.
3. **Scopes:** enable **`design:content:write`**, **`design:meta:read`**, **`brandtemplate:meta:read`**, **`brandtemplate:content:read`**, **`asset:read`**, **`asset:write`**. Save the integration. After changing scopes, **Disconnect** then **Connect to Canva** again.
4. **Credentials:** copy **Client ID** and **Client secret** from the portal, then in the app use **Save credentials & template ID** (or set `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET` when launching Electron).
5. **Brand template ID:** publish your template and paste its ID (see `docs/CANVA_BRAND_TEMPLATE.md`), or set `CANVA_BRAND_TEMPLATE_ID`.
6. **Sign in:** **Connect to Canva** — approve in the browser; you should see “Connected” in the app status.
7. **Export:** **Badge illustrator → Export badge → Send to Canva (editable layers)** — the browser opens the new design.

**MFA:** If you don’t see MFA options in your Canva account settings, try **resetting your password** in Canva’s account settings — MFA controls often appear afterward so you can enable two-factor authentication.

Tokens are stored under the app user data folder; the client secret never ships to the renderer.

## Build

Create web build:

```bash
npm run build:web
```

## Future web integration (ready path)

The UI now supports two data modes:

- **Desktop (Electron):** import Service Account JSON into app storage, then refresh from Sheets.
- **Web app (HTTP API):** set a **Web API URL** in the UI. The browser calls your backend instead of Electron APIs.

Recommended backend contract for web mode:

- `GET /sheets/status` → `{ configured: boolean, clientEmail?: string }`
- `POST /sheets/loadPeople` with `{ spreadsheetId, sheetNames }` → same shape as `PeopleResponse` in `src/types.ts`

Security note: for web mode, keep Google credentials on the backend only (never in browser localStorage).

### Run web mode locally

1. Export credentials as JSON string (backend only):

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

2. (Optional) Restrict allowed spreadsheet IDs:

```bash
export SHEETS_SPREADSHEET_ALLOWLIST="1AbCd...,1XyZ..."
```

3. Start frontend + web API:

```bash
npm run dev:webapp
```

4. In the web UI:
   - Set **Web API URL** to `http://127.0.0.1:8787`
   - Enter spreadsheet ID
   - Click **Refresh from Sheets**

Create desktop installers:

```bash
npm run build
```

- macOS: `CollectifBadge-<version>-arm64.dmg` and `-x64.dmg`
- Windows: `CollectifBadge-<version>-x64.exe`

## Release (all platforms)

Same idea as NoctuList: bump `version.json`, commit to `main`, push a version tag. GitHub Actions builds macOS + Windows and publishes the GitHub Release.

See [`.github/PUBLISHING.md`](.github/PUBLISHING.md).

```bash
npm run sync:version
git add version.json package.json package-lock.json
git commit -m "chore: bump to 1.5.0"
git push origin main
git tag 1.5.0
git push origin 1.5.0
```
