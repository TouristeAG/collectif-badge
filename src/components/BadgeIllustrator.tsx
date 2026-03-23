import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n/config";
import { toJpeg, toPng, toSvg } from "html-to-image";
import { jsPDF } from "jspdf";
import JSZip from "jszip";
import QRCode from "qrcode";
import initSqlJs from "sql.js";
import sqlWasm from "sql.js/dist/sql-wasm.wasm?url";
import coverTemplateImage from "../assets/badge-cover-template.png";
import collectifnocturneLogo from "../assets/logo/collectifnocturne.png";
import legrooveLogo from "../assets/logo/legroove-logo.png";
import logoTerreau from "../assets/logo/logo_terreau.png";
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
  /** At least one person (the app only opens the modal when the list is non-empty). */
  people: [PersonRecord, ...PersonRecord[]];
}

type PersonEditableSnapshot = {
  vCardSettings: VCardSettings;
  backFirstName: string;
  backLastName: string;
  profilePhotoUrl: string;
};

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

type ExportFormat = "png" | "jpg" | "svg" | "pdf" | "bs" | "canva";

const PERSON_TYPE_META: Array<{
  value: BadgePersonType;
  displayLabel: string;
  defaultAccent: string;
}> = [
  { value: "benevole", displayLabel: "BENEVOLE", defaultAccent: "#ffd699" },
  { value: "salarie", displayLabel: "SALARIE·E·X", defaultAccent: "#e1a8f0" },
  { value: "invite", displayLabel: "INVITE·E·X", defaultAccent: "#99daff" },
  { value: "externe", displayLabel: "EXTERNE", defaultAccent: "#ff9999" },
  { value: "autre", displayLabel: "AUTRE", defaultAccent: "#ff99d8" },
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
  /** Prefer over base64 for large files — avoids huge strings across the Electron IPC boundary. */
  dataBytes?: Uint8Array;
  dataBase64?: string;
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

function allocUniqueExportStem(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}_${n}`;
    n += 1;
  }
  used.add(name);
  return name;
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
    reader.onerror = () => reject(new Error(i18n.t("errors.blobToBase64")));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(i18n.t("errors.blobUnexpected")));
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
    '<?xml version="1.0" encoding="UTF-8"?>\n<layouts>\n' +
    '\t<layout ID="L1">\n' +
    '\t\t<document_layout_name type="QString">Layout 1</document_layout_name>\n' +
    "\t</layout>\n" +
    "</layouts>"
  );
}

function buildBsBackgroundItem(
  uid: string,
  side: 4096 | 8192,
  binUUID: string,
  fileName: string,
  layoutId: string
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
    `\t\t\t<layout type="QString">${layoutId}</layout>\n` +
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
    buildBsBackgroundItem(frontUID, 4096, frontBinUUID, `${baseName}_front.png`, "L1") +
    "\n" +
    buildBsBackgroundItem(backUID, 8192, backBinUUID, `${baseName}_back.png`, "L1") +
    "\n</items>"
  );
}


// ── Badgy multi-person DB export helpers ──────────────────────────────────────

/** Transparent/empty background item – used in the DB export so the real card
 *  images live in the image_database layer, not the background. */
function buildBsBackgroundItemNone(uid: string, side: 4096 | 8192): string {
  return (
    `\t<item ID="${uid}">\n` +
    "\t\t<item>\n" +
    `\t\t\t<side type="int">${side}</side>\n` +
    `\t\t\t<userID type="QString">ITEM.${uid}</userID>\n` +
    '\t\t\t<layout type="QString">L1</layout>\n' +
    '\t\t\t<protected type="QString">true</protected>\n' +
    '\t\t\t<layer type="int">1</layer>\n' +
    `\t\t\t<UID type="QString">${uid}</UID>\n` +
    "\t\t</item>\n" +
    "\t\t<info>\n" +
    '\t\t\t<designObject type="QString">background</designObject>\n' +
    "\t\t</info>\n" +
    "\t\t<position>\n" +
    "\t\t\t<pos2>\n" +
    '\t\t\t\t<x type="QString">8573</x>\n' +
    '\t\t\t\t<y type="QString">5398</y>\n' +
    "\t\t\t</pos2>\n" +
    "\t\t\t<pos1>\n" +
    '\t\t\t\t<x type="QString">0</x>\n' +
    '\t\t\t\t<y type="QString">0</y>\n' +
    "\t\t\t</pos1>\n" +
    "\t\t</position>\n" +
    "\t\t<background>\n" +
    '\t\t\t<type type="QString">none</type>\n' +
    "\t\t</background>\n" +
    "\t</item>"
  );
}

/** image_database item: spans the full card and reads from `defaultTable.Image1`
 *  (front, side 4096) or `defaultTable.Image2` (back, side 8192).
 *  `binUUID` is the UUID for the preview .bin stored in design/FILES. */
function buildBsImageDatabaseItem(
  uid: string,
  side: 4096 | 8192,
  column: "Image1" | "Image2",
  binUUID: string
): string {
  return (
    `\t<item ID="${uid}">\n` +
    "\t\t<line>\n" +
    '\t\t\t<style type="QString">NoPen</style>\n' +
    "\t\t</line>\n" +
    "\t\t<imageAcquisition>\n" +
    "\t\t\t<transformations>\n" +
    "\t\t\t\t<color>\n" +
    '\t\t\t\t\t<negative type="bool">false</negative>\n' +
    '\t\t\t\t\t<monochrome type="bool">false</monochrome>\n' +
    "\t\t\t\t</color>\n" +
    "\t\t\t</transformations>\n" +
    "\t\t\t<picture>\n" +
    '\t\t\t\t<data type="QImage"></data>\n' +
    `\t\t\t\t<originalData type="QByteArray">design/FILES/items/${uid}/imageAcquisition/picture/originalData/{${binUUID}}.bin</originalData>\n` +
    "\t\t\t</picture>\n" +
    "\t\t\t<acquisition>\n" +
    '\t\t\t\t<autoOperation type="QString">DB</autoOperation>\n' +
    "\t\t\t</acquisition>\n" +
    "\t\t</imageAcquisition>\n" +
    "\t\t<image>\n" +
    '\t\t\t<fitOption type="QString">1</fitOption>\n' +
    "\t\t</image>\n" +
    "\t\t<item>\n" +
    '\t\t\t<layer type="int">322</layer>\n' +
    `\t\t\t<userID type="QString">ITEM.${uid}</userID>\n` +
    '\t\t\t<layout type="QString">L1</layout>\n' +
    `\t\t\t<side type="int">${side}</side>\n` +
    '\t\t\t<type type="QString">image_database</type>\n' +
    `\t\t\t<UID type="QString">${uid}</UID>\n` +
    "\t\t</item>\n" +
    "\t\t<info>\n" +
    '\t\t\t<designObject type="QString">image_database</designObject>\n' +
    "\t\t</info>\n" +
    "\t\t<position>\n" +
    "\t\t\t<pos1>\n" +
    '\t\t\t\t<y type="double">0</y>\n' +
    '\t\t\t\t<x type="double">0</x>\n' +
    "\t\t\t</pos1>\n" +
    "\t\t\t<pos2>\n" +
    '\t\t\t\t<y type="double">5398</y>\n' +
    '\t\t\t\t<x type="double">8573</x>\n' +
    "\t\t\t</pos2>\n" +
    "\t\t</position>\n" +
    "\t\t<fill>\n" +
    '\t\t\t<type type="QString">imageAcquisition.picture</type>\n' +
    "\t\t</fill>\n" +
    "\t\t<data>\n" +
    `\t\t\t<dbInnerInfo type="QString">defaultTable.${column}</dbInnerInfo>\n` +
    '\t\t\t<final type="QImage"></final>\n' +
    "\t\t</data>\n" +
    "\t\t<database>\n" +
    `\t\t\t<column type="QString">defaultTable.${column}</column>\n` +
    "\t\t</database>\n" +
    "\t\t<rotation>\n" +
    '\t\t\t<angle type="double">0</angle>\n' +
    "\t\t</rotation>\n" +
    "\t\t<background>\n" +
    "\t\t\t<type/>\n" +
    "\t\t</background>\n" +
    "\t</item>"
  );
}

/** Single-layout items.xml for DB-backed multi-person export.
 *  Two empty backgrounds (front/back) + two image_database items that
 *  read the full card PNGs per person from the SQLite defaultTable. */
function buildBsItemsXmlDb(
  frontBgUID: string,
  backBgUID: string,
  frontImgUID: string,
  frontImgBinUUID: string,
  backImgUID: string,
  backImgBinUUID: string
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<items>\n' +
    buildBsBackgroundItemNone(frontBgUID, 4096) + "\n" +
    buildBsBackgroundItemNone(backBgUID, 8192) + "\n" +
    buildBsImageDatabaseItem(frontImgUID, 4096, "Image1", frontImgBinUUID) + "\n" +
    buildBsImageDatabaseItem(backImgUID, 8192, "Image2", backImgBinUUID) + "\n" +
    "</items>"
  );
}

/** connection.xml declaring Image1 (front) and Image2 (back) as PHOTO columns.
 *  `rowCount` is used to mark all rows as checked for batch printing. */
function buildBsConnectionXmlWithImages(
  dbDocUUID: string,
  dbDataUUID: string,
  imgSettingsDocUUID: string,
  imgSettingsDataUUID: string,
  rowCount: number
): string {
  const checkedRows = Array.from({ length: rowCount }, (_, i) => i).join(",");
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
    `\t\t\t\t<defaultName0.model.checkedRows type="QString">${checkedRows}</defaultName0.model.checkedRows>\n` +
    '\t\t\t\t<defaultName0.model.hiddenColumns type="QString">defaultTable.id</defaultName0.model.hiddenColumns>\n' +
    '\t\t\t\t<defaultName0.queryInfo.tables type="QString">defaultTable</defaultName0.queryInfo.tables>\n' +
    '\t\t\t\t<defaultName0.queryInfo.primaryKeys.defaultTable type="QString">id</defaultName0.queryInfo.primaryKeys.defaultTable>\n' +
    '\t\t\t\t<defaultName0.queryInfo.tableSelection.defaultTable type="QString">id,Image1,Image2</defaultName0.queryInfo.tableSelection.defaultTable>\n' +
    '\t\t\t\t<defaultName0.formInfo.form type="QString">basic</defaultName0.formInfo.form>\n' +
    '\t\t\t\t<defaultName0.formInfo.styleSheet type="QString">b&amp;w</defaultName0.formInfo.styleSheet>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image1.dataType type="QString">PHOTO</defaultName0.queryInfo.columnProperties.defaultTable.Image1.dataType>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image1.caption type="QString">Front</defaultName0.queryInfo.columnProperties.defaultTable.Image1.caption>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image1.editable type="bool">true</defaultName0.queryInfo.columnProperties.defaultTable.Image1.editable>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image1.mandatory type="bool">false</defaultName0.queryInfo.columnProperties.defaultTable.Image1.mandatory>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image2.dataType type="QString">PHOTO</defaultName0.queryInfo.columnProperties.defaultTable.Image2.dataType>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image2.caption type="QString">Back</defaultName0.queryInfo.columnProperties.defaultTable.Image2.caption>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image2.editable type="bool">true</defaultName0.queryInfo.columnProperties.defaultTable.Image2.editable>\n' +
    '\t\t\t\t<defaultName0.queryInfo.columnProperties.defaultTable.Image2.mandatory type="bool">false</defaultName0.queryInfo.columnProperties.defaultTable.Image2.mandatory>\n' +
    "\t\t\t</SQLITE>\n\t\t</dataSets>\n" +
    "\t</connection>\n</connection>"
  );
}

/** Create a Badgy-compatible SQLite with one row per person.
 *  Image1 = full front card PNG, Image2 = full back card PNG.
 *  Uses the embedded empty SQLite template (which already has the correct schema). */
async function createBatchSqlite(
  entries: Array<{ frontBytes: Uint8Array; backBytes: Uint8Array }>
): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: () => sqlWasm });
  const db = new SQL.Database(bsBase64ToUint8Array(BADGY_EMPTY_SQLITE_B64));
  const stmt = db.prepare("INSERT INTO defaultTable (Image1, Image2) VALUES (?, ?)");
  for (const e of entries) {
    stmt.run([e.frontBytes, e.backBytes]);
  }
  stmt.free();
  const result = db.export();
  db.close();
  return result;
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

function defaultCategoryLabel(person: PersonRecord): string {
  switch (person.category) {
    case "volunteer":
      return i18n.t("category.volunteer");
    case "permanent_guest":
      return i18n.t("category.permanent_guest");
    case "volunteer_guest":
      return i18n.t("category.volunteer_guest");
    case "temporary_guest":
      return i18n.t("category.temporary_guest");
    default:
      return i18n.t("category.guest");
  }
}

function buildDefaultVCardSettings(person: PersonRecord): VCardSettings {
  const split = splitName(person.displayName);
  const firstName = split.firstName;
  const lastNameFromSheets = person.abbreviation?.trim() || split.lastName;
  const fullNameFromSheets = [firstName, lastNameFromSheets].filter(Boolean).join(" ").trim();
  const noteParts = [
    person.venue ? `${i18n.t("vcardDefaults.venue")}: ${person.venue}` : "",
    typeof person.invitations === "number"
      ? `${i18n.t("vcardDefaults.invitations")}: ${person.invitations}`
      : "",
    person.eventDate ? `${i18n.t("vcardDefaults.eventDate")}: ${person.eventDate}` : "",
    person.notes ? `${i18n.t("vcardDefaults.notes")}: ${person.notes}` : "",
  ].filter(Boolean);

  return {
    firstName: { enabled: true, value: firstName },
    lastName: { enabled: true, value: lastNameFromSheets },
    fullName: { enabled: true, value: fullNameFromSheets || person.displayName },
    organization: { enabled: true, value: "Collectif Nocturne" },
    role: { enabled: true, value: defaultCategoryLabel(person) },
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

const NfcMark = memo(function NfcMark() {
  const { t } = useTranslation();
  return (
    <svg viewBox="0 0 120 140" aria-label={t("illustrator.nfcAria")}>
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
});

const ToggleSwitch = memo(function ToggleSwitch({ checked, onChange, label }: ToggleSwitchProps) {
  const [localChecked, setLocalChecked] = useState(checked);

  useEffect(() => {
    setLocalChecked(checked);
  }, [checked]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.checked;
      setLocalChecked(next);
      startTransition(() => {
        onChange(next);
      });
    },
    [onChange]
  );

  return (
    <label className="switch-row">
      <span className="ios-toggle">
        <input type="checkbox" checked={localChecked} onChange={handleChange} />
        <span className="ios-toggle-slider" />
      </span>
      <span>{label}</span>
    </label>
  );
});

/**
 * Range input with local thumb.
 *
 * Two modes:
 *  - Default (no onPreviewChange): throttled parent updates via setInterval (~40 ms) during
 *    pointer drag so React re-renders are rate-limited. Used for sliders that don't have a
 *    cheap direct-DOM path.
 *  - Preview mode (onPreviewChange provided): fires synchronously on every input event with
 *    zero React overhead (caller does a direct DOM write). React state is updated only on
 *    drag end so the heavy export surfaces are never redrawn mid-drag.
 *
 * Keyboard / non-pointer interaction always goes through rAF-batched parent updates.
 */
const RANGE_DRAG_PARENT_INTERVAL_MS = 40;

type ResponsiveRangeInputProps = {
  value: number;
  onValueChange: (value: number) => void;
  /** When provided: fires synchronously on every input event during pointer drag. onValueChange is deferred to drag-end only. */
  onPreviewChange?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  renderOutput?: (local: number) => ReactNode;
};

const ResponsiveRangeInput = memo(function ResponsiveRangeInput({
  value,
  onValueChange,
  onPreviewChange,
  min,
  max,
  step = 1,
  renderOutput,
}: ResponsiveRangeInputProps) {
  const [local, setLocal] = useState(value);
  const pointerDraggingRef = useRef(false);
  const latestRef = useRef(value);
  const rafRef = useRef(0);
  const dragParentIntervalRef = useRef<number | null>(null);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const onPreviewChangeRef = useRef(onPreviewChange);
  onPreviewChangeRef.current = onPreviewChange;

  const flushParent = useCallback((v: number) => {
    startTransition(() => {
      onValueChangeRef.current(v);
    });
  }, []);

  const flushRaf = useCallback(() => {
    rafRef.current = 0;
    flushParent(latestRef.current);
  }, [flushParent]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(flushRaf);
  }, [flushRaf]);

  const clearDragParentInterval = useCallback(() => {
    if (dragParentIntervalRef.current != null) {
      clearInterval(dragParentIntervalRef.current);
      dragParentIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (pointerDraggingRef.current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror parent when value changes externally (reset, other tab); skipped while pointer-dragging
    setLocal(value);
    latestRef.current = value;
  }, [value]);

  useEffect(
    () => () => {
      clearDragParentInterval();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    },
    [clearDragParentInterval]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      latestRef.current = v;
      setLocal(v);
      // Always give the preview callback an immediate update (direct DOM write, no React).
      onPreviewChangeRef.current?.(v);
      if (!pointerDraggingRef.current) {
        // Keyboard / non-pointer: schedule React state update via rAF.
        scheduleFlush();
      }
      // Pointer drag: React state update deferred to drag end (preview mode) or interval (legacy mode).
    },
    [scheduleFlush]
  );

  const endPointerGesture = useCallback(() => {
    pointerDraggingRef.current = false;
    clearDragParentInterval();
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    flushParent(latestRef.current);
  }, [clearDragParentInterval, flushParent]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      pointerDraggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      clearDragParentInterval();
      if (onPreviewChangeRef.current) {
        // Preview mode: no interval. onPreviewChange writes directly to DOM every input event.
        // React state (and export surfaces) update only on drag end via endPointerGesture.
      } else {
        // Legacy throttled mode: rate-limit React re-renders via interval.
        requestAnimationFrame(() => {
          flushParent(latestRef.current);
        });
        dragParentIntervalRef.current = window.setInterval(() => {
          flushParent(latestRef.current);
        }, RANGE_DRAG_PARENT_INTERVAL_MS);
      }
    },
    [clearDragParentInterval, flushParent]
  );

  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={handleChange}
        onPointerDown={onPointerDown}
        onPointerUp={(e) => {
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* capture already released */
          }
          endPointerGesture();
        }}
        onPointerCancel={(e) => {
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* capture already released */
          }
          endPointerGesture();
        }}
      />
      {renderOutput != null ? <output>{renderOutput(local)}</output> : null}
    </>
  );
});

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

function SetAsDefaultButton({ onClick, label }: { onClick: () => void; label?: string }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn-set-default" onClick={onClick}>
      {label ?? t("illustrator.setAsDefault")}
    </button>
  );
}

export function BadgeIllustrator({ people }: BadgeIllustratorProps) {
  const { t } = useTranslation();

  const categoryRole = useCallback(
    (person: PersonRecord) => {
      switch (person.category) {
        case "volunteer":
          return t("category.volunteer");
        case "permanent_guest":
          return t("category.permanent_guest");
        case "volunteer_guest":
          return t("category.volunteer_guest");
        case "temporary_guest":
          return t("category.temporary_guest");
        default:
          return t("category.guest");
      }
    },
    [t]
  );

  const formatRangeOutputPct = useCallback((v: number) => `${v}%`, []);
  const formatRangeOutputPx = useCallback((v: number) => `${v}px`, []);
  const formatRangeOutputDeg = useCallback((v: number) => `${v}deg`, []);
  const formatRangeOutputDegSym = useCallback((v: number) => `${v}°`, []);
  const formatRoleEdgeOutput = useCallback((v: number) => (
    <>
      {v >= 0 ? "+" : ""}
      {v.toFixed(2)} cqw
    </>
  ), []);

  const [activePersonId, setActivePersonId] = useState(() => people[0].id);
  const personSnapshotsRef = useRef<Map<string, PersonEditableSnapshot>>(new Map());

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
    mergeVCardFromStored(buildDefaultVCardSettings(people[0]!), readIllustratorDefaultsCached().vCardSettings)
  );
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [coverImageSrc, setCoverImageSrc] = useState(collectifnocturneLogo);

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
  const [backFirstName, setBackFirstName] = useState(() => splitName(people[0]!.displayName).firstName);
  const [backLastName, setBackLastName] = useState(
    () => people[0]!.abbreviation?.trim() || splitName(people[0]!.displayName).lastName
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
  const showQrCodeRef = useRef(showQrCode);
  const vCardStringForQrRef = useRef("");
  const safeCardBgForQrRef = useRef("#1b1b1b");
  const frontQrDebounceTimerRef = useRef<number | null>(null);
  const prevShowQrForEffectRef = useRef(false);
  const prevCardBgForQrEffectRef = useRef("");

  // Live refs that track positioning values independently of React state.
  // Used by onPreviewChange callbacks to write transforms directly to the preview DOM
  // without triggering any React re-render during pointer drag.
  const liveLogoRef = useRef({ zoom: logoZoom, x: logoOffsetX, y: logoOffsetY, z: logoOffsetZ });
  const liveQrRef = useRef({ topPct: qrTopPct, rightPct: qrRightPct, widthPct: qrWidthPct, offsetX: qrOffsetX, offsetY: qrOffsetY, offsetZ: qrOffsetZ, zoom: qrZoom });
  const liveNfcRef = useRef({ bottomPct: nfcBottomPct, rightPct: nfcRightPct, widthPct: nfcWidthPct, offsetX: nfcOffsetX, offsetY: nfcOffsetY, offsetZ: nfcOffsetZ, zoom: nfcZoom });
  const livePhotoRef = useRef({ zoom: photoZoom, offsetX: photoOffsetX, offsetY: photoOffsetY, rotation: photoRotation });

  const activePerson = useMemo(
    () => people.find((p) => p.id === activePersonId) ?? people[0],
    [people, activePersonId]
  );

  const loadPersonDataIntoState = useCallback((p: PersonRecord) => {
    const existing = personSnapshotsRef.current.get(p.id);
    if (existing) {
      setVCardSettings(structuredClone(existing.vCardSettings));
      setBackFirstName(existing.backFirstName);
      setBackLastName(existing.backLastName);
      const url = existing.profilePhotoUrl;
      if (photoUrlRef.current && photoUrlRef.current !== url) {
        URL.revokeObjectURL(photoUrlRef.current);
      }
      photoUrlRef.current = url.startsWith("blob:") ? url : "";
      setProfilePhotoUrl(url);
    } else {
      setVCardSettings(
        mergeVCardFromStored(buildDefaultVCardSettings(p), readIllustratorDefaultsCached().vCardSettings)
      );
      setBackFirstName(splitName(p.displayName).firstName);
      setBackLastName(p.abbreviation?.trim() || splitName(p.displayName).lastName);
      if (photoUrlRef.current) {
        URL.revokeObjectURL(photoUrlRef.current);
        photoUrlRef.current = "";
      }
      setProfilePhotoUrl("");
    }
  }, []);

  const flushCurrentPersonSnapshot = useCallback(() => {
    if (!activePersonId) return;
    personSnapshotsRef.current.set(activePersonId, {
      vCardSettings: structuredClone(vCardSettings),
      backFirstName,
      backLastName,
      profilePhotoUrl,
    });
  }, [activePersonId, vCardSettings, backFirstName, backLastName, profilePhotoUrl]);

  const handlePersonTabClick = useCallback(
    (newId: string) => {
      if (newId === activePersonId) return;
      flushCurrentPersonSnapshot();
      flushSync(() => {
        setActivePersonId(newId);
        const p = people.find((x) => x.id === newId);
        if (p) loadPersonDataIntoState(p);
      });
    },
    [activePersonId, flushCurrentPersonSnapshot, loadPersonDataIntoState, people]
  );

  useEffect(() => {
    const valid = new Set(people.map((p) => p.id));
    for (const key of [...personSnapshotsRef.current.keys()]) {
      if (!valid.has(key)) {
        const snap = personSnapshotsRef.current.get(key);
        if (snap?.profilePhotoUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(snap.profilePhotoUrl);
        }
        personSnapshotsRef.current.delete(key);
      }
    }
  }, [people]);

  useEffect(() => {
    return () => {
      for (const snap of personSnapshotsRef.current.values()) {
        if (snap.profilePhotoUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(snap.profilePhotoUrl);
        }
      }
      personSnapshotsRef.current.clear();
      if (photoUrlRef.current) {
        URL.revokeObjectURL(photoUrlRef.current);
        photoUrlRef.current = "";
      }
    };
  }, []);

  useEffect(() => {
    if (people.some((p) => p.id === activePersonId)) return;
    const next = people[0];
    if (!next) return;
    flushCurrentPersonSnapshot();
    flushSync(() => {
      setActivePersonId(next.id);
      loadPersonDataIntoState(next);
    });
  }, [people, activePersonId, loadPersonDataIntoState, flushCurrentPersonSnapshot]);

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
    return PERSON_TYPE_META.find((o) => o.value === personType)?.displayLabel || "BENEVOLE";
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

  const backQrPayload = useMemo(() => buildEventManagerQrPayload(activePerson), [activePerson]);

  previewRoleOffsetXRef.current = previewRoleOffsetX;
  exportRoleOffsetXRef.current = exportRoleOffsetX;
  roleEdgeAdjustCqwByTypeRef.current = roleEdgeAdjustCqwByType;
  vCardStringForQrRef.current = vCardString;
  safeCardBgForQrRef.current = safeCardBackgroundColor;
  showQrCodeRef.current = showQrCode;
  liveLogoRef.current = { zoom: logoZoom, x: logoOffsetX, y: logoOffsetY, z: logoOffsetZ };
  liveQrRef.current = { topPct: qrTopPct, rightPct: qrRightPct, widthPct: qrWidthPct, offsetX: qrOffsetX, offsetY: qrOffsetY, offsetZ: qrOffsetZ, zoom: qrZoom };
  liveNfcRef.current = { bottomPct: nfcBottomPct, rightPct: nfcRightPct, widthPct: nfcWidthPct, offsetX: nfcOffsetX, offsetY: nfcOffsetY, offsetZ: nfcOffsetZ, zoom: nfcZoom };
  livePhotoRef.current = { zoom: photoZoom, offsetX: photoOffsetX, offsetY: photoOffsetY, rotation: photoRotation };

  // Front QR code (vCard): debounce while typing; immediate when enabling QR or changing card background.
  useEffect(() => {
    if (!showQrCode) {
      if (frontQrDebounceTimerRef.current != null) {
        clearTimeout(frontQrDebounceTimerRef.current);
        frontQrDebounceTimerRef.current = null;
      }
      prevShowQrForEffectRef.current = false;
      startTransition(() => setQrDataUrl(""));
      return;
    }

    const openedQr = !prevShowQrForEffectRef.current;
    prevShowQrForEffectRef.current = true;
    const bgChanged = prevCardBgForQrEffectRef.current !== safeCardBackgroundColor;
    prevCardBgForQrEffectRef.current = safeCardBackgroundColor;

    let cancelled = false;
    const run = () => {
      QRCode.toDataURL(vCardString, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 520,
        color: { dark: "#f3f4f6", light: safeCardBackgroundColor },
      })
        .then((url) => {
          if (!cancelled) startTransition(() => setQrDataUrl(url));
        })
        .catch(() => {
          if (!cancelled) startTransition(() => setQrDataUrl(""));
        });
    };

    if (frontQrDebounceTimerRef.current != null) {
      clearTimeout(frontQrDebounceTimerRef.current);
      frontQrDebounceTimerRef.current = null;
    }

    if (openedQr || bgChanged) {
      run();
    } else {
      frontQrDebounceTimerRef.current = window.setTimeout(() => {
        frontQrDebounceTimerRef.current = null;
        if (!cancelled) run();
      }, 220);
    }

    return () => {
      cancelled = true;
      if (frontQrDebounceTimerRef.current != null) {
        clearTimeout(frontQrDebounceTimerRef.current);
        frontQrDebounceTimerRef.current = null;
      }
    };
  }, [showQrCode, vCardString, safeCardBackgroundColor]);

  // Back QR code (EventManagerApp JSON format — margin 1, error correction L)
  useEffect(() => {
    if (!showBackQr || !backQrPayload) {
      startTransition(() => setBackQrDataUrl(""));
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
        if (!isCancelled) startTransition(() => setBackQrDataUrl(url));
      })
      .catch(() => {
        if (!isCancelled) startTransition(() => setBackQrDataUrl(""));
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
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const h = container.clientHeight;
        setPreviewRoleContainerHeight((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [roleLabel, roleSizeAdjust, selectedSide]);

  useLayoutEffect(() => {
    const container = exportBackRoleContainerRef.current;
    if (!container) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const h = container.clientHeight;
        setExportRoleContainerHeight((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [roleLabel, roleSizeAdjust]);

  function updateField<K extends keyof VCardSettings>(field: K, partial: Partial<VCardSettings[K]>) {
    setVCardSettings((old) => ({ ...old, [field]: { ...old[field], ...partial } }));
  }

  // ─── Direct DOM preview updaters ─────────────────────────────────────────
  // These write straight to the preview card's DOM elements, bypassing React
  // reconciliation during pointer drag. No re-renders occur; export surfaces
  // are updated only once on drag end via the normal onValueChange path.

  const applyPreviewLogoTransform = useCallback(() => {
    const el = previewCardRef.current?.querySelector<HTMLElement>(".badge-cover");
    if (!el) return;
    const { zoom, x, y, z } = liveLogoRef.current;
    const scale = Math.max(0.2, zoom / 100);
    const xCqw = x * DESIGN_X_TO_CQW;
    const yCqh = y * DESIGN_Y_TO_CQH;
    el.style.transform = `translate(calc(-50% + ${xCqw}cqw), calc(-50% + ${yCqh}cqh)) scale(${scale}) rotate(${z}deg)`;
  }, []);

  const applyPreviewQrStyle = useCallback(() => {
    const el = previewCardRef.current?.querySelector<HTMLElement>(".badge-qr");
    if (!el) return;
    const { topPct, rightPct, widthPct, offsetX, offsetY, offsetZ, zoom } = liveQrRef.current;
    const xCqw = offsetX * DESIGN_X_TO_CQW;
    const yCqh = offsetY * DESIGN_Y_TO_CQH;
    el.style.top = `${topPct}%`;
    el.style.right = `${rightPct}%`;
    el.style.width = `${widthPct}%`;
    el.style.transform = `translate(${xCqw}cqw, ${yCqh}cqh) scale(${Math.max(0.05, zoom / 100)}) rotate(${offsetZ}deg)`;
  }, []);

  const applyPreviewNfcStyle = useCallback(() => {
    const el = previewCardRef.current?.querySelector<HTMLElement>(".badge-nfc");
    if (!el) return;
    const { bottomPct, rightPct, widthPct, offsetX, offsetY, offsetZ, zoom } = liveNfcRef.current;
    const xCqw = offsetX * DESIGN_X_TO_CQW;
    const yCqh = offsetY * DESIGN_Y_TO_CQH;
    el.style.bottom = `${bottomPct}%`;
    el.style.right = `${rightPct}%`;
    el.style.width = `${widthPct}%`;
    el.style.transform = `translate(${xCqw}cqw, ${yCqh}cqh) scale(${Math.max(0.05, zoom / 100)}) rotate(${offsetZ}deg)`;
  }, []);

  const applyPreviewPhotoStyle = useCallback(() => {
    const el = previewCardRef.current?.querySelector<HTMLElement>(".back-photo-img");
    if (!el) return;
    const { zoom, offsetX, offsetY, rotation } = livePhotoRef.current;
    const scale = Math.max(1, zoom / 100);
    const posX = Math.max(0, Math.min(100, 50 + offsetX / 4));
    const posY = Math.max(0, Math.min(100, 50 + offsetY / 4));
    el.style.transform = `scale(${scale}) rotate(${rotation}deg)`;
    el.style.objectPosition = `${posX}% ${posY}%`;
  }, []);

  // Stable onPreviewChange callbacks – one per slider, all zero-dep (use refs only).
  const onPreviewLogoZoom = useCallback((v: number) => { liveLogoRef.current.zoom = v; applyPreviewLogoTransform(); }, [applyPreviewLogoTransform]);
  const onPreviewLogoOffsetX = useCallback((v: number) => { liveLogoRef.current.x = v; applyPreviewLogoTransform(); }, [applyPreviewLogoTransform]);
  const onPreviewLogoOffsetY = useCallback((v: number) => { liveLogoRef.current.y = v; applyPreviewLogoTransform(); }, [applyPreviewLogoTransform]);
  const onPreviewLogoOffsetZ = useCallback((v: number) => { liveLogoRef.current.z = v; applyPreviewLogoTransform(); }, [applyPreviewLogoTransform]);

  const onPreviewQrTopPct = useCallback((v: number) => { liveQrRef.current.topPct = v; applyPreviewQrStyle(); }, [applyPreviewQrStyle]);
  const onPreviewQrRightPct = useCallback((v: number) => { liveQrRef.current.rightPct = v; applyPreviewQrStyle(); }, [applyPreviewQrStyle]);
  const onPreviewQrWidthPct = useCallback((v: number) => { liveQrRef.current.widthPct = v; applyPreviewQrStyle(); }, [applyPreviewQrStyle]);
  const onPreviewQrOffsetX = useCallback((v: number) => { liveQrRef.current.offsetX = v; applyPreviewQrStyle(); }, [applyPreviewQrStyle]);
  const onPreviewQrOffsetY = useCallback((v: number) => { liveQrRef.current.offsetY = v; applyPreviewQrStyle(); }, [applyPreviewQrStyle]);
  const onPreviewQrOffsetZ = useCallback((v: number) => { liveQrRef.current.offsetZ = v; applyPreviewQrStyle(); }, [applyPreviewQrStyle]);
  const onPreviewQrZoom = useCallback((v: number) => { liveQrRef.current.zoom = v; applyPreviewQrStyle(); }, [applyPreviewQrStyle]);

  const onPreviewNfcBottomPct = useCallback((v: number) => { liveNfcRef.current.bottomPct = v; applyPreviewNfcStyle(); }, [applyPreviewNfcStyle]);
  const onPreviewNfcRightPct = useCallback((v: number) => { liveNfcRef.current.rightPct = v; applyPreviewNfcStyle(); }, [applyPreviewNfcStyle]);
  const onPreviewNfcWidthPct = useCallback((v: number) => { liveNfcRef.current.widthPct = v; applyPreviewNfcStyle(); }, [applyPreviewNfcStyle]);
  const onPreviewNfcOffsetX = useCallback((v: number) => { liveNfcRef.current.offsetX = v; applyPreviewNfcStyle(); }, [applyPreviewNfcStyle]);
  const onPreviewNfcOffsetY = useCallback((v: number) => { liveNfcRef.current.offsetY = v; applyPreviewNfcStyle(); }, [applyPreviewNfcStyle]);
  const onPreviewNfcOffsetZ = useCallback((v: number) => { liveNfcRef.current.offsetZ = v; applyPreviewNfcStyle(); }, [applyPreviewNfcStyle]);
  const onPreviewNfcZoom = useCallback((v: number) => { liveNfcRef.current.zoom = v; applyPreviewNfcStyle(); }, [applyPreviewNfcStyle]);

  const onPreviewPhotoZoom = useCallback((v: number) => { livePhotoRef.current.zoom = v; applyPreviewPhotoStyle(); }, [applyPreviewPhotoStyle]);
  const onPreviewPhotoOffsetX = useCallback((v: number) => { livePhotoRef.current.offsetX = v; applyPreviewPhotoStyle(); }, [applyPreviewPhotoStyle]);
  const onPreviewPhotoOffsetY = useCallback((v: number) => { livePhotoRef.current.offsetY = v; applyPreviewPhotoStyle(); }, [applyPreviewPhotoStyle]);
  const onPreviewPhotoRotation = useCallback((v: number) => { livePhotoRef.current.rotation = v; applyPreviewPhotoStyle(); }, [applyPreviewPhotoStyle]);
  // ─────────────────────────────────────────────────────────────────────────

  const handlePersonTypeChange = useCallback((newType: BadgePersonType) => {
    setPersonType(newType);
    const option = PERSON_TYPE_META.find((o) => o.value === newType);
    if (option) setAccentColor(option.defaultAccent);
  }, []);

  const flashDefaultsSaved = useCallback(
    (message?: string) => {
      setDefaultsHint(message ?? t("illustrator.defaultsSaved"));
      window.setTimeout(() => setDefaultsHint(""), 2200);
    },
    [t]
  );

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
    setAccentColor(PERSON_TYPE_META.find((o) => o.value === f.personType)?.defaultAccent ?? f.accentColor);
    setSecondaryColor(f.secondaryColor);
    setPhotoFrameShape(f.photoFrameShape);
    setPhotoZoom(f.photoZoom);
    setPhotoOffsetX(f.photoOffsetX);
    setPhotoOffsetY(f.photoOffsetY);
    setPhotoRotation(f.photoRotation);
    setShowBackQr(f.showBackQr);
    setRoleSizeAdjust(f.roleSizeAdjust);
    setRoleEdgeAdjustCqwByType({ ...FACTORY_ROLE_EDGE_CQW });
    setVCardSettings(buildDefaultVCardSettings(activePerson));
    setBackFirstName(splitName(activePerson.displayName).firstName);
    setBackLastName(activePerson.abbreviation?.trim() || splitName(activePerson.displayName).lastName);
    setProfilePhotoUrl("");
    if (photoUrlRef.current) {
      URL.revokeObjectURL(photoUrlRef.current);
      photoUrlRef.current = "";
    }
    flashDefaultsSaved(t("illustrator.factoryRestored"));
  }, [activePerson, flashDefaultsSaved, t]);

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
    () =>
      sanitizeFileName(
        [backFirstName, backLastName].filter(Boolean).join(" ").trim() || activePerson.displayName
      ),
    [backFirstName, backLastName, activePerson.displayName]
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
      // Keep user edge adjustment additive across remount/reselect.
      const targetAligned = targetTotal;
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
      // Keep user edge adjustment additive across remount/reselect.
      const targetAligned = targetTotal;
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
        const dataBytes = new Uint8Array(await blob.arrayBuffer());
        await electronApi.saveBinaryFile({
          defaultFileName: fileName,
          filters,
          dataBytes,
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
        throw new Error(i18n.t("errors.exportSurfaceUnavailable"));
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

  const flushFrontQrForExport = useCallback(async () => {
    if (frontQrDebounceTimerRef.current != null) {
      clearTimeout(frontQrDebounceTimerRef.current);
      frontQrDebounceTimerRef.current = null;
    }
    if (!showQrCodeRef.current) return;
    try {
      const url = await QRCode.toDataURL(vCardStringForQrRef.current, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 520,
        color: { dark: "#f3f4f6", light: safeCardBgForQrRef.current },
      });
      setQrDataUrl(url);
    } catch {
      setQrDataUrl("");
    }
    await waitRenderSettled();
  }, [waitRenderSettled]);

  const waitForQrAfterPersonChange = useCallback(async () => {
    await flushFrontQrForExport();
    await new Promise<void>((r) => setTimeout(r, 80));
  }, [flushFrontQrForExport]);

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      const batch = people.length > 1;
      const initialActiveId = activePersonId;

      const activatePersonForBatch = (p: PersonRecord) => {
        flushCurrentPersonSnapshot();
        flushSync(() => {
          setActivePersonId(p.id);
          loadPersonDataIntoState(p);
        });
      };

      const restoreInitialPerson = () => {
        const back = people.find((x) => x.id === initialActiveId);
        if (!back) return;
        flushCurrentPersonSnapshot();
        flushSync(() => {
          setActivePersonId(initialActiveId);
          loadPersonDataIntoState(back);
        });
      };

      try {
        setIsExporting(true);
        setExportNotice(
          format === "canva"
            ? t("export.preparingCanva")
            : batch
              ? t("export.exportingBatch", { format: format.toUpperCase(), count: people.length })
              : t("export.exportingFor", { format: format.toUpperCase() })
        );
        setIsExportMenuOpen(false);
        flushCurrentPersonSnapshot();
        await flushFrontQrForExport();

        if (format === "pdf") {
          if (batch) {
            const used = new Set<string>();
            const zip = new JSZip();
            for (const p of people) {
              activatePersonForBatch(p);
              await waitForQrAfterPersonChange();
              flushCurrentPersonSnapshot();
              const snap = personSnapshotsRef.current.get(p.id);
              const baseStem = sanitizeFileName(
                snap
                  ? [snap.backFirstName, snap.backLastName].filter(Boolean).join(" ").trim() || p.displayName
                  : p.displayName
              );
              const unique = allocUniqueExportStem(baseStem, used);
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
              zip.file(`${unique}.pdf`, blob);
            }
            zip.file("README.txt", t("export.readmePdfBatch"));
            const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            await saveBlob(archive, `badges_export_pdf.zip`, [
              { name: t("export.filterZip"), extensions: ["zip"] },
              { name: t("export.filterPdf"), extensions: ["pdf"] },
            ]);
            setExportNotice(t("export.zipPdfSaved", { count: people.length }));
            return;
          }

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
          await saveBlob(blob, `${exportBaseName}.pdf`, [{ name: t("export.filterPdf"), extensions: ["pdf"] }]);
          setExportNotice(t("export.pdfSingle"));
          return;
        }

        if (format === "canva") {
          const electronApi = window.electronAPI as ElectronExportAPI | undefined;
          if (!electronApi?.canvaGetStatus || !electronApi?.canvaSendPdf) {
            setExportNotice(t("export.canvaNeedsDesktop"));
            return;
          }
          const status = await electronApi.canvaGetStatus();
          if (!status.hasCredentials) {
            setExportNotice(t("export.canvaConfigureSettings"));
            return;
          }
          if (!status.connected) {
            setExportNotice(t("export.canvaConnectAccount"));
            return;
          }

          const runAutofillForActiveSnapshot = async (personId: string, title: string) => {
            await waitRenderSettled();
            flushCurrentPersonSnapshot();
            const snap = personSnapshotsRef.current.get(personId);
            const vc = snap?.vCardSettings ?? vCardSettings;
            const fn = snap?.backFirstName ?? backFirstName;
            const ln = snap?.backLastName ?? backLastName;

            const texts: Record<string, string> = {
              [CANVA_TEXT_FIELDS.FIRST_NAME]: fn,
              [CANVA_TEXT_FIELDS.LAST_NAME]: ln,
              [CANVA_TEXT_FIELDS.ROLE]: roleLabel,
            };
            if (vc.organization.enabled && vc.organization.value.trim()) {
              texts[CANVA_TEXT_FIELDS.ORG] = vc.organization.value.trim();
            }

            const imagesBase64: Record<string, string> = {};
            const frontRoot = exportFrontRef.current;
            const backRoot = exportBackRef.current;

            const logoB64 = await captureCanvaFieldPng(frontRoot, CANVA_IMAGE_FIELDS.LOGO);
            if (logoB64) imagesBase64[CANVA_IMAGE_FIELDS.LOGO] = logoB64;

            const qrVcardB64 = await captureCanvaFieldPng(
              frontRoot,
              CANVA_IMAGE_FIELDS.QR_VCARD,
              safeCardBackgroundColor
            );
            if (qrVcardB64) imagesBase64[CANVA_IMAGE_FIELDS.QR_VCARD] = qrVcardB64;

            const nfcB64 = await captureCanvaFieldPng(frontRoot, CANVA_IMAGE_FIELDS.NFC, safeCardBackgroundColor);
            if (nfcB64) imagesBase64[CANVA_IMAGE_FIELDS.NFC] = nfcB64;

            const qrEventB64 = await captureCanvaFieldPng(backRoot, CANVA_IMAGE_FIELDS.QR_EVENT, safeCardBackgroundColor);
            if (qrEventB64) imagesBase64[CANVA_IMAGE_FIELDS.QR_EVENT] = qrEventB64;

            const photoB64 = await captureCanvaFieldPng(backRoot, CANVA_IMAGE_FIELDS.PHOTO);
            if (photoB64) imagesBase64[CANVA_IMAGE_FIELDS.PHOTO] = photoB64;

            await electronApi.canvaSendBadgeAutofill!({
              title: title.slice(0, 200),
              texts,
              imagesBase64,
              ...(status.brandTemplateId ? { brandTemplateId: status.brandTemplateId } : {}),
            });
          };

          if (status.hasBrandTemplate) {
            if (!electronApi.canvaSendBadgeAutofill) {
              setExportNotice(t("export.canvaAutofillUnavailable"));
              return;
            }
            if (batch) {
              setExportNotice(t("export.canvaSendingBatchAutofill", { count: people.length }));
              for (let i = 0; i < people.length; i++) {
                const p = people[i];
                activatePersonForBatch(p);
                await waitForQrAfterPersonChange();
                flushCurrentPersonSnapshot();
                const snap = personSnapshotsRef.current.get(p.id)!;
                const title = sanitizeFileName(
                  [snap.backFirstName, snap.backLastName].filter(Boolean).join(" ").trim() || p.displayName
                );
                setExportNotice(t("export.canvaAutofillProgress", { current: i + 1, total: people.length }));
                await runAutofillForActiveSnapshot(p.id, title);
              }
              setExportNotice(t("export.canvaOpenedBatchAutofill", { count: people.length }));
              return;
            }

            setExportNotice(t("export.canvaPreparingLayers"));
            await runAutofillForActiveSnapshot(activePerson.id, exportBaseName);
            setExportNotice(t("export.canvaOpenedLayers"));
            return;
          }

          if (batch) {
            setExportNotice(t("export.canvaSendingBatchPdf", { count: people.length }));
            for (let i = 0; i < people.length; i++) {
              const p = people[i];
              activatePersonForBatch(p);
              await waitForQrAfterPersonChange();
              flushCurrentPersonSnapshot();
              const snap = personSnapshotsRef.current.get(p.id)!;
              const title = sanitizeFileName(
                [snap.backFirstName, snap.backLastName].filter(Boolean).join(" ").trim() || p.displayName
              );
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
              setExportNotice(t("export.canvaPdfProgress", { current: i + 1, total: people.length }));
              await electronApi.canvaSendPdf({ pdfBase64, title: title.slice(0, 50) });
            }
            setExportNotice(t("export.canvaOpenedBatchPdf", { count: people.length }));
            return;
          }

          setExportNotice(t("export.canvaSendingPdf"));
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
          setExportNotice(t("export.canvaOpenedPdfFallback"));
          return;
        }

        if (format === "bs") {
          const docUUID = crypto.randomUUID();
          const dbDocUUID = crypto.randomUUID();
          const dbDataUUID = crypto.randomUUID();
          const imgSettingsDocUUID = crypto.randomUUID();
          const imgSettingsDataUUID = crypto.randomUUID();
          const sqliteBytes = bsBase64ToUint8Array(BADGY_EMPTY_SQLITE_B64);

          if (batch) {
            // Multi-person .bs: single design + SQLite database with one row per person.
            // Image1 = full front card PNG, Image2 = full back card PNG, per row.
            // image_database items in the design layer switch automatically per record.
            const sqlEntries: Array<{ frontBytes: Uint8Array; backBytes: Uint8Array }> = [];
            let firstFrontBytes: Uint8Array | null = null;
            let firstBackBytes: Uint8Array | null = null;

            for (const p of people) {
              activatePersonForBatch(p);
              await waitForQrAfterPersonChange();
              flushCurrentPersonSnapshot();
              const { front, back } = await captureBothSides("png");
              const frontBytes = bsBase64ToUint8Array(stripDataUrlPrefix(front));
              const backBytes = bsBase64ToUint8Array(stripDataUrlPrefix(back));
              sqlEntries.push({ frontBytes, backBytes });
              if (!firstFrontBytes) firstFrontBytes = frontBytes;
              if (!firstBackBytes) firstBackBytes = backBytes;
            }

            setExportNotice(t("export.bsBuilding"));
            const bsSqliteBytes = await createBatchSqlite(sqlEntries);

            const frontBgUID = generateBsHexUID();
            const backBgUID = generateBsHexUID();
            const frontImgUID = generateBsHexUID();
            const backImgUID = generateBsHexUID();
            const frontImgBinUUID = crypto.randomUUID();
            const backImgBinUUID = crypto.randomUUID();

            const zip = new JSZip();
            zip.file("document/info.xml", buildBsInfoXml(docUUID));
            zip.file("document/events.xml", buildBsEventsXml());
            zip.file("design/layouts.xml", buildBsLayoutsXml());
            zip.file(
              "design/items.xml",
              buildBsItemsXmlDb(frontBgUID, backBgUID, frontImgUID, frontImgBinUUID, backImgUID, backImgBinUUID)
            );
            // Preview images for Badgy Studio's designer (first person shown in editor)
            if (firstFrontBytes) {
              zip.file(
                `design/FILES/items/${frontImgUID}/imageAcquisition/picture/originalData/{${frontImgBinUUID}}.bin`,
                firstFrontBytes
              );
            }
            if (firstBackBytes) {
              zip.file(
                `design/FILES/items/${backImgUID}/imageAcquisition/picture/originalData/{${backImgBinUUID}}.bin`,
                firstBackBytes
              );
            }
            zip.file("print/print.xml", buildBsPrintXml());
            zip.file(
              "database/connection.xml",
              buildBsConnectionXmlWithImages(dbDocUUID, dbDataUUID, imgSettingsDocUUID, imgSettingsDataUUID, people.length)
            );
            zip.file(
              `database/connection/connection/properties/SQLITE/dataSourceData/{${dbDataUUID}}.sqlite`,
              bsSqliteBytes
            );
            zip.file(
              `database/connection/connection/properties/imageSettings/dataSourceData/{${imgSettingsDataUUID}}.sqlite`,
              new Uint8Array(0)
            );
            zip.file("database/import/properties.json", "{\n}");
            zip.file("encoding/encoding.xml", buildBsEncodingXml());

            const blob = await zip.generateAsync({
              type: "blob",
              compression: "DEFLATE",
              compressionOptions: { level: 6 },
            });
            await saveBlob(blob, `badges_batch_${people.length}.bs`, [{ name: t("export.filterBadgy"), extensions: ["bs"] }], true);
            setExportNotice(t("export.bsBatchDone", { count: people.length }));
            return;
          }

          const { front, back } = await captureBothSides("png");
          const frontUID = generateBsHexUID();
          const backUID = generateBsHexUID();
          const frontBinUUID = crypto.randomUUID();
          const backBinUUID = crypto.randomUUID();
          const frontBytes = bsBase64ToUint8Array(stripDataUrlPrefix(front));
          const backBytes = bsBase64ToUint8Array(stripDataUrlPrefix(back));

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
          await saveBlob(blob, `${exportBaseName}.bs`, [{ name: t("export.filterBadgy"), extensions: ["bs"] }], true);
          setExportNotice(t("export.bsSingleDone"));
          return;
        }

        const extension = format;
        const mimeType = format === "svg" ? "image/svg+xml" : format === "jpg" ? "image/jpeg" : "image/png";

        if (batch) {
          const used = new Set<string>();
          const zip = new JSZip();
          for (const p of people) {
            activatePersonForBatch(p);
            await waitForQrAfterPersonChange();
            flushCurrentPersonSnapshot();
            const snap = personSnapshotsRef.current.get(p.id);
            const baseStem = sanitizeFileName(
              snap
                ? [snap.backFirstName, snap.backLastName].filter(Boolean).join(" ").trim() || p.displayName
                : p.displayName
            );
            const unique = allocUniqueExportStem(baseStem, used);
            const { front, back } = await captureBothSides(format);
            zip.file(`${unique}_front.${extension}`, stripDataUrlPrefix(front), { base64: true });
            zip.file(`${unique}_back.${extension}`, stripDataUrlPrefix(back), { base64: true });
          }
          zip.file("README.txt", t("export.readmeRasterBatch", { ext: extension }));
          const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
          await saveBlob(archive, `badges_export_${extension}.zip`, [
            { name: t("export.filterZip"), extensions: ["zip"] },
            { name: mimeType, extensions: [extension] },
          ]);
          setExportNotice(t("export.rasterBatchDone", { format: format.toUpperCase(), count: people.length }));
          return;
        }

        const { front, back } = await captureBothSides(format);
        const zip = new JSZip();
        zip.file(`front.${extension}`, stripDataUrlPrefix(front), { base64: true });
        zip.file(`back.${extension}`, stripDataUrlPrefix(back), { base64: true });
        zip.file("README.txt", t("export.readmeRasterSingle"));
        const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
        await saveBlob(archive, `${exportBaseName}-${extension}.zip`, [
          { name: t("export.filterZip"), extensions: ["zip"] },
          { name: mimeType, extensions: [extension] },
        ]);
        setExportNotice(t("export.rasterSingleDone", { format: format.toUpperCase() }));
      } catch (error) {
        setExportNotice(error instanceof Error ? error.message : t("export.exportFailed"));
      } finally {
        if (batch) {
          restoreInitialPerson();
        }
        setIsExporting(false);
      }
    },
    [
      activePerson.id,
      activePersonId,
      backFirstName,
      backLastName,
      captureBothSides,
      exportBaseName,
      flushCurrentPersonSnapshot,
      flushFrontQrForExport,
      loadPersonDataIntoState,
      people,
      roleLabel,
      safeCardBackgroundColor,
      saveBlob,
      vCardSettings,
      waitForQrAfterPersonChange,
      waitRenderSettled,
      t,
    ]
  );

  const onCoverImageError = useCallback(() => {
    setCoverImageSrc(coverTemplateImage);
  }, []);

  const frontBadgeMarkup = useMemo(
    () => (
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
          onError={onCoverImageError}
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
    ),
    [
      coverImageSrc,
      logoTransform,
      nfcBlockTransform,
      nfcBottomPct,
      nfcRightPct,
      nfcWidthPct,
      onCoverImageError,
      qrDataUrl,
      qrImgStyleTransform,
      qrRightPct,
      qrTopPct,
      qrWidthPct,
      safeCardBackgroundColor,
      showNfcMark,
      showQrCode,
    ]
  );

  const previewBackBadgeMarkup = useMemo(() => {
    const roleTransform = `translateX(calc(${previewRoleOffsetX}px + ${roleEdgeAdjustCqw}cqw))`;
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
                WebkitMaskImage: `url(${collectifnocturneLogo})`,
                maskImage: `url(${collectifnocturneLogo})`,
              }}
            />
            <span
              className="back-logo-mask back-logo-mask--groove"
              aria-label="Le Groove"
              style={{
                backgroundColor: safeSecondaryColor,
                WebkitMaskImage: `url(${legrooveLogo})`,
                maskImage: `url(${legrooveLogo})`,
              }}
            />
            <span
              className="back-logo-mask back-logo-mask--terreau"
              aria-label="Le Terreau"
              style={{
                backgroundColor: safeSecondaryColor,
                WebkitMaskImage: `url(${logoTerreau})`,
                maskImage: `url(${logoTerreau})`,
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

        <div className="back-role-container" ref={roleTextContainerRef}>
          <span
            className="back-role-label"
            ref={roleLabelRef}
            style={{
              color: safeAccentColor,
              fontSize: `${previewRoleTextFontSize}px`,
              transform: roleTransform,
            }}
          >
            {roleLabel}
          </span>
        </div>
      </>
    );
  }, [
    backFirstName,
    backLastName,
    backQrDataUrl,
    photoFrameShape,
    photoPositionX,
    photoPositionY,
    photoTransform,
    previewRoleOffsetX,
    previewRoleTextFontSize,
    profilePhotoUrl,
    roleEdgeAdjustCqw,
    roleLabel,
    safeAccentColor,
    safeSecondaryColor,
    showBackQr,
  ]);

  const exportBackBadgeMarkup = useMemo(() => {
    const roleTransform = `translateX(calc(${exportRoleOffsetX}px + ${roleEdgeAdjustCqw}cqw))`;
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
                WebkitMaskImage: `url(${collectifnocturneLogo})`,
                maskImage: `url(${collectifnocturneLogo})`,
              }}
            />
            <span
              className="back-logo-mask back-logo-mask--groove"
              aria-label="Le Groove"
              style={{
                backgroundColor: safeSecondaryColor,
                WebkitMaskImage: `url(${legrooveLogo})`,
                maskImage: `url(${legrooveLogo})`,
              }}
            />
            <span
              className="back-logo-mask back-logo-mask--terreau"
              aria-label="Le Terreau"
              style={{
                backgroundColor: safeSecondaryColor,
                WebkitMaskImage: `url(${logoTerreau})`,
                maskImage: `url(${logoTerreau})`,
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

        <div className="back-role-container" ref={exportBackRoleContainerRef}>
          <span
            className="back-role-label"
            ref={exportBackRoleLabelRef}
            style={{
              color: safeAccentColor,
              fontSize: `${exportRoleTextFontSize}px`,
              transform: roleTransform,
            }}
          >
            {roleLabel}
          </span>
        </div>
      </>
    );
  }, [
    backFirstName,
    backLastName,
    backQrDataUrl,
    exportRoleOffsetX,
    exportRoleTextFontSize,
    photoFrameShape,
    photoPositionX,
    photoPositionY,
    photoTransform,
    profilePhotoUrl,
    roleEdgeAdjustCqw,
    roleLabel,
    safeAccentColor,
    safeSecondaryColor,
    showBackQr,
  ]);

  return (
    <div className="badge-illustrator">
      <div className="illustrator-topbar">
        <div className="illustrator-title-block">
          <h3>{t("illustrator.title")}</h3>
          <p className="hint">{t("illustrator.subtitle")}</p>
          <div className="person-meta-chips">
            <span className="meta-chip">{activePerson.displayName}</span>
            <span className="meta-chip">{categoryRole(activePerson)}</span>
            {activePerson.venue && <span className="meta-chip">{activePerson.venue}</span>}
          </div>
        </div>
        <div className="side-switch">
          <button
            className={selectedSide === "front" ? "active" : ""}
            onClick={() => setSelectedSide("front")}
          >
            {t("illustrator.frontSide")}
          </button>
          <button
            className={selectedSide === "back" ? "active" : ""}
            onClick={() => setSelectedSide("back")}
          >
            {t("illustrator.backSide")}
          </button>
        </div>
        <label className="background-color-control">
          <span>{t("illustrator.cardBackground")}</span>
          <div className="background-color-inputs">
            <input
              type="color"
              value={safeCardBackgroundColor}
              onChange={(event) => setCardBackgroundColor(event.target.value)}
              aria-label={t("illustrator.ariaCardBgColor")}
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
            label={t("illustrator.setBackgroundDefault")}
          />
        </label>
        <div className="illustrator-topbar-actions">
          <button type="button" className="btn-reset-factory" onClick={applyFactoryReset}>
            {t("illustrator.resetFactory")}
          </button>
        </div>
      </div>
      {defaultsHint && <p className="defaults-hint">{defaultsHint}</p>}

      {people.length > 1 && (
        <nav className="badge-illustrator-person-tabs" aria-label={t("illustrator.peopleTabsLabel")}>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`badge-illustrator-person-tab ${p.id === activePersonId ? "is-active" : ""}`}
              onClick={() => handlePersonTabClick(p.id)}
            >
              {p.displayName}
            </button>
          ))}
        </nav>
      )}

      <div className="badge-illustrator-body">
        <section className="badge-settings">
          {selectedSide === "front" ? (
            <>
              <div className="settings-section">
                <h3>{t("illustrator.frontSettings")}</h3>
                <p className="hint">{t("illustrator.frontHint")}</p>

                <div className="logo-positioning-controls">
                  <h4>{t("illustrator.logoPositioning")}</h4>

                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>{t("illustrator.zoom")}</span>
                      <ResponsiveRangeInput
                        value={logoZoom}
                        onPreviewChange={onPreviewLogoZoom}
                        onValueChange={setLogoZoom}
                        min={20}
                        max={240}
                        step={1}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.axisX")}</span>
                      <ResponsiveRangeInput
                        value={logoOffsetX}
                        onPreviewChange={onPreviewLogoOffsetX}
                        onValueChange={setLogoOffsetX}
                        min={-500}
                        max={500}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.axisY")}</span>
                      <ResponsiveRangeInput
                        value={logoOffsetY}
                        onPreviewChange={onPreviewLogoOffsetY}
                        onValueChange={setLogoOffsetY}
                        min={-500}
                        max={500}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.axisZ")}</span>
                      <ResponsiveRangeInput
                        value={logoOffsetZ}
                        onPreviewChange={onPreviewLogoOffsetZ}
                        onValueChange={setLogoOffsetZ}
                        min={-45}
                        max={45}
                        step={1}
                        renderOutput={formatRangeOutputDeg}
                      />
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
                    onChange={setShowQrCode}
                    label={t("illustrator.showQr")}
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
                    onChange={setShowNfcMark}
                    label={t("illustrator.showNfc")}
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
                  <h4>{t("illustrator.qrSectionTitle")}</h4>
                  <p className="hint">{t("illustrator.qrSectionHint")}</p>

                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>{t("illustrator.top")}</span>
                      <ResponsiveRangeInput
                        value={qrTopPct}
                        onPreviewChange={onPreviewQrTopPct}
                        onValueChange={setQrTopPct}
                        min={0}
                        max={40}
                        step={0.5}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.right")}</span>
                      <ResponsiveRangeInput
                        value={qrRightPct}
                        onPreviewChange={onPreviewQrRightPct}
                        onValueChange={setQrRightPct}
                        min={0}
                        max={40}
                        step={0.5}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.width")}</span>
                      <ResponsiveRangeInput
                        value={qrWidthPct}
                        onPreviewChange={onPreviewQrWidthPct}
                        onValueChange={setQrWidthPct}
                        min={5}
                        max={45}
                        step={0.5}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.axisX")}</span>
                      <ResponsiveRangeInput
                        value={qrOffsetX}
                        onPreviewChange={onPreviewQrOffsetX}
                        onValueChange={setQrOffsetX}
                        min={-500}
                        max={500}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.axisY")}</span>
                      <ResponsiveRangeInput
                        value={qrOffsetY}
                        onPreviewChange={onPreviewQrOffsetY}
                        onValueChange={setQrOffsetY}
                        min={-500}
                        max={500}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.axisZ")}</span>
                      <ResponsiveRangeInput
                        value={qrOffsetZ}
                        onPreviewChange={onPreviewQrOffsetZ}
                        onValueChange={setQrOffsetZ}
                        min={-45}
                        max={45}
                        step={1}
                        renderOutput={formatRangeOutputDeg}
                      />
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
                      <span>{t("illustrator.zoom")}</span>
                      <ResponsiveRangeInput
                        value={qrZoom}
                        onPreviewChange={onPreviewQrZoom}
                        onValueChange={setQrZoom}
                        min={20}
                        max={240}
                        step={1}
                        renderOutput={formatRangeOutputPct}
                      />
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
                  <h4>{t("illustrator.nfcSectionTitle")}</h4>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>{t("illustrator.bottom")}</span>
                      <ResponsiveRangeInput
                        value={nfcBottomPct}
                        onPreviewChange={onPreviewNfcBottomPct}
                        onValueChange={setNfcBottomPct}
                        min={0}
                        max={40}
                        step={0.5}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.right")}</span>
                      <ResponsiveRangeInput
                        value={nfcRightPct}
                        onPreviewChange={onPreviewNfcRightPct}
                        onValueChange={setNfcRightPct}
                        min={0}
                        max={40}
                        step={0.5}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.width")}</span>
                      <ResponsiveRangeInput
                        value={nfcWidthPct}
                        onPreviewChange={onPreviewNfcWidthPct}
                        onValueChange={setNfcWidthPct}
                        min={5}
                        max={40}
                        step={0.5}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.axisX")}</span>
                      <ResponsiveRangeInput
                        value={nfcOffsetX}
                        onPreviewChange={onPreviewNfcOffsetX}
                        onValueChange={setNfcOffsetX}
                        min={-500}
                        max={500}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.axisY")}</span>
                      <ResponsiveRangeInput
                        value={nfcOffsetY}
                        onPreviewChange={onPreviewNfcOffsetY}
                        onValueChange={setNfcOffsetY}
                        min={-500}
                        max={500}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.axisZ")}</span>
                      <ResponsiveRangeInput
                        value={nfcOffsetZ}
                        onPreviewChange={onPreviewNfcOffsetZ}
                        onValueChange={setNfcOffsetZ}
                        min={-45}
                        max={45}
                        step={1}
                        renderOutput={formatRangeOutputDeg}
                      />
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
                      <span>{t("illustrator.zoom")}</span>
                      <ResponsiveRangeInput
                        value={nfcZoom}
                        onPreviewChange={onPreviewNfcZoom}
                        onValueChange={setNfcZoom}
                        min={20}
                        max={240}
                        step={1}
                        renderOutput={formatRangeOutputPct}
                      />
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
                  <h4>{t("illustrator.vcardTitle")}</h4>

                  {(
                    [
                      ["firstName", "vcardFirstName"],
                      ["lastName", "vcardLastName"],
                      ["fullName", "vcardFullName"],
                      ["organization", "vcardOrg"],
                      ["role", "vcardRole"],
                      ["email", "vcardEmail"],
                      ["phone", "vcardPhone"],
                      ["note", "vcardNote"],
                    ] as const
                  ).map(([field, labelKey]) => (
                    <div className="vcard-field" key={field}>
                      <ToggleSwitch
                        checked={vCardSettings[field].enabled}
                        onChange={(checked) => updateField(field, { enabled: checked })}
                        label={t(`illustrator.${labelKey}`)}
                      />
                      <input
                        value={vCardSettings[field].value}
                        onChange={(e) => updateField(field, { value: e.target.value })}
                        disabled={!vCardSettings[field].enabled}
                      />
                    </div>
                  ))}
                  <SetAsDefaultButton
                    label={t("illustrator.setVcardDefaults")}
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
                <h3>{t("illustrator.backSettings")}</h3>
                <p className="hint">{t("illustrator.backHint")}</p>

                <label>
                  {t("illustrator.personType")}
                  <select
                    value={personType}
                    onChange={(e) => handlePersonTypeChange(e.target.value as BadgePersonType)}
                  >
                    {PERSON_TYPE_META.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {t(`illustrator.personType_${opt.value}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <SetAsDefaultButton
                  label={t("illustrator.setPersonTypeDefault")}
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
                    {t("illustrator.customRoleLabel")}
                    <input
                      value={customRoleLabel}
                      onChange={(e) => setCustomRoleLabel(e.target.value)}
                      placeholder={t("illustrator.customRolePlaceholder")}
                    />
                  </label>
                )}
                {personType === "autre" && (
                  <SetAsDefaultButton
                    label={t("illustrator.setCustomLabelDefault")}
                    onClick={() => {
                      persistIllustratorPartial({ customRoleLabel });
                      flashDefaultsSaved();
                    }}
                  />
                )}

                <div className="slider-with-default" style={{ marginTop: "0.4rem" }}>
                  <label className="range-row">
                    <span>{t("illustrator.roleTextSize")}</span>
                    <ResponsiveRangeInput
                      value={roleSizeAdjust}
                      onValueChange={setRoleSizeAdjust}
                      min={50}
                      max={150}
                      step={1}
                      renderOutput={formatRangeOutputPct}
                    />
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
                      {t("illustrator.roleEdgeDistance", {
                        type: t(`illustrator.personType_${personType}`),
                      })}
                    </span>
                    <ResponsiveRangeInput
                      value={roleEdgeAdjustCqw}
                      onValueChange={(v) =>
                        setRoleEdgeAdjustCqwByType((prev) => ({
                          ...prev,
                          [personType]: v,
                        }))
                      }
                      min={-10}
                      max={10}
                      step={0.25}
                      renderOutput={formatRoleEdgeOutput}
                    />
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
                  {t("illustrator.roleEdgeHint")}
                </p>

                <label className="background-color-control" style={{ marginTop: "0.6rem" }}>
                  <span>{t("illustrator.accentColour")}</span>
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
                  label={t("illustrator.setAccentDefault")}
                  onClick={() => {
                    persistIllustratorPartial({ accentColor: safeAccentColor });
                    flashDefaultsSaved();
                  }}
                />
              </div>

              {/* Name */}
              <div className="settings-section">
                <h4>{t("illustrator.nameSection")}</h4>
                <p className="hint">{t("illustrator.nameHint")}</p>
                <label>
                  {t("illustrator.firstNameField")}
                  <input value={backFirstName} onChange={(e) => setBackFirstName(e.target.value)} />
                </label>
                <label style={{ marginTop: "0.4rem" }}>
                  {t("illustrator.lastNameField")}
                  <input value={backLastName} onChange={(e) => setBackLastName(e.target.value)} />
                </label>
              </div>

              {/* Logos */}
              <div className="settings-section">
                <h4>{t("illustrator.secondarySection")}</h4>
                <p className="hint">{t("illustrator.secondaryHint")}</p>
                <label className="background-color-control" style={{ marginTop: "0.3rem" }}>
                  <span>{t("illustrator.secondaryColour")}</span>
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
                  label={t("illustrator.setSecondaryDefault")}
                  onClick={() => {
                    persistIllustratorPartial({ secondaryColor: safeSecondaryColor });
                    flashDefaultsSaved();
                  }}
                />
              </div>

              {/* Profile photo */}
              <div className="settings-section">
                <h4>{t("illustrator.profilePhoto")}</h4>
                <input
                  type="file"
                  ref={photoInputRef}
                  accept="image/*"
                  onChange={handlePhotoUpload}
                  style={{ display: "none" }}
                />
                <div className="photo-upload-row">
                  <button type="button" onClick={() => photoInputRef.current?.click()}>
                    {profilePhotoUrl ? t("illustrator.changePhoto") : t("illustrator.browsePhoto")}
                  </button>
                  {profilePhotoUrl && (
                    <button type="button" onClick={removePhoto}>
                      {t("illustrator.removePhoto")}
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
                    {t("illustrator.frameCircle")}
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="frameShape"
                      value="rounded"
                      checked={photoFrameShape === "rounded"}
                      onChange={() => setPhotoFrameShape("rounded")}
                    />
                    {t("illustrator.frameRounded")}
                  </label>
                </div>
                <SetAsDefaultButton
                  label={t("illustrator.setFrameDefault")}
                  onClick={() => {
                    persistIllustratorPartial({ photoFrameShape });
                    flashDefaultsSaved();
                  }}
                />

                <div className="logo-positioning-controls">
                  <h4>{t("illustrator.photoPositioning")}</h4>
                  <div className="slider-with-default">
                    <label className="range-row">
                      <span>{t("illustrator.zoom")}</span>
                      <ResponsiveRangeInput
                        value={photoZoom}
                        onPreviewChange={onPreviewPhotoZoom}
                        onValueChange={setPhotoZoom}
                        min={100}
                        max={300}
                        step={1}
                        renderOutput={formatRangeOutputPct}
                      />
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
                      <span>{t("illustrator.axisX")}</span>
                      <ResponsiveRangeInput
                        value={photoOffsetX}
                        onPreviewChange={onPreviewPhotoOffsetX}
                        onValueChange={setPhotoOffsetX}
                        min={-200}
                        max={200}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.axisY")}</span>
                      <ResponsiveRangeInput
                        value={photoOffsetY}
                        onPreviewChange={onPreviewPhotoOffsetY}
                        onValueChange={setPhotoOffsetY}
                        min={-200}
                        max={200}
                        step={1}
                        renderOutput={formatRangeOutputPx}
                      />
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
                      <span>{t("illustrator.rotationShort")}</span>
                      <ResponsiveRangeInput
                        value={photoRotation}
                        onPreviewChange={onPreviewPhotoRotation}
                        onValueChange={setPhotoRotation}
                        min={-180}
                        max={180}
                        step={1}
                        renderOutput={formatRangeOutputDegSym}
                      />
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
                <h4>{t("illustrator.backQrSection")}</h4>
                <div className="switch-with-default">
                  <ToggleSwitch
                    checked={showBackQr}
                    onChange={setShowBackQr}
                    label={t("illustrator.showBackQr")}
                  />
                  <SetAsDefaultButton
                    onClick={() => {
                      persistIllustratorPartial({ showBackQr });
                      flashDefaultsSaved();
                    }}
                  />
                </div>
                <p className="hint">{t("illustrator.backQrHint")}</p>
              </div>
            </>
          )}
        </section>

        <section className="badge-preview-panel">
          <div className="badge-preview-header">
            <h3>{t("illustrator.livePreview")}</h3>
            <p className="badge-preview-subtitle">{t("illustrator.previewSubtitle")}</p>
          </div>
          <div className="badge-preview-canvas-wrap">
            <div
              className="badge-card-preview badge-card-preview--isolate"
              ref={previewCardRef}
              style={{ backgroundColor: safeCardBackgroundColor }}
            >
              {selectedSide === "front" ? frontBadgeMarkup : previewBackBadgeMarkup}
            </div>
          </div>
        </section>
      </div>

      <div className="badge-export-surfaces" aria-hidden="true">
        <div ref={exportFrontRef} className="badge-card-preview badge-card-preview--export" style={{ backgroundColor: safeCardBackgroundColor }}>
          {frontBadgeMarkup}
        </div>
        <div ref={exportBackRef} className="badge-card-preview badge-card-preview--export" style={{ backgroundColor: safeCardBackgroundColor }}>
          {exportBackBadgeMarkup}
        </div>
      </div>

      <div className="floating-export-menu" ref={exportMenuRef}>
        {isExportMenuOpen && (
          <div className="floating-export-options">
            <button type="button" onClick={() => handleExport("png")} disabled={isExporting}>
              {t("illustrator.exportPng")}
            </button>
            <button type="button" onClick={() => handleExport("jpg")} disabled={isExporting}>
              {t("illustrator.exportJpg")}
            </button>
            <button type="button" onClick={() => handleExport("svg")} disabled={isExporting}>
              {t("illustrator.exportSvg")}
            </button>
            <button type="button" onClick={() => handleExport("pdf")} disabled={isExporting}>
              {t("illustrator.exportPdf")}
            </button>
            <button type="button" onClick={() => handleExport("canva")} disabled={isExporting}>
              {t("illustrator.exportCanva")}
            </button>
            <button type="button" onClick={() => handleExport("bs")} disabled={isExporting}>
              {t("illustrator.exportBs")}
            </button>
          </div>
        )}
        <button
          type="button"
          className="primary floating-export-btn"
          onClick={() => setIsExportMenuOpen((old) => !old)}
          disabled={isExporting}
        >
          {isExporting ? t("illustrator.exporting") : t("illustrator.exportBadge")}
        </button>
      </div>

      {exportNotice && <p className="export-notice">{exportNotice}</p>}
    </div>
  );
}
