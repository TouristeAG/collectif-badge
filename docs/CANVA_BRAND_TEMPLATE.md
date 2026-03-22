# Canva brand template for Collectif Badge Manager

If you **save a brand template ID** in Settings, the app uses Canva’s **Brand template + Data autofill** API so each text and image becomes a **real, editable** element in Canva.

If you **leave the template ID empty**, **Send to Canva** instead imports the same **2‑page PDF** as a flattened design (no separate data fields).

## Requirements

- **Canva for Teams / Enterprise** (or developer access approved for Autofill — see [Autofill guide](https://www.canva.dev/docs/connect/autofill-guide/)).
- A **published brand template** with the **Data autofill** app, using the field names below **exactly** (case-sensitive).

## Steps in Canva

1. Create a design (e.g. **Custom size** — credit card **85.6 mm × 54 mm** or equivalent at 300 DPI: ~1011 × 638 px — or two pages: front + back).
2. Place **text boxes** and **image frames** where you want content. Style fonts and colours in Canva.
3. Open **Apps → Data autofill → Custom** and bind each placeholder to a **data field name** from the tables below.
4. [Publish as a brand template](https://www.canva.com/help/publish-team-template/).
5. Copy the **brand template ID** from the URL (`…/brand-templates/THIS_PART`).

## Required data field names

### Text (type: text)

| Field name      | Filled with                                      |
|----------------|---------------------------------------------------|
| `CB_FIRST_NAME` | Back first name (accent colour in app preview)  |
| `CB_LAST_NAME`  | Back last name                                    |
| `CB_ROLE`       | Vertical role label (e.g. BENEVOLE)               |
| `CB_ORG`        | Organization (from vCard / “Collectif Nocturne”) |

### Images (type: image)

| Field name       | Filled with                                                |
|-----------------|-------------------------------------------------------------|
| `CB_LOGO`       | Front cover logo image                                      |
| `CB_QR_VCARD`   | Front vCard QR (if enabled)                                 |
| `CB_NFC`        | Front NFC mark (if enabled)                               |
| `CB_QR_EVENT`   | Back EventManager QR (if enabled)                         |
| `CB_PHOTO`      | Profile photo (if set)                                    |

You can omit frames you don’t use; the app only sends fields it has content for. **Every name you bind in the template must match the table** or autofill will fail.

## Integration settings (Developer Portal)

Enable scopes:

- `design:content:write`
- `asset:read` and `asset:write` (image uploads)
- `brandtemplate:meta:read` and `brandtemplate:content:read`

Then **disconnect and connect again** in the app (gear icon) so the new scopes are granted.

## Layout

Positioning and typography are **defined in your Canva template**, not in this app. The app only supplies **text strings** and **PNG images** for each field.
