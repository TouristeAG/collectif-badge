# Collectif Badge Manager (Desktop)

Cross-platform desktop app (macOS + Windows) to read Google Sheets and display:
- Volunteers
- Permanent guests
- Volunteer guests
- Temporary guests

This is the first milestone: clean sync + aesthetic list UI + person selection.
Badge illustration generation for the front cover is now included.
Evolis Badgy 200 printing flow comes next.

## Stack

- Electron (desktop shell)
- React + TypeScript (UI)
- Google Sheets API (read-only, via service account)

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start the desktop app in dev mode:

```bash
npm run dev
```

3. In the app:
   - Enter your Spreadsheet ID
   - Select your service account JSON key file
   - Confirm/adjust sheet tab names
   - Click **Refresh from Sheets**
   - Select a person, then open **Badge illustrator**

## Badge Cover Asset

The front cover uses a fixed image from:

- `public/LOGO/logo-cover.png`

You can replace this file with your final official cover design and the app will keep the same
overlay positioning logic for:

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

Create desktop installers:

```bash
npm run build
```

- macOS target: `dmg`
- Windows target: `nsis`
