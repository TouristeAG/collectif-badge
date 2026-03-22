/**
 * Data field names your Canva Brand template must define (Data autofill app).
 * Case-sensitive — use exactly these names when binding frames in Canva.
 *
 * @see docs/CANVA_BRAND_TEMPLATE.md
 */
export const CANVA_TEXT_FIELDS = {
  FIRST_NAME: "CB_FIRST_NAME",
  LAST_NAME: "CB_LAST_NAME",
  ROLE: "CB_ROLE",
  ORG: "CB_ORG",
} as const;

export const CANVA_IMAGE_FIELDS = {
  LOGO: "CB_LOGO",
  QR_VCARD: "CB_QR_VCARD",
  NFC: "CB_NFC",
  QR_EVENT: "CB_QR_EVENT",
  PHOTO: "CB_PHOTO",
} as const;

export type CanvaTextFieldKey = keyof typeof CANVA_TEXT_FIELDS;
export type CanvaImageFieldKey = keyof typeof CANVA_IMAGE_FIELDS;
