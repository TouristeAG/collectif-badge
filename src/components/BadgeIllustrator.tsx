import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toJpeg, toPng, toSvg } from "html-to-image";
import { jsPDF } from "jspdf";
import JSZip from "jszip";
import QRCode from "qrcode";
import coverTemplateImage from "../assets/badge-cover-template.png";
import { BADGY_EMPTY_SQLITE_B64 } from "../assets/badgy-empty-sqlite";
import { CANVA_IMAGE_FIELDS, CANVA_TEXT_FIELDS } from "../canvaAutofillFields";
import type { PersonRecord } from "../types";
import type { VCardSettings } from "../badgeIllustratorVcardTypes";
import {
  FACTORY_ROLE_EDGE_CQW,
  ILLUSTRATOR_FACTORY_DEFAULTS,
  persistIllustratorPartial,
  readIllustratorDefaultsCached,
  resetIllustratorDefaultsStorageToFactory,
  type BadgePersonType,
} from "../badgeIllustratorDefaults";

interface BadgeIllustratorProps {
  person: PersonRecord;
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

type ExportFormat = "png" | "jpg" | "svg" | "pdf" | "bs" | "canva";

const PERSON_TYPE_OPTIONS: Array<{
  value: BadgePersonType;
  label: string;
  displayLabel: string;
  defaultAccent: string;
}> = [
  { value: "benevole", label: "Bénévole", displayLabel: "BENEVOLE", defaultAccent: "#ffd699" },
  { value: "salarie", label: "Salarié·e·x", displayLabel: "SALARIE·E·X", defaultAccent: "#e1a8f0" },
  { value: "invite", label: "Invité·e·x", displayLabel: "INVITE·E·X", defaultAccent: "#99daff" },
  { value: "externe", label: "Externe", displayLabel: "EXTERNE", defaultAccent: "#ff9999" },
  { value: "autre", label: "Autre", displayLabel: "AUTRE", defaultAccent: "#ff99d8" },
];

const CANVA_REF_SIZES: Record<string, number> = {
  BENEVOLE: 23.9,
  "SALARIE·E·X": 18.2,
  "INVITE·E·X": 20.2,
  // Match BENEVOLE column width (~23.9) so right-edge gap alignment does not pull text toward center.
  EXTERNE: 23.9,
  AUTRE: 24.5,
};
const CANVA_BASE_SCALE = 0.126;
const CANVA_REF = 20.8;

/** Pixel font size for vertical role label; derived synchronously from container height (no useEffect lag). */
function computeRoleTextFontSizePx(h: number, roleLabel: string, roleSizeAdjust: number): number {
  if (h <= 0) return 60;
  const canvaSize = CANVA_REF_SIZES[roleLabel];
  let basePx: number;
  if (canvaSize != null) {
    basePx = h * CANVA_BASE_SCALE * (canvaSize / CANVA_REF);
  } else {
    basePx = Math.max(6, Math.min(h / (roleLabel.length * 0.82), 55));
  }
  return basePx * (roleSizeAdjust / 100);
}
const EXPORT_CARD_WIDTH = 1712;
const EXPORT_CARD_HEIGHT = Math.round((EXPORT_CARD_WIDTH * 54) / 85.6);
const DESIGN_X_TO_CQW = 100 / EXPORT_CARD_WIDTH;
const DESIGN_Y_TO_CQH = 100 / EXPORT_CARD_HEIGHT;

interface SaveBinaryFileOptions {
  defaultFileName: string;
  filters: Array<{ name: string; extensions: string[] }>;
  dataBase64: string;
  openAfterSave?: boolean;
}

interface ElectronExportAPI {
  saveBinaryFile?: (payload: SaveBinaryFileOptions) => Promise<string | null>;
  canvaGetStatus?: () => Promise<{
    hasCredentials: boolean;
    connected: boolean;
    hasBrandTemplate: boolean;
    brandTemplateId: string | null;
  }>;
  canvaSendBadgeAutofill?: (payload: {
    brandTemplateId?: string;
    title: string;
    texts: Record<string, string>;
    imagesBase64: Record<string, string>;
  }) => Promise<{ editUrl: string }>;
  /** Fallback: flattened 2-page PDF import (no brand template). */
  canvaSendPdf?: (payload: { pdfBase64: string; title: string }) => Promise<{ editUrl: string }>;
}

function sanitizeFileName(value: string): string {
  const safe = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_");
  return safe || "badge";
}

function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.replace(/^data:.*?;base64,/, "");
}

async function captureCanvaFieldPng(
  root: HTMLElement | null,
  field: string,
  backgroundColor?: string
): Promise<string | null> {
  if (!root) return null;
  const el = root.querySelector(`[data-canva-field="${field}"]`) as HTMLElement | null;
  if (!el) return null;
  const dataUrl = await toPng(el, {
    pixelRatio: 2,
    cacheBust: true,
    ...(backgroundColor ? { backgroundColor } : {}),
  });
  return stripDataUrlPrefix(dataUrl);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not convert blob to base64."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected blob conversion output."));
        return;
      }
      resolve(stripDataUrlPrefix(result));
    };
    reader.readAsDataURL(blob);
  });
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function categoryRole(person: PersonRecord): string {
  switch (person.category) {
    case "volunteer":
      return "Volunteer";
    case "permanent_guest":
      return "Permanent guest";
    case "volunteer_guest":
      return "Volunteer guest";
    case "temporary_guest":
      return "Temporary guest";
    default:
      return "Guest";
  }
}

function splitName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length <= 1) {
    return { firstName: displayName.trim(), lastName: "" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function isValidHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{6})$/.test(value.trim());
}

// ── Badgy Studio (.bs) export helpers ─────────────────────────────────────────

function generateBsHexUID(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

function bsBase64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function buildBsInfoXml(uuid: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<document>\n\t<card>\n" +
    `\t\t<uuid type="QString">${uuid}</uuid>\n` +
    '\t\t<designLocked type="QString">false</designLocked>\n' +
    '\t\t<hybridSplitter type="QString">493;184</hybridSplitter>\n' +
    '\t\t<version type="QString">0.0.21</version>\n' +
    "\t</card>\n</document>"
  );
}

function buildBsEventsXml(): string {
  const ids = [
    "document_open", "document_close", "encoding_contactless", "encoding_contact",
    "item_create_imageDevice", "item_create_fingerprint", "item_create_signature",
    "item_edit_imageDevice", "item_edit_fingerprint", "item_edit_signature",
    "item_font_aboutToChange", "item_font_changed", "item_data_aboutToChange",
    "item_data_changed", "before_print", "after_print", "before_print_record",
    "after_print_record", "audit_successful_print",
  ];
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<events>\n' +
    ids.map((id) => `\t<event ID="${id}"/>`).join("\n") +
    "\n</events>"
  );
}

function buildBsLayoutsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<layouts>\n\t<layout ID="L1">\n' +
    '\t\t<document_layout_name type="QString">Layout 1</document_layout_name>\n' +
    "\t</layout>\n</layouts>"
  );
}

function buildBsBackgroundItem(
  uid: string,
  side: 4096 | 8192,
  binUUID: string,
  fileName: string
): string {
  return (
    `\t<item ID="${uid}">\n` +
    "\t\t<position>\n\t\t\t<pos2>\n" +
    '\t\t\t\t<x type="QString">8573</x>\n' +
    '\t\t\t\t<y type="QString">5398</y>\n' +
    "\t\t\t</pos2>\n\t\t\t<pos1>\n" +
    '\t\t\t\t<x type="QString">0</x>\n' +
    '\t\t\t\t<y type="QString">0</y>\n' +
    "\t\t\t</pos1>\n\t\t</position>\n" +
    "\t\t<info>\n" +
    '\t\t\t<designObject type="QString">background</designObject>\n' +
    "\t\t</info>\n" +
    "\t\t<fill>\n\t\t\t<type>\n\t\t\t\t<solid>\n" +
    '\t\t\t\t\t<color type="QString">#000000</color>\n' +
    "\t\t\t\t</solid>\n\t\t\t</type>\n\t\t</fill>\n" +
    "\t\t<font>\n" +
    '\t\t\t<color type="QString">#000000</color>\n' +
    "\t\t</font>\n" +
    "\t\t<item>\n" +
    `\t\t\t<side type="int">${side}</side>\n` +
    `\t\t\t<userID type="QString">ITEM.${uid}</userID>\n` +
    '\t\t\t<layout type="QString">L1</layout>\n' +
    '\t\t\t<protected type="QString">true</protected>\n' +
    '\t\t\t<layer type="int">1</layer>\n' +
    `\t\t\t<UID type="QString">${uid}</UID>\n` +
    "\t\t</item>\n" +
    "\t\t<line>\n" +
    '\t\t\t<color type="QString">#000000</color>\n' +
    "\t\t</line>\n" +
    "\t\t<clipping>\n" +
    '\t\t\t<shape type="QString">rectangle</shape>\n' +
    "\t\t</clipping>\n" +
    "\t\t<imageAcquisition>\n\t\t\t<transformations>\n\t\t\t\t<color>\n" +
    '\t\t\t\t\t<negative type="QString">false</negative>\n' +
    '\t\t\t\t\t<monochrome type="QString">false</monochrome>\n' +
    "\t\t\t\t</color>\n\t\t\t</transformations>\n\t\t</imageAcquisition>\n" +
    "\t\t<clipart>\n" +
    '\t\t\t<color type="QString">#000000</color>\n' +
    "\t\t</clipart>\n" +
    "\t\t<background>\n" +
    '\t\t\t<type type="QString">picture</type>\n' +
    "\t\t\t<type>\n\t\t\t\t<picture>\n" +
    '\t\t\t\t\t<canDistort type="QString">false</canDistort>\n' +
    `\t\t\t\t\t<data type="QByteArray">design/FILES/items/${uid}/background/type/picture/data/{${binUUID}}.bin</data>\n` +
    `\t\t\t\t\t<fileName type="QString">${fileName}</fileName>\n` +
    "\t\t\t\t</picture>\n\t\t\t</type>\n" +
    "\t\t\t<options>\n" +
    '\t\t\t\t<print type="QString">yes</print>\n' +
    "\t\t\t</options>\n" +
    "\t\t</background>\n" +
    "\t</item>"
  );
}

function buildBsItemsXml(
  frontUID: string, frontBinUUID: string,
  backUID: string, backBinUUID: string,
  baseName: string
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<items>\n' +
    buildBsBackgroundItem(frontUID, 4096, frontBinUUID, `${baseName}_front.png`) +
    "\n" +
    buildBsBackgroundItem(backUID, 8192, backBinUUID, `${baseName}_back.png`) +
    "\n</items>"
  );
}

function buildBsPrintXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<print>\n' +
    "\t<advanced>\n" +
    '\t\t<antialiasing type="QString">images</antialiasing>\n' +
    "\t</advanced>\n" +
    "\t<operations>\n" +
    '\t\t<magneticEncoding type="QString">false</magneticEncoding>\n' +
    '\t\t<contactEncoding type="QString">false</contactEncoding>\n' +
    '\t\t<printBack type="QString">true</printBack>\n' +
    '\t\t<contactlessEncoding type="QString">false</contactlessEncoding>\n' +
    "\t</operations>\n" +
    "\t<paper>\n" +
    '\t\t<name type="QString">CR80 (S1)</name>\n' +
    '\t\t<orientation type="QString">landscape</orientation>\n' +
    "\t</paper>\n" +
    "\t<printer>\n" +
    '\t\t<name type="QString">Badgy200</name>\n' +
    '\t\t<settings type="QVariantHash">\n\t\t\t<Badgy200 type="QVariantHash">\n' +
    '\t\t\t\t<rotatebackGuard type="QString">ROTATE_BACK_LANDSCAPE</rotatebackGuard>\n' +
    '\t\t\t\t<resolution type="QString">260,300</resolution>\n' +
    '\t\t\t\t<rotateback type="QString">false</rotateback>\n' +
    "\t\t\t</Badgy200>\n\t\t</settings>\n" +
    '\t\t<capabilities type="QVariantHash">\n\t\t\t<Badgy200 type="QVariantHash">\n' +
    '\t\t\t\t<print.printerCapabilities.duplex type="QString">false</print.printerCapabilities.duplex>\n' +
    '\t\t\t\t<print.printerCapabilities.PrinterModel type="QString">Badgy200</print.printerCapabilities.PrinterModel>\n' +
    '\t\t\t\t<print.printerCapabilities.resolution type="QString">260,300</print.printerCapabilities.resolution>\n' +
    '\t\t\t\t<print.printerCapabilities.copies type="QString">9999</print.printerCapabilities.copies>\n' +
    '\t\t\t\t<print.printerCapabilities.RibbonType type="QString">ymcko</print.printerCapabilities.RibbonType>\n' +
    '\t\t\t\t<print.printerCapabilities.colordevice type="QString">true</print.printerCapabilities.colordevice>\n' +
    '\t\t\t\t<print.printerCapabilities.collate type="QString">true</print.printerCapabilities.collate>\n' +
    '\t\t\t\t<print.printerCapabilities.Manufacturer type="QString">Evolis</print.printerCapabilities.Manufacturer>\n' +
    "\t\t\t</Badgy200>\n\t\t</capabilities>\n" +
    '\t\t<driverName type="QString">Badgy200</driverName>\n' +
    "\t</printer>\n" +
    "\t<properties>\n" +
    '\t\t<printMode type="QString">1</printMode>\n' +
    "\t</properties>\n" +
    "\t<model>\n\t\t<color>\n" +
    '\t\t\t<r type="QString">255</r>\n' +
    '\t\t\t<b type="QString">255</b>\n' +
    '\t\t\t<g type="QString">255</g>\n' +
    "\t\t</color>\n" +
    '\t\t<ID type="QString">cp1cr80</ID>\n' +
    '\t\t<colored type="QString">true</colored>\n' +
    "\t</model>\n</print>"
  );
}

function buildBsConnectionXml(
  dbDocUUID: string,
  dbDataUUID: string,
  imgSettingsDocUUID: string,
  imgSettingsDataUUID: string
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<connection>\n\t<connection>\n' +
    '\t\t<connector type="QString">SQLITE</connector>\n' +
    "\t\t<properties>\n" +
    '\t\t\t<SQLITE type="QVariantHash">\n' +
    `\t\t\t\t<dataSource type="QString">$INTERNAL$/{${dbDocUUID}}.sqlite</dataSource>\n` +
    `\t\t\t\t<dataSourceData type="QByteArray">database/connection/connection/properties/SQLITE/dataSourceData/{${dbDataUUID}}.sqlite</dataSourceData>\n` +
    "\t\t\t</SQLITE>\n" +
    '\t\t\t<imageSettings type="QVariantHash">\n' +
    `\t\t\t\t<dataSource type="QString">$INTERNAL$/{${imgSettingsDocUUID}}.nosql</dataSource>\n` +
    `\t\t\t\t<dataSourceData type="QByteArray">database/connection/connection/properties/imageSettings/dataSourceData/{${imgSettingsDataUUID}}.sqlite</dataSourceData>\n` +
    "\t\t\t</imageSettings>\n" +
    "\t\t</properties>\n" +
    '\t\t<dataSets>\n\t\t\t<SQLITE type="QVariantHash">\n' +
    '\t\t\t\t<list type="QString">defaultName0</list>\n' +
    '\t\t\t\t<count type="QString">1</count>\n' +
    '\t\t\t\t<active type="QString">0</active>\n' +
    '\t\t\t\t<defaultName0.name type="QString">defaultName0</defaultName0.name>\n' +
    '\t\t\t\t<defaultName0.id type="QString">0</defaultName0.id>\n' +
    '\t\t\t\t<defaultName0.mode type="QString">2</defaultName0.mode>\n' +
    '\t\t\t\t<defaultName0.configPage type="QString">0</defaultName0.configPage>\n' +
    '\t\t\t\t<defaultName0.model.selectedRow type="int">0</defaultName0.model.selectedRow>\n' +
    '\t\t\t\t<defaultName0.model.checkedRows type="QString">0</defaultName0.model.checkedRows>\n' +
    '\t\t\t\t<defaultName0.model.hiddenColumns type="QString">defaultTable.id</defaultName0.model.hiddenColumns>\n' +
    '\t\t\t\t<defaultName0.queryInfo.tables type="QString">defaultTable</defaultName0.queryInfo.tables>\n' +
    '\t\t\t\t<defaultName0.queryInfo.primaryKeys.defaultTable type="QString">id</defaultName0.queryInfo.primaryKeys.defaultTable>\n' +
    '\t\t\t\t<defaultName0.queryInfo.tableSelection.defaultTable type="QString">id,Texte1,Texte2,Image1,Code barre1,Texte3,Texte4,Texte5,Texte6,Text1,Image2</defaultName0.queryInfo.tableSelection.defaultTable>\n' +
    '\t\t\t\t<defaultName0.formInfo.form type="QString">basic</defaultName0.formInfo.form>\n' +
    '\t\t\t\t<defaultName0.formInfo.styleSheet type="QString">b&amp;w</defaultName0.formInfo.styleSheet>\n' +
    "\t\t\t</SQLITE>\n\t\t</dataSets>\n" +
    "\t</connection>\n</connection>"
  );
}

function buildBsEncodingXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<encoding/>';
}

function buildEventManagerQrPayload(person: PersonRecord): string {
  if (person.category === "temporary_guest") {
    // Temporary guests do not have QR actions in EventManagerApp.
    return "";
  }

  if (person.category === "volunteer") {
    return JSON.stringify({
      type: "volunteer",
      version: 1,
      id: person.eventManagerId?.trim() ?? "",
      sheetsId: String(person.rowNumber),
      name: person.displayName,
      abbr: person.abbreviation?.trim() ?? "",
    });
  }

  return JSON.stringify({
    type: "guest",
    version: 1,
    name: person.displayName,
    abbr: person.abbreviation?.trim() ?? "",
  });
}

function buildDefaultVCardSettings(person: PersonRecord): VCardSettings {
  const split = splitName(person.displayName);
  const firstName = split.firstName;
  const lastNameFromSheets = person.abbreviation?.trim() || split.lastName;
  const fullNameFromSheets = [firstName, lastNameFromSheets].filter(Boolean).join(" ").trim();
  const noteParts = [
    person.venue ? `Venue: ${person.venue}` : "",
    typeof person.invitations === "number" ? `Invitations: ${person.invitations}` : "",
    person.eventDate ? `Event date: ${person.eventDate}` : "",
    person.notes ? `Notes: ${person.notes}` : "",
  ].filter(Boolean);

  return {
    firstName: { enabled: true, value: firstName },
    lastName: { enabled: true, value: lastNameFromSheets },
    fullName: { enabled: true, value: fullNameFromSheets || person.displayName },
    organization: { enabled: true, value: "Collectif Nocturne" },
    role: { enabled: true, value: categoryRole(person) },
    email: { enabled: Boolean(person.email), value: person.email ?? "" },
    phone: { enabled: Boolean(person.phone), value: person.phone ?? "" },
    note: { enabled: noteParts.length > 0, value: noteParts.join(" | ") },
  };
}

function buildVCardString(settings: VCardSettings): string {
  const firstName = settings.firstName.enabled ? settings.firstName.value.trim() : "";
  const lastName = settings.lastName.enabled ? settings.lastName.value.trim() : "";
  const fullName = settings.fullName.enabled
    ? settings.fullName.value.trim()
    : [firstName, lastName].filter(Boolean).join(" ").trim();

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVCardValue(lastName)};${escapeVCardValue(firstName)};;;`,
    `FN:${escapeVCardValue(fullName)}`,
  ];

  if (settings.organization.enabled && settings.organization.value.trim()) {
    lines.push(`ORG:${escapeVCardValue(settings.organization.value.trim())}`);
  }
  if (settings.role.enabled && settings.role.value.trim()) {
    lines.push(`TITLE:${escapeVCardValue(settings.role.value.trim())}`);
  }
  if (settings.email.enabled && settings.email.value.trim()) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(settings.email.value.trim())}`);
  }
  if (settings.phone.enabled && settings.phone.value.trim()) {
    lines.push(`TEL;TYPE=CELL:${escapeVCardValue(settings.phone.value.trim())}`);
  }
  if (settings.note.enabled && settings.note.value.trim()) {
    lines.push(`NOTE:${escapeVCardValue(settings.note.value.trim())}`);
  }

  lines.push("END:VCARD");
  return lines.join("\n");
}

function NfcMark() {
  return (
    <svg viewBox="0 0 120 140" aria-label="NFC mark">
      <g fill="none" stroke="#ffffff" strokeWidth="8" strokeLinecap="round">
        <path d="M27 30 Q40 50 27 70" />
        <path d="M50 18 Q68 50 50 82" />
        <path d="M73 10 Q95 50 73 90" />
      </g>
      <text x="60" y="120" textAnchor="middle" fill="#ffffff" fontSize="24" fontWeight="700">
        NFC
      </text>
    </svg>
  );
}

function ToggleSwitch({ checked, onChange, label }: ToggleSwitchProps) {
  return (
    <label className="switch-row">
      <span className="ios-toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="ios-toggle-slider" />
      </span>
      <span>{label}</span>
    </label>
  );
}

function mergeVCardFromStored(base: VCardSettings, stored: Partial<VCardSettings> | undefined): VCardSettings {
  if (!stored) return base;
  const keys = Object.keys(base) as Array<keyof VCardSettings>;
  const out = { ...base };
  for (const k of keys) {
    const s = stored[k];
    if (s) {
      out[k] = { enabled: s.enabled, value: s.value };
    }
  }
  return out;
}

function SetAsDefaultButton({ onClick, label = "Set as default" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="btn-set-default" onClick={onClick}>
      {label}
    </button>
  );
}

export function BadgeIllustrator({ person }: BadgeIllustratorProps) {
  const [selectedSide, setSelectedSide] = useState<"front" | "back">("front");
  const [cardBackgroundColor, setCardBackgroundColor] = useState(() => readIllustratorDefaultsCached().cardBackgroundColor);

  // Front side state
  const [logoZoom, setLogoZoom] = useState(() => readIllustratorDefaultsCached().logoZoom);
  const [logoOffsetX, setLogoOffsetX] = useState(() => readIllustratorDefaultsCached().logoOffsetX);
  const [logoOffsetY, setLogoOffsetY] = useState(() => readIllustratorDefaultsCached().logoOffsetY);
  const [logoOffsetZ, setLogoOffsetZ] = useState(() => readIllustratorDefaultsCached().logoOffsetZ);
  const [showQrCode, setShowQrCode] = useState(() => readIllustratorDefaultsCached().showQrCode);
  const [showNfcMark, setShowNfcMark] = useState(() => readIllustratorDefaultsCached().showNfcMark);
  const [vCardSettings, setVCardSettings] = useState<VCardSettings>(() =>
    mergeVCardFromStored(buildDefaultVCardSettings(person), readIllustratorDefaultsCached().vCardSettings)
  );
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [coverImageSrc, setCoverImageSrc] = useState("/LOGO/collectifnocturne.png");

  const [qrTopPct, setQrTopPct] = useState(() => readIllustratorDefaultsCached().qrTopPct);
  const [qrRightPct, setQrRightPct] = useState(() => readIllustratorDefaultsCached().qrRightPct);
  const [qrWidthPct, setQrWidthPct] = useState(() => readIllustratorDefaultsCached().qrWidthPct);
  const [qrOffsetX, setQrOffsetX] = useState(() => readIllustratorDefaultsCached().qrOffsetX);
  const [qrOffsetY, setQrOffsetY] = useState(() => readIllustratorDefaultsCached().qrOffsetY);
  const [qrOffsetZ, setQrOffsetZ] = useState(() => readIllustratorDefaultsCached().qrOffsetZ);
  const [qrZoom, setQrZoom] = useState(() => readIllustratorDefaultsCached().qrZoom);

  const [nfcBottomPct, setNfcBottomPct] = useState(() => readIllustratorDefaultsCached().nfcBottomPct);
  const [nfcRightPct, setNfcRightPct] = useState(() => readIllustratorDefaultsCached().nfcRightPct);
  const [nfcWidthPct, setNfcWidthPct] = useState(() => readIllustratorDefaultsCached().nfcWidthPct);
  const [nfcOffsetX, setNfcOffsetX] = useState(() => readIllustratorDefaultsCached().nfcOffsetX);
  const [nfcOffsetY, setNfcOffsetY] = useState(() => readIllustratorDefaultsCached().nfcOffsetY);
  const [nfcOffsetZ, setNfcOffsetZ] = useState(() => readIllustratorDefaultsCached().nfcOffsetZ);
  const [nfcZoom, setNfcZoom] = useState(() => readIllustratorDefaultsCached().nfcZoom);

  // Back side state
  const [personType, setPersonType] = useState<BadgePersonType>(() => readIllustratorDefaultsCached().personType);
  const [customRoleLabel, setCustomRoleLabel] = useState(() => readIllustratorDefaultsCached().customRoleLabel);
  const [accentColor, setAccentColor] = useState(() => readIllustratorDefaultsCached().accentColor);
  const [secondaryColor, setSecondaryColor] = useState(() => readIllustratorDefaultsCached().secondaryColor);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState("");
  const [photoFrameShape, setPhotoFrameShape] = useState<"circle" | "rounded">(
    () => readIllustratorDefaultsCached().photoFrameShape
  );
  const [photoZoom, setPhotoZoom] = useState(() => readIllustratorDefaultsCached().photoZoom);
  const [photoOffsetX, setPhotoOffsetX] = useState(() => readIllustratorDefaultsCached().photoOffsetX);
  const [photoOffsetY, setPhotoOffsetY] = useState(() => readIllustratorDefaultsCached().photoOffsetY);
  const [photoRotation, setPhotoRotation] = useState(() => readIllustratorDefaultsCached().photoRotation);
  const [backFirstName, setBackFirstName] = useState(() => splitName(person.displayName).firstName);
  const [backLastName, setBackLastName] = useState(
    () => person.abbreviation?.trim() || splitName(person.displayName).lastName
  );
  const [showBackQr, setShowBackQr] = useState(() => readIllustratorDefaultsCached().showBackQr);
  const [backQrDataUrl, setBackQrDataUrl] = useState("");
  const [roleSizeAdjust, setRoleSizeAdjust] = useState(() => readIllustratorDefaultsCached().roleSizeAdjust);
  const [roleEdgeAdjustCqwByType, setRoleEdgeAdjustCqwByType] = useState<Record<BadgePersonType, number>>(() => ({
    ...FACTORY_ROLE_EDGE_CQW,
    ...readIllustratorDefaultsCached().roleEdgeAdjustCqwByType,
  }));
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [defaultsHint, setDefaultsHint] = useState("");

  // Refs
  const roleTextContainerRef = useRef<HTMLDivElement>(null);
  const [previewRoleContainerHeight, setPreviewRoleContainerHeight] = useState(0);
  const [exportRoleContainerHeight, setExportRoleContainerHeight] = useState(0);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoUrlRef = useRef("");
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const exportFrontRef = useRef<HTMLDivElement>(null);
  const exportBackRef = useRef<HTMLDivElement>(null);
  const previewCardRef = useRef<HTMLDivElement>(null);
  const roleLabelRef = useRef<HTMLSpanElement>(null);
  const exportBackRoleContainerRef = useRef<HTMLDivElement>(null);
  const exportBackRoleLabelRef = useRef<HTMLSpanElement>(null);
  const previewBenevoleRightGapRef = useRef<number | null>(null);
  const exportBenevoleRightGapRef = useRef<number | null>(null);
  const previewRoleOffsetXRef = useRef(0);
  const exportRoleOffsetXRef = useRef(0);
  const roleEdgeAdjustCqwByTypeRef = useRef<Record<BadgePersonType, number>>(FACTORY_ROLE_EDGE_CQW);
  const [previewRoleOffsetX, setPreviewRoleOffsetX] = useState(0);
  const [exportRoleOffsetX, setExportRoleOffsetX] = useState(0);

  // Derived values
  const safeCardBackgroundColor = isValidHexColor(cardBackgroundColor) ? cardBackgroundColor : "#1b1b1b";
  const safeAccentColor = isValidHexColor(accentColor) ? accentColor : "#ffd699";
  const safeSecondaryColor = isValidHexColor(secondaryColor) ? secondaryColor : "#ffffff";
  const logoScale = Math.max(0.2, logoZoom / 100);
  const logoOffsetXCqw = logoOffsetX * DESIGN_X_TO_CQW;
  const logoOffsetYCqh = logoOffsetY * DESIGN_Y_TO_CQH;
  const logoTransform = `translate(calc(-50% + ${logoOffsetXCqw}cqw), calc(-50% + ${logoOffsetYCqh}cqh)) scale(${logoScale}) rotate(${logoOffsetZ}deg)`;

  const qrOffsetXCqw = qrOffsetX * DESIGN_X_TO_CQW;
  const qrOffsetYCqh = qrOffsetY * DESIGN_Y_TO_CQH;
  const nfcOffsetXCqw = nfcOffsetX * DESIGN_X_TO_CQW;
  const nfcOffsetYCqh = nfcOffsetY * DESIGN_Y_TO_CQH;
  const qrImgStyleTransform = `translate(${qrOffsetXCqw}cqw, ${qrOffsetYCqh}cqh) scale(${Math.max(0.05, qrZoom / 100)}) rotate(${qrOffsetZ}deg)`;
  const nfcBlockTransform = `translate(${nfcOffsetXCqw}cqw, ${nfcOffsetYCqh}cqh) scale(${Math.max(0.05, nfcZoom / 100)}) rotate(${nfcOffsetZ}deg)`;

  const roleLabel = useMemo(() => {
    if (personType === "autre") return (customRoleLabel || "AUTRE").toUpperCase();
    return PERSON_TYPE_OPTIONS.find((o) => o.value === personType)?.displayLabel || "BENEVOLE";
  }, [personType, customRoleLabel]);

  const previewRoleTextFontSize = useMemo(
    () => computeRoleTextFontSizePx(previewRoleContainerHeight, roleLabel, roleSizeAdjust),
    [previewRoleContainerHeight, roleLabel, roleSizeAdjust]
  );
  const exportRoleTextFontSize = useMemo(
    () => computeRoleTextFontSizePx(exportRoleContainerHeight, roleLabel, roleSizeAdjust),
    [exportRoleContainerHeight, roleLabel, roleSizeAdjust]
  );

  const roleEdgeAdjustCqw = roleEdgeAdjustCqwByType[personType];

  const vCardString = useMemo(() => buildVCardString(vCardSettings), [vCardSettings]);

  const backQrPayload = useMemo(() => buildEventManagerQrPayload(person), [person]);

  // Front QR code (vCard)
  useEffect(() => {
    if (!showQrCode) return;
    let isCancelled = false;
    QRCode.toDataURL(vCardString, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 520,
      color: { dark: "#f3f4f6", light: safeCardBackgroundColor },
    })
      .then((url) => {
        if (!isCancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!isCancelled) setQrDataUrl("");
      });
    return () => {
      isCancelled = true;
    };
  }, [showQrCode, vCardString, safeCardBackgroundColor]);

  // Back QR code (EventManagerApp JSON format — margin 1, error correction L)
  useEffect(() => {
    if (!showBackQr || !backQrPayload) {
      setBackQrDataUrl("");
      return;
    }
    let isCancelled = false;
    QRCode.toDataURL(backQrPayload, {
      errorCorrectionLevel: "L",
      margin: 1,
      width: 520,
      color: { dark: safeSecondaryColor, light: safeCardBackgroundColor },
    })
      .then((url) => {
        if (!isCancelled) setBackQrDataUrl(url);
      })
      .catch(() => {
        if (!isCancelled) setBackQrDataUrl("");
      });
    return () => {
      isCancelled = true;
    };
  }, [showBackQr, backQrPayload, safeCardBackgroundColor, safeSecondaryColor]);

  // Track role container height so font size matches roleLabel on the same frame (avoids wrong offset until scale moves).
  useLayoutEffect(() => {
    const container = roleTextContainerRef.current;
    if (!container) {
      setPreviewRoleContainerHeight(0);
      return;
    }
    const update = () => setPreviewRoleContainerHeight(container.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [roleLabel, roleSizeAdjust, selectedSide]);

  useLayoutEffect(() => {
    const container = exportBackRoleContainerRef.current;
    if (!container) return;
    const update = () => setExportRoleContainerHeight(container.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [roleLabel, roleSizeAdjust]);

  // Cleanup photo blob URL on unmount
  useEffect(() => {
    return () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    };
  }, []);

  function updateField<K extends keyof VCardSettings>(field: K, partial: Partial<VCardSettings[K]>) {
    setVCardSettings((old) => ({ ...old, [field]: { ...old[field], ...partial } }));
  }

  const handlePersonTypeChange = useCallback((newType: BadgePersonType) => {
    setPersonType(newType);
    const option = PERSON_TYPE_OPTIONS.find((o) => o.value === newType);
    if (option) setAccentColor(option.defaultAccent);
  }, []);

  const flashDefaultsSaved = useCallback((message = "Saved as default.") => {
    setDefaultsHint(message);
    window.setTimeout(() => setDefaultsHint(""), 2200);
  }, []);

  const applyFactoryReset = useCallback(() => {
    resetIllustratorDefaultsStorageToFactory();
    const f = ILLUSTRATOR_FACTORY_DEFAULTS;
    setCardBackgroundColor(f.cardBackgroundColor);
    setLogoZoom(f.logoZoom);
    setLogoOffsetX(f.logoOffsetX);
    setLogoOffsetY(f.logoOffsetY);
    setLogoOffsetZ(f.logoOffsetZ);
    setShowQrCode(f.showQrCode);
    setShowNfcMark(f.showNfcMark);
    setQrTopPct(f.qrTopPct);
    setQrRightPct(f.qrRightPct);
    setQrWidthPct(f.qrWidthPct);
    setQrOffsetX(f.qrOffsetX);
    setQrOffsetY(f.qrOffsetY);
    setQrOffsetZ(f.qrOffsetZ);
    setQrZoom(f.qrZoom);
    setNfcBottomPct(f.nfcBottomPct);
    setNfcRightPct(f.nfcRightPct);
    setNfcWidthPct(f.nfcWidthPct);
    setNfcOffsetX(f.nfcOffsetX);
    setNfcOffsetY(f.nfcOffsetY);
    setNfcOffsetZ(f.nfcOffsetZ);
    setNfcZoom(f.nfcZoom);
    setPersonType(f.personType);
    setCustomRoleLabel(f.customRoleLabel);
    setAccentColor(PERSON_TYPE_OPTIONS.find((o) => o.value === f.personType)?.defaultAccent ?? f.accentColor);
    setSecondaryColor(f.secondaryColor);
    setPhotoFrameShape(f.photoFrameShape);
    setPhotoZoom(f.photoZoom);
    setPhotoOffsetX(f.photoOffsetX);
    setPhotoOffsetY(f.photoOffsetY);
    setPhotoRotation(f.photoRotation);
    setShowBackQr(f.showBackQr);
    setRoleSizeAdjust(f.roleSizeAdjust);
    setRoleEdgeAdjustCqwByType({ ...FACTORY_ROLE_EDGE_CQW });
    setVCardSettings(buildDefaultVCardSettings(person));
    setBackFirstName(splitName(person.displayName).firstName);
    setBackLastName(person.abbreviation?.trim() || splitName(person.displayName).lastName);
    setProfilePhotoUrl("");
    if (photoUrlRef.current) {
      URL.revokeObjectURL(photoUrlRef.current);
      photoUrlRef.current = "";
    }
    flashDefaultsSaved("Restored original factory defaults.");
  }, [person, flashDefaultsSaved]);

  const handlePhotoUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith("image/")) {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
      const url = URL.createObjectURL(file);
      photoUrlRef.current = url;
      setProfilePhotoUrl(url);
    }
    // Allow selecting the same file again after remove/change.
    event.target.value = "";
  }, []);

  const removePhoto = useCallback(() => {
    if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    photoUrlRef.current = "";
    setProfilePhotoUrl("");
    if (photoInputRef.current) photoInputRef.current.value = "";
  }, []);

  const photoScale = Math.max(1, photoZoom / 100);
  const photoPositionX = Math.max(0, Math.min(100, 50 + photoOffsetX / 4));
  const photoPositionY = Math.max(0, Math.min(100, 50 + photoOffsetY / 4));
  const photoTransform = `scale(${photoScale}) rotate(${photoRotation}deg)`;
  const exportBaseName = useMemo(
    () => sanitizeFileName([backFirstName, backLastName].filter(Boolean).join(" ").trim() || person.displayName),
    [backFirstName, backLastName, person.displayName]
  );

  useEffect(() => {
    if (!isExportMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!exportMenuRef.current?.contains(event.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [isExportMenuOpen]);

  useEffect(() => {
    previewRoleOffsetXRef.current = previewRoleOffsetX;
  }, [previewRoleOffsetX]);

  useEffect(() => {
    exportRoleOffsetXRef.current = exportRoleOffsetX;
  }, [exportRoleOffsetX]);

  useLayoutEffect(() => {
    roleEdgeAdjustCqwByTypeRef.current = roleEdgeAdjustCqwByType;
  }, [roleEdgeAdjustCqwByType]);

  // Keep Bénévole reference gap in sync when only the edge slider moves (main measure effect does not depend on it).
  useLayoutEffect(() => {
    if (roleLabel !== "BENEVOLE") return;
    const card = previewCardRef.current;
    const roleLabelNode = roleLabelRef.current;
    if (!card || !roleLabelNode) return;
    const cardRect = card.getBoundingClientRect();
    const labelRect = roleLabelNode.getBoundingClientRect();
    const userPx = (roleEdgeAdjustCqw / 100) * cardRect.width;
    const alignedPx = previewRoleOffsetXRef.current;
    const rawGapWithoutOffset = cardRect.right - labelRect.right + alignedPx + userPx;
    previewBenevoleRightGapRef.current = rawGapWithoutOffset;
  }, [roleLabel, roleEdgeAdjustCqw, previewRoleTextFontSize, selectedSide, previewRoleOffsetX]);

  useLayoutEffect(() => {
    if (roleLabel !== "BENEVOLE") return;
    const card = exportBackRef.current;
    const roleLabelNode = exportBackRoleLabelRef.current;
    if (!card || !roleLabelNode) return;
    const cardRect = card.getBoundingClientRect();
    const labelRect = roleLabelNode.getBoundingClientRect();
    const userPx = (roleEdgeAdjustCqw / 100) * cardRect.width;
    const alignedPx = exportRoleOffsetXRef.current;
    const rawGapWithoutOffset = cardRect.right - labelRect.right + alignedPx + userPx;
    exportBenevoleRightGapRef.current = rawGapWithoutOffset;
  }, [roleLabel, roleEdgeAdjustCqw, exportRoleTextFontSize, exportRoleOffsetX]);

  useLayoutEffect(() => {
    const card = previewCardRef.current;
    const roleLabelNode = roleLabelRef.current;
    if (!card || !roleLabelNode) return;
    let frameOne = 0;
    let frameTwo = 0;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const cardRect = card.getBoundingClientRect();
      const labelRect = roleLabelNode.getBoundingClientRect();
      const userCqw = roleEdgeAdjustCqwByTypeRef.current[personType];
      const userPx = (userCqw / 100) * cardRect.width;
      const alignedPx = previewRoleOffsetXRef.current;
      const totalOffsetPx = alignedPx + userPx;
      const currentGap = cardRect.right - labelRect.right;
      if (!Number.isFinite(currentGap)) return;
      const rawGapWithoutOffset = currentGap + totalOffsetPx;

      if (roleLabel === "BENEVOLE") {
        previewBenevoleRightGapRef.current = rawGapWithoutOffset;
        if (Math.abs(alignedPx) > 0.25) {
          setPreviewRoleOffsetX(0);
        }
        return;
      }

      if (previewBenevoleRightGapRef.current == null) return;
      const targetTotal = rawGapWithoutOffset - previewBenevoleRightGapRef.current;
      const targetAligned = targetTotal - userPx;
      setPreviewRoleOffsetX((previous) => (Math.abs(previous - targetAligned) <= 0.25 ? previous : targetAligned));
    };

    const scheduleSettledMeasure = () => {
      frameOne = requestAnimationFrame(() => {
        frameTwo = requestAnimationFrame(measure);
      });
    };

    measure();
    scheduleSettledMeasure();
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) {
          scheduleSettledMeasure();
        }
      });
    }

    const observer = new ResizeObserver(measure);
    observer.observe(card);
    observer.observe(roleLabelNode);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (frameOne) cancelAnimationFrame(frameOne);
      if (frameTwo) cancelAnimationFrame(frameTwo);
    };
  }, [selectedSide, roleLabel, previewRoleTextFontSize]);

  useLayoutEffect(() => {
    const card = exportBackRef.current;
    const roleLabelNode = exportBackRoleLabelRef.current;
    if (!card || !roleLabelNode) return;
    let frameOne = 0;
    let frameTwo = 0;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const cardRect = card.getBoundingClientRect();
      const labelRect = roleLabelNode.getBoundingClientRect();
      const userCqw = roleEdgeAdjustCqwByTypeRef.current[personType];
      const userPx = (userCqw / 100) * cardRect.width;
      const alignedPx = exportRoleOffsetXRef.current;
      const totalOffsetPx = alignedPx + userPx;
      const currentGap = cardRect.right - labelRect.right;
      if (!Number.isFinite(currentGap)) return;
      const rawGapWithoutOffset = currentGap + totalOffsetPx;

      if (roleLabel === "BENEVOLE") {
        exportBenevoleRightGapRef.current = rawGapWithoutOffset;
        if (Math.abs(alignedPx) > 0.25) {
          setExportRoleOffsetX(0);
        }
        return;
      }

      if (exportBenevoleRightGapRef.current == null) return;
      const targetTotal = rawGapWithoutOffset - exportBenevoleRightGapRef.current;
      const targetAligned = targetTotal - userPx;
      setExportRoleOffsetX((previous) => (Math.abs(previous - targetAligned) <= 0.25 ? previous : targetAligned));
    };

    const scheduleSettledMeasure = () => {
      frameOne = requestAnimationFrame(() => {
        frameTwo = requestAnimationFrame(measure);
      });
    };

    measure();
    scheduleSettledMeasure();
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) {
          scheduleSettledMeasure();
        }
      });
    }

    const observer = new ResizeObserver(measure);
    observer.observe(card);
    observer.observe(roleLabelNode);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (frameOne) cancelAnimationFrame(frameOne);
      if (frameTwo) cancelAnimationFrame(frameTwo);
    };
  }, [roleLabel, exportRoleTextFontSize]);

  const saveBlob = useCallback(
    async (
      blob: Blob,
      fileName: string,
      filters: Array<{ name: string; extensions: string[] }>,
      openAfterSave = false
    ) => {
      const electronApi = window.electronAPI as ElectronExportAPI | undefined;
      if (electronApi?.saveBinaryFile) {
        const dataBase64 = await blobToBase64(blob);
        await electronApi.saveBinaryFile({
          defaultFileName: fileName,
          filters,
          dataBase64,
          openAfterSave,
        });
        return;
      }
      triggerBrowserDownload(blob, fileName);
    },
    []
  );

  const waitRenderSettled = useCallback(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, []);

  const captureNode = useCallback(
    async (node: HTMLElement, format: "png" | "jpg" | "svg"): Promise<string> => {
      const options = {
        // html-to-image appends ?t= to every URL; that invalidates blob: object URLs (photos, etc.).
        cacheBust: false,
        width: EXPORT_CARD_WIDTH,
        height: EXPORT_CARD_HEIGHT,
        pixelRatio: 2,
        backgroundColor: safeCardBackgroundColor,
      };
      if (format === "png") {
        return toPng(node, options);
      }
      if (format === "jpg") {
        return toJpeg(node, { ...options, quality: 0.96 });
      }
      return toSvg(node, options);
    },
    [safeCardBackgroundColor]
  );

  const captureBothSides = useCallback(
    async (format: "png" | "jpg" | "svg") => {
      const frontNode = exportFrontRef.current;
      const backNode = exportBackRef.current;
      if (!frontNode || !backNode) {
        throw new Error("Export surface is unavailable.");
      }
      await waitRenderSettled();
      const [front, back] = await Promise.all([
        captureNode(frontNode, format),
        captureNode(backNode, format),
      ]);
      return { front, back };
    },
    [captureNode, waitRenderSettled]
  );

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      try {
        setIsExporting(true);
        setExportNotice(
          format === "canva" ? "Preparing Canva export…" : `Exporting ${format.toUpperCase()}...`
        );
        setIsExportMenuOpen(false);

        if (format === "pdf") {
          const { front, back } = await captureBothSides("png");
          const pdf = new jsPDF({
            orientation: "landscape",
            unit: "mm",
            format: [85.6, 54],
            compress: true,
          });
          pdf.addImage(front, "PNG", 0, 0, 85.6, 54, undefined, "FAST");
          pdf.addPage([85.6, 54], "landscape");
          pdf.addImage(back, "PNG", 0, 0, 85.6, 54, undefined, "FAST");
          const blob = pdf.output("blob");
          await saveBlob(blob, `${exportBaseName}.pdf`, [{ name: "PDF", extensions: ["pdf"] }]);
          setExportNotice("PDF exported (2 pages: front + back).");
          return;
        }

        if (format === "canva") {
          const electronApi = window.electronAPI as ElectronExportAPI | undefined;
          if (!electronApi?.canvaGetStatus || !electronApi?.canvaSendPdf) {
            setExportNotice("Send to Canva requires the desktop app (Electron).");
            return;
          }
          const status = await electronApi.canvaGetStatus();
          if (!status.hasCredentials) {
            setExportNotice("Configure Canva in Settings (gear) or set CANVA_CLIENT_ID / CANVA_CLIENT_SECRET.");
            return;
          }
          if (!status.connected) {
            setExportNotice("Connect your Canva account: Settings (gear) → Connect to Canva.");
            return;
          }

          if (status.hasBrandTemplate) {
            if (!electronApi.canvaSendBadgeAutofill) {
              setExportNotice("Send to Canva (Autofill) is unavailable. Update the desktop app.");
              return;
            }
            setExportNotice("Preparing text and images for Canva…");
            await waitRenderSettled();

            const texts: Record<string, string> = {
              [CANVA_TEXT_FIELDS.FIRST_NAME]: backFirstName,
              [CANVA_TEXT_FIELDS.LAST_NAME]: backLastName,
              [CANVA_TEXT_FIELDS.ROLE]: roleLabel,
            };
            if (vCardSettings.organization.enabled && vCardSettings.organization.value.trim()) {
              texts[CANVA_TEXT_FIELDS.ORG] = vCardSettings.organization.value.trim();
            }

            const imagesBase64: Record<string, string> = {};
            const frontRoot = exportFrontRef.current;
            const backRoot = exportBackRef.current;

            const logoB64 = await captureCanvaFieldPng(frontRoot, CANVA_IMAGE_FIELDS.LOGO);
            if (logoB64) imagesBase64[CANVA_IMAGE_FIELDS.LOGO] = logoB64;

            const qrVcardB64 = await captureCanvaFieldPng(frontRoot, CANVA_IMAGE_FIELDS.QR_VCARD, safeCardBackgroundColor);
            if (qrVcardB64) imagesBase64[CANVA_IMAGE_FIELDS.QR_VCARD] = qrVcardB64;

            const nfcB64 = await captureCanvaFieldPng(frontRoot, CANVA_IMAGE_FIELDS.NFC, safeCardBackgroundColor);
            if (nfcB64) imagesBase64[CANVA_IMAGE_FIELDS.NFC] = nfcB64;

            const qrEventB64 = await captureCanvaFieldPng(backRoot, CANVA_IMAGE_FIELDS.QR_EVENT, safeCardBackgroundColor);
            if (qrEventB64) imagesBase64[CANVA_IMAGE_FIELDS.QR_EVENT] = qrEventB64;

            const photoB64 = await captureCanvaFieldPng(backRoot, CANVA_IMAGE_FIELDS.PHOTO);
            if (photoB64) imagesBase64[CANVA_IMAGE_FIELDS.PHOTO] = photoB64;

            setExportNotice("Uploading to Canva and generating your design…");
            await electronApi.canvaSendBadgeAutofill({
              title: exportBaseName.slice(0, 200),
              texts,
              imagesBase64,
              ...(status.brandTemplateId ? { brandTemplateId: status.brandTemplateId } : {}),
            });
            setExportNotice("Opened Canva — text and images are editable layers.");
            return;
          }

          setExportNotice("Sending to Canva (importing PDF)…");
          const { front, back } = await captureBothSides("png");
          const pdf = new jsPDF({
            orientation: "landscape",
            unit: "mm",
            format: [85.6, 54],
            compress: true,
          });
          pdf.addImage(front, "PNG", 0, 0, 85.6, 54, undefined, "FAST");
          pdf.addPage([85.6, 54], "landscape");
          pdf.addImage(back, "PNG", 0, 0, 85.6, 54, undefined, "FAST");
          const blob = pdf.output("blob");
          const pdfBase64 = await blobToBase64(blob);
          await electronApi.canvaSendPdf({ pdfBase64, title: exportBaseName.slice(0, 50) });
          setExportNotice("Opened Canva with your badge (2-page import — add a brand template ID for editable layers).");
          return;
        }

        if (format === "bs") {
          const { front, back } = await captureBothSides("png");

          const docUUID = crypto.randomUUID();
          const frontUID = generateBsHexUID();
          const backUID = generateBsHexUID();
          const frontBinUUID = crypto.randomUUID();
          const backBinUUID = crypto.randomUUID();
          const dbDocUUID = crypto.randomUUID();
          const dbDataUUID = crypto.randomUUID();
          const imgSettingsDocUUID = crypto.randomUUID();
          const imgSettingsDataUUID = crypto.randomUUID();

          const frontBytes = bsBase64ToUint8Array(stripDataUrlPrefix(front));
          const backBytes = bsBase64ToUint8Array(stripDataUrlPrefix(back));
          const sqliteBytes = bsBase64ToUint8Array(BADGY_EMPTY_SQLITE_B64);

          const zip = new JSZip();
          zip.file("document/info.xml", buildBsInfoXml(docUUID));
          zip.file("document/events.xml", buildBsEventsXml());
          zip.file("design/layouts.xml", buildBsLayoutsXml());
          zip.file(
            "design/items.xml",
            buildBsItemsXml(frontUID, frontBinUUID, backUID, backBinUUID, exportBaseName)
          );
          zip.file(
            `design/FILES/items/${frontUID}/background/type/picture/data/{${frontBinUUID}}.bin`,
            frontBytes
          );
          zip.file(
            `design/FILES/items/${backUID}/background/type/picture/data/{${backBinUUID}}.bin`,
            backBytes
          );
          zip.file("print/print.xml", buildBsPrintXml());
          zip.file(
            "database/connection.xml",
            buildBsConnectionXml(dbDocUUID, dbDataUUID, imgSettingsDocUUID, imgSettingsDataUUID)
          );
          zip.file(
            `database/connection/connection/properties/SQLITE/dataSourceData/{${dbDataUUID}}.sqlite`,
            sqliteBytes
          );
          zip.file(
            `database/connection/connection/properties/imageSettings/dataSourceData/{${imgSettingsDataUUID}}.sqlite`,
            new Uint8Array(0)
          );
          zip.file("database/import/properties.json", "{\n}");
          zip.file("encoding/encoding.xml", buildBsEncodingXml());

          const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
          await saveBlob(blob, `${exportBaseName}.bs`, [{ name: "Badgy project", extensions: ["bs"] }], true);
          setExportNotice("Badgy Studio project exported (.bs) — front + back embedded as backgrounds.");
          return;
        }

        const { front, back } = await captureBothSides(format);
        const extension = format;
        const mimeType = format === "svg" ? "image/svg+xml" : format === "jpg" ? "image/jpeg" : "image/png";
        const zip = new JSZip();
        zip.file(`front.${extension}`, stripDataUrlPrefix(front), { base64: true });
        zip.file(`back.${extension}`, stripDataUrlPrefix(back), { base64: true });
        zip.file(
          "README.txt",
          "This archive contains both sides of the badge export.\nFront and back files are generated from the live preview."
        );
        const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
        await saveBlob(archive, `${exportBaseName}-${extension}.zip`, [
          { name: "ZIP archive", extensions: ["zip"] },
          { name: mimeType, extensions: [extension] },
        ]);
        setExportNotice(`${format.toUpperCase()} exported for both sides as ZIP.`);
      } catch (error) {
        setExportNotice(error instanceof Error ? error.message : "Export failed.");
      } finally {
        setIsExporting(false);
      }
    },
    [
      backFirstName,
      backLastName,
      captureBothSides,
      exportBaseName,
      person.displayName,
      person.id,
      roleLabel,
      safeCardBackgroundColor,
      saveBlob,
      vCardSettings,
      waitRenderSettled,
    ]
  );

  const frontBadgeMarkup = (
    <>
      <div
        className="badge-background-tint"
        style={{ backgroundColor: safeCardBackgroundColor }}
        aria-hidden="true"
      />
      <img
        src={coverImageSrc}
        alt="Badge cover template"
        className="badge-cover"
        data-canva-field={CANVA_IMAGE_FIELDS.LOGO}
        style={{ transform: logoTransform }}
        onError={() => setCoverImageSrc(coverTemplateImage)}
      />
      {showQrCode && qrDataUrl && (
        <img
          src={qrDataUrl}
          alt="Contact vCard QR code"
          className="badge-qr"
          data-canva-field={CANVA_IMAGE_FIELDS.QR_VCARD}
          style={{
            position: "absolute",
            top: `${qrTopPct}%`,
            right: `${qrRightPct}%`,
            width: `${qrWidthPct}%`,
            height: "auto",
            transform: qrImgStyleTransform,
            transformOrigin: "center center",
            backgroundColor: safeCardBackgroundColor,
            borderColor: safeCardBackgroundColor,
          }}
        />
      )}
      {showNfcMark && (
        <div
          className="badge-nfc"
          data-canva-field={CANVA_IMAGE_FIELDS.NFC}
          style={{
            position: "absolute",
            bottom: `${nfcBottomPct}%`,
            right: `${nfcRightPct}%`,
            width: `${nfcWidthPct}%`,
            transform: nfcBlockTransform,
            transformOrigin: "center center",
          }}
        >
          <NfcMark />
        </div>
      )}
    </>
  );

  const renderBackBadgeMarkup = (attachRoleRef: boolean, attachLabelRef: boolean, forExport = false) => {
    const roleTextFontSize = forExport ? exportRoleTextFontSize : previewRoleTextFontSize;
    const roleOffsetX = forExport ? exportRoleOffsetX : previewRoleOffsetX;
    const roleTransform = `translateX(calc(${roleOffsetX}px + ${roleEdgeAdjustCqw}cqw))`;
    return (
      <>
      <div className="back-left-group">
        <div className="back-name-area">
          <span className="back-first-name" style={{ color: safeAccentColor }}>
            {backFirstName}
          </span>
          <span className="back-last-name" style={{ color: safeSecondaryColor }}>
            {backLastName}
          </span>
        </div>
        {showBackQr && backQrDataUrl && (
          <img
            src={backQrDataUrl}
            alt="QR code"
            className="back-qr-code"
            data-canva-field={CANVA_IMAGE_FIELDS.QR_EVENT}
            draggable={false}
          />
        )}
      </div>

      <div className="back-center-group">
        <div className="back-logos">
          <span
            className="back-logo-mask back-logo-mask--collectif"
            aria-label="Collectif Nocturne"
            style={{
              backgroundColor: safeSecondaryColor,
              WebkitMaskImage: "url('/LOGO/collectifnocturne.png')",
              maskImage: "url('/LOGO/collectifnocturne.png')",
            }}
          />
          <span
            className="back-logo-mask back-logo-mask--groove"
            aria-label="Le Groove"
            style={{
              backgroundColor: safeSecondaryColor,
              WebkitMaskImage: "url('/LOGO/legroove-logo.png')",
              maskImage: "url('/LOGO/legroove-logo.png')",
            }}
          />
          <span
            className="back-logo-mask back-logo-mask--terreau"
            aria-label="Le Terreau"
            style={{
              backgroundColor: safeSecondaryColor,
              WebkitMaskImage: "url('/LOGO/logo_terreau.png')",
              maskImage: "url('/LOGO/logo_terreau.png')",
            }}
          />
        </div>
        <div
          className="back-photo-frame"
          style={{ borderRadius: photoFrameShape === "circle" ? "50%" : "12%" }}
        >
          {profilePhotoUrl ? (
            <img
              src={profilePhotoUrl}
              alt="Profile"
              className="back-photo-img"
              data-canva-field={CANVA_IMAGE_FIELDS.PHOTO}
              draggable={false}
              style={{
                transform: photoTransform,
                objectPosition: `${photoPositionX}% ${photoPositionY}%`,
              }}
            />
          ) : (
            <div className="back-photo-placeholder">
              <span>Photo</span>
            </div>
          )}
        </div>
      </div>

      <div
        className="back-role-container"
        ref={attachRoleRef ? roleTextContainerRef : forExport ? exportBackRoleContainerRef : undefined}
      >
        <span
          className="back-role-label"
          ref={attachLabelRef ? roleLabelRef : forExport ? exportBackRoleLabelRef : undefined}
          style={{
            color: safeAccentColor,
            fontSize: `${roleTextFontSize}px`,
            transform: roleTransform,
          }}
        >
          {roleLabel}
        </span>
      </div>
      </>
    );
  };

  return (
    <div className="badge-illustrator">
      <div className="illustrator-topbar">
        <div className="illustrator-title-block">
          <h3>Badge illustrator</h3>
          <p className="hint">Select side and configure overlays.</p>
          <div className="person-meta-chips">
            <span className="meta-chip">{person.displayName}</span>
            <span className="meta-chip">{categoryRole(person)}</span>
            {person.venue && <span className="meta-chip">{person.venue}</span>}
          </div>
        </div>
        <div className="side-switch">
          <button
            className={selectedSide === "front" ? "active" : ""}
            onClick={() => setSelectedSide("front")}
          >
            Front of badge
          </button>
          <button
            className={selectedSide === "back" ? "active" : ""}
            onClick={() => setSelectedSide("back")}
          >
            Back of badge
          </button>
        </div>
        <label className="background-color-control">
          <span>Card background</span>
          <div className="background-color-inputs">
            <input
              type="color"
              value={safeCardBackgroundColor}
              onChange={(event) => setCardBackgroundColor(event.target.value)}
              aria-label="Select badge card background color"
            />
            <input
              type="text"
              value={cardBackgroundColor}
              onChange={(event) => setCardBackgroundColor(event.target.value)}
              placeholder="#1b1b1b"
            />
          </div>
          <SetAsDefaultButton
            onClick={() => {
              persistIllustratorPartial({ cardBackgroundColor });
              flashDefaultsSaved();
            }}
            label="Set background as default"
          />
        </label>
        <div className="illustrator-topbar-actions">
          <button type="button" className="btn-reset-factory" onClick={applyFactoryReset}>
            Reset all to original defaults
          </button>
        </div>
      </div>
      {defaultsHint && <p className="defaults-hint">{defaultsHint}</p>}

      <div className="badge-illustrator-body">
        <section className="badge-settings">
          {selectedSide === "front" ? (
            <>
              <div className="settings-section">
                <h3>Front settings</h3>
                <p className="hint">
                  Design is fixed to your approved layout. Cover image is `LOGO/collectifnocturne.png`. Only QR and NFC
                  are configurable.
                </p>

                <div className="logo-positioning-controls">
                  <h4>Logo positioning</h4>

                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Zoom</span>
                      <input
                        type="range"
                        min={20}
                        max={240}
                        step={1}
                        value={logoZoom}
                        onChange={(event) => setLogoZoom(Number(event.target.value))}
                      />
                      <output>{logoZoom}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ logoZoom });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>

                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>X</span>
                      <input
                        type="range"
                        min={-500}
                        max={500}
                        step={1}
                        value={logoOffsetX}
                        onChange={(event) => setLogoOffsetX(Number(event.target.value))}
                      />
                      <output>{logoOffsetX}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ logoOffsetX });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>

                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Y</span>
                      <input
                        type="range"
                        min={-500}
                        max={500}
                        step={1}
                        value={logoOffsetY}
                        onChange={(event) => setLogoOffsetY(Number(event.target.value))}
                      />
                      <output>{logoOffsetY}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ logoOffsetY });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>

                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Z (rotation)</span>
                      <input
                        type="range"
                        min={-45}
                        max={45}
                        step={1}
                        value={logoOffsetZ}
                        onChange={(event) => setLogoOffsetZ(Number(event.target.value))}
                      />
                      <output>{logoOffsetZ}deg</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ logoOffsetZ });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                </div>

                <div className="switch-with-default">
                  <ToggleSwitch
                    checked={showQrCode}
                    onChange={(v) => setShowQrCode(v)}
                    label="Show QR contact code (top-right)"
                  />
                  <SetAsDefaultButton
                    onClick={() => {
                      persistIllustratorPartial({ showQrCode });
                      flashDefaultsSaved();
                    }}
                  />
                </div>

                <div className="switch-with-default">
                  <ToggleSwitch
                    checked={showNfcMark}
                    onChange={(v) => setShowNfcMark(v)}
                    label="Show NFC mark (bottom-right)"
                  />
                  <SetAsDefaultButton
                    onClick={() => {
                      persistIllustratorPartial({ showNfcMark });
                      flashDefaultsSaved();
                    }}
                  />
                </div>
              </div>

              {showQrCode && (
                <div className="settings-section">
                  <h4>Front QR code — position &amp; size</h4>
                  <p className="hint">Anchor (top / right / width) plus fine X, Y, Z and zoom. Design-pixel X/Y match logo sliders.</p>

                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Top</span>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        step={0.5}
                        value={qrTopPct}
                        onChange={(e) => setQrTopPct(Number(e.target.value))}
                      />
                      <output>{qrTopPct}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ qrTopPct });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Right</span>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        step={0.5}
                        value={qrRightPct}
                        onChange={(e) => setQrRightPct(Number(e.target.value))}
                      />
                      <output>{qrRightPct}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ qrRightPct });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Width</span>
                      <input
                        type="range"
                        min={5}
                        max={45}
                        step={0.5}
                        value={qrWidthPct}
                        onChange={(e) => setQrWidthPct(Number(e.target.value))}
                      />
                      <output>{qrWidthPct}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ qrWidthPct });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>X</span>
                      <input
                        type="range"
                        min={-500}
                        max={500}
                        step={1}
                        value={qrOffsetX}
                        onChange={(e) => setQrOffsetX(Number(e.target.value))}
                      />
                      <output>{qrOffsetX}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ qrOffsetX });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Y</span>
                      <input
                        type="range"
                        min={-500}
                        max={500}
                        step={1}
                        value={qrOffsetY}
                        onChange={(e) => setQrOffsetY(Number(e.target.value))}
                      />
                      <output>{qrOffsetY}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ qrOffsetY });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Z (rotation)</span>
                      <input
                        type="range"
                        min={-45}
                        max={45}
                        step={1}
                        value={qrOffsetZ}
                        onChange={(e) => setQrOffsetZ(Number(e.target.value))}
                      />
                      <output>{qrOffsetZ}deg</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ qrOffsetZ });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Zoom</span>
                      <input
                        type="range"
                        min={20}
                        max={240}
                        step={1}
                        value={qrZoom}
                        onChange={(e) => setQrZoom(Number(e.target.value))}
                      />
                      <output>{qrZoom}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ qrZoom });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                </div>
              )}

              {showNfcMark && (
                <div className="settings-section">
                  <h4>NFC mark — position &amp; size</h4>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Bottom</span>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        step={0.5}
                        value={nfcBottomPct}
                        onChange={(e) => setNfcBottomPct(Number(e.target.value))}
                      />
                      <output>{nfcBottomPct}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ nfcBottomPct });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Right</span>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        step={0.5}
                        value={nfcRightPct}
                        onChange={(e) => setNfcRightPct(Number(e.target.value))}
                      />
                      <output>{nfcRightPct}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ nfcRightPct });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Width</span>
                      <input
                        type="range"
                        min={5}
                        max={40}
                        step={0.5}
                        value={nfcWidthPct}
                        onChange={(e) => setNfcWidthPct(Number(e.target.value))}
                      />
                      <output>{nfcWidthPct}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ nfcWidthPct });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>X</span>
                      <input
                        type="range"
                        min={-500}
                        max={500}
                        step={1}
                        value={nfcOffsetX}
                        onChange={(e) => setNfcOffsetX(Number(e.target.value))}
                      />
                      <output>{nfcOffsetX}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ nfcOffsetX });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Y</span>
                      <input
                        type="range"
                        min={-500}
                        max={500}
                        step={1}
                        value={nfcOffsetY}
                        onChange={(e) => setNfcOffsetY(Number(e.target.value))}
                      />
                      <output>{nfcOffsetY}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ nfcOffsetY });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Z (rotation)</span>
                      <input
                        type="range"
                        min={-45}
                        max={45}
                        step={1}
                        value={nfcOffsetZ}
                        onChange={(e) => setNfcOffsetZ(Number(e.target.value))}
                      />
                      <output>{nfcOffsetZ}deg</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ nfcOffsetZ });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Zoom</span>
                      <input
                        type="range"
                        min={20}
                        max={240}
                        step={1}
                        value={nfcZoom}
                        onChange={(e) => setNfcZoom(Number(e.target.value))}
                      />
                      <output>{nfcZoom}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ nfcZoom });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                </div>
              )}

              {showQrCode && (
                <div className="vcard-settings settings-section">
                  <h4>vCard fields (prefilled from Google Sheets)</h4>

                  {(
                    [
                      ["firstName", "First name"],
                      ["lastName", "Last name"],
                      ["fullName", "Full name (FN)"],
                      ["organization", "Organization"],
                      ["role", "Role / Category"],
                      ["email", "Email"],
                      ["phone", "Phone"],
                      ["note", "Notes"],
                    ] as const
                  ).map(([field, label]) => (
                    <div className="vcard-field" key={field}>
                      <ToggleSwitch
                        checked={vCardSettings[field].enabled}
                        onChange={(checked) => updateField(field, { enabled: checked })}
                        label={label}
                      />
                      <input
                        value={vCardSettings[field].value}
                        onChange={(e) => updateField(field, { value: e.target.value })}
                        disabled={!vCardSettings[field].enabled}
                      />
                    </div>
                  ))}
                  <SetAsDefaultButton
                    label="Set vCard field defaults"
                    onClick={() => {
                      persistIllustratorPartial({ vCardSettings });
                      flashDefaultsSaved();
                    }}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              {/* Person type & accent colour */}
              <div className="settings-section">
                <h3>Back settings</h3>
                <p className="hint">Configure person type, name, photo, logos and QR code for the back side.</p>

                <label>
                  Person type
                  <select
                    value={personType}
                    onChange={(e) => handlePersonTypeChange(e.target.value as BadgePersonType)}
                  >
                    {PERSON_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <SetAsDefaultButton
                  label="Set person type &amp; accent as default"
                  onClick={() => {
                    persistIllustratorPartial({
                      personType,
                      accentColor: safeAccentColor,
                    });
                    flashDefaultsSaved();
                  }}
                />

                {personType === "autre" && (
                  <label>
                    Custom label (vertical text)
                    <input
                      value={customRoleLabel}
                      onChange={(e) => setCustomRoleLabel(e.target.value)}
                      placeholder="CUSTOM LABEL"
                    />
                  </label>
                )}
                {personType === "autre" && (
                  <SetAsDefaultButton
                    label="Set custom label as default"
                    onClick={() => {
                      persistIllustratorPartial({ customRoleLabel });
                      flashDefaultsSaved();
                    }}
                  />
                )}

                <div className="slider-with-default" style={{ marginTop: "0.4rem" }}>
                  <label className="range-row">
                    <span>Role text size</span>
                    <input
                      type="range"
                      min={50}
                      max={150}
                      step={1}
                      value={roleSizeAdjust}
                      onChange={(e) => setRoleSizeAdjust(Number(e.target.value))}
                    />
                    <output>{roleSizeAdjust}%</output>
                  </label>
                  <SetAsDefaultButton
                    onClick={() => {
                      persistIllustratorPartial({ roleSizeAdjust });
                      flashDefaultsSaved();
                    }}
                  />
                </div>

                <div className="slider-with-default" style={{ marginTop: "0.4rem" }}>
                  <label className="range-row">
                    <span>
                      Role edge distance (
                      {PERSON_TYPE_OPTIONS.find((o) => o.value === personType)?.label ?? personType})
                    </span>
                    <input
                      type="range"
                      min={-10}
                      max={10}
                      step={0.25}
                      value={roleEdgeAdjustCqw}
                      onChange={(e) =>
                        setRoleEdgeAdjustCqwByType((prev) => ({
                          ...prev,
                          [personType]: Number(e.target.value),
                        }))
                      }
                    />
                    <output>
                      {roleEdgeAdjustCqw >= 0 ? "+" : ""}
                      {roleEdgeAdjustCqw.toFixed(2)} cqw
                    </output>
                  </label>
                  <SetAsDefaultButton
                    onClick={() => {
                      persistIllustratorPartial({
                        roleEdgeAdjustCqwByType: { ...roleEdgeAdjustCqwByType, [personType]: roleEdgeAdjustCqw },
                      });
                      flashDefaultsSaved();
                    }}
                  />
                </div>
                <p className="hint" style={{ marginTop: "0.25rem" }}>
                  Saved per person type. Positive moves the vertical role toward the outer edge of the card; negative
                  toward the center.
                </p>

                <label className="background-color-control" style={{ marginTop: "0.6rem" }}>
                  <span>Accent colour</span>
                  <div className="background-color-inputs">
                    <input
                      type="color"
                      value={safeAccentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                    />
                    <input
                      type="text"
                      value={accentColor}
                      onChange={(e) => setAccentColor(e.target.value)}
                      placeholder="#ffd699"
                    />
                  </div>
                </label>
                <SetAsDefaultButton
                  label="Set accent colour as default"
                  onClick={() => {
                    persistIllustratorPartial({ accentColor: safeAccentColor });
                    flashDefaultsSaved();
                  }}
                />
              </div>

              {/* Name */}
              <div className="settings-section">
                <h4>Name</h4>
                <p className="hint">Prefilled from the sheet for this person. Not saved as global defaults.</p>
                <label>
                  First name (accent colour, Archivo Black)
                  <input value={backFirstName} onChange={(e) => setBackFirstName(e.target.value)} />
                </label>
                <label style={{ marginTop: "0.4rem" }}>
                  Last name (white, Archivo Narrow)
                  <input value={backLastName} onChange={(e) => setBackLastName(e.target.value)} />
                </label>
              </div>

              {/* Logos */}
              <div className="settings-section">
                <h4>Secondary colour</h4>
                <p className="hint">Used by venue logos, last name and back QR code. Default: white.</p>
                <label className="background-color-control" style={{ marginTop: "0.3rem" }}>
                  <span>Secondary colour</span>
                  <div className="background-color-inputs">
                    <input
                      type="color"
                      value={safeSecondaryColor}
                      onChange={(e) => setSecondaryColor(e.target.value)}
                    />
                    <input
                      type="text"
                      value={secondaryColor}
                      onChange={(e) => setSecondaryColor(e.target.value)}
                      placeholder="#ffffff"
                    />
                  </div>
                </label>
                <SetAsDefaultButton
                  label="Set secondary colour as default"
                  onClick={() => {
                    persistIllustratorPartial({ secondaryColor: safeSecondaryColor });
                    flashDefaultsSaved();
                  }}
                />
              </div>

              {/* Profile photo */}
              <div className="settings-section">
                <h4>Profile photo</h4>
                <input
                  type="file"
                  ref={photoInputRef}
                  accept="image/*"
                  onChange={handlePhotoUpload}
                  style={{ display: "none" }}
                />
                <div className="photo-upload-row">
                  <button type="button" onClick={() => photoInputRef.current?.click()}>
                    {profilePhotoUrl ? "Change photo" : "Browse for photo"}
                  </button>
                  {profilePhotoUrl && (
                    <button type="button" onClick={removePhoto}>
                      Remove
                    </button>
                  )}
                </div>

                <div className="photo-frame-shape-row">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="frameShape"
                      value="circle"
                      checked={photoFrameShape === "circle"}
                      onChange={() => setPhotoFrameShape("circle")}
                    />
                    Circle
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="frameShape"
                      value="rounded"
                      checked={photoFrameShape === "rounded"}
                      onChange={() => setPhotoFrameShape("rounded")}
                    />
                    Rounded square
                  </label>
                </div>
                <SetAsDefaultButton
                  label="Set frame shape as default"
                  onClick={() => {
                    persistIllustratorPartial({ photoFrameShape });
                    flashDefaultsSaved();
                  }}
                />

                <div className="logo-positioning-controls">
                  <h4>Photo positioning</h4>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Zoom</span>
                      <input
                        type="range"
                        min={100}
                        max={300}
                        step={1}
                        value={photoZoom}
                        onChange={(e) => setPhotoZoom(Number(e.target.value))}
                      />
                      <output>{photoZoom}%</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ photoZoom });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>X</span>
                      <input
                        type="range"
                        min={-200}
                        max={200}
                        step={1}
                        value={photoOffsetX}
                        onChange={(e) => setPhotoOffsetX(Number(e.target.value))}
                      />
                      <output>{photoOffsetX}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ photoOffsetX });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Y</span>
                      <input
                        type="range"
                        min={-200}
                        max={200}
                        step={1}
                        value={photoOffsetY}
                        onChange={(e) => setPhotoOffsetY(Number(e.target.value))}
                      />
                      <output>{photoOffsetY}px</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ photoOffsetY });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>Rot</span>
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        step={1}
                        value={photoRotation}
                        onChange={(e) => setPhotoRotation(Number(e.target.value))}
                      />
                      <output>{photoRotation}°</output>
                    </label>
                    <SetAsDefaultButton
                      onClick={() => {
                        persistIllustratorPartial({ photoRotation });
                        flashDefaultsSaved();
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* QR code */}
              <div className="settings-section">
                <h4>QR Code</h4>
                <div className="switch-with-default">
                  <ToggleSwitch checked={showBackQr} onChange={(v) => setShowBackQr(v)} label="Show QR code" />
                  <SetAsDefaultButton
                    onClick={() => {
                      persistIllustratorPartial({ showBackQr });
                      flashDefaultsSaved();
                    }}
                  />
                </div>
                <p className="hint">
                  Encodes EventManagerApp JSON from sheet data only. Volunteers use `id + sheetsId`; guests use
                  `name + abbr`. Temporary guests do not get a QR code.
                </p>
              </div>
            </>
          )}
        </section>

        <section className="badge-preview-panel">
          <div className="badge-preview-header">
            <h3>Live preview</h3>
            <p className="badge-preview-subtitle">ID-1 · 85.6 × 54 mm</p>
          </div>
          <div className="badge-preview-canvas-wrap">
            <div
              className="badge-card-preview"
              ref={previewCardRef}
              style={{ backgroundColor: safeCardBackgroundColor }}
            >
              {selectedSide === "front" ? frontBadgeMarkup : renderBackBadgeMarkup(true, true)}
            </div>
          </div>
        </section>
      </div>

      <div className="badge-export-surfaces" aria-hidden="true">
        <div ref={exportFrontRef} className="badge-card-preview badge-card-preview--export" style={{ backgroundColor: safeCardBackgroundColor }}>
          {frontBadgeMarkup}
        </div>
        <div ref={exportBackRef} className="badge-card-preview badge-card-preview--export" style={{ backgroundColor: safeCardBackgroundColor }}>
          {renderBackBadgeMarkup(false, false, true)}
        </div>
      </div>

      <div className="floating-export-menu" ref={exportMenuRef}>
        {isExportMenuOpen && (
          <div className="floating-export-options">
            <button type="button" onClick={() => handleExport("png")} disabled={isExporting}>
              Export `.png` (front + back)
            </button>
            <button type="button" onClick={() => handleExport("jpg")} disabled={isExporting}>
              Export `.jpg` (front + back)
            </button>
            <button type="button" onClick={() => handleExport("svg")} disabled={isExporting}>
              Export `.svg` (front + back)
            </button>
            <button type="button" onClick={() => handleExport("pdf")} disabled={isExporting}>
              Export `.pdf` (2 pages)
            </button>
            <button type="button" onClick={() => handleExport("canva")} disabled={isExporting}>
              Send to Canva (editable layers)
            </button>
            <button type="button" onClick={() => handleExport("bs")} disabled={isExporting}>
              Export `.bs` (Badgy package)
            </button>
          </div>
        )}
        <button
          type="button"
          className="primary floating-export-btn"
          onClick={() => setIsExportMenuOpen((old) => !old)}
          disabled={isExporting}
        >
          {isExporting ? "Exporting..." : "Export badge"}
        </button>
      </div>

      {exportNotice && <p className="export-notice">{exportNotice}</p>}
    </div>
  );
}
