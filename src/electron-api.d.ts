import type { PeopleResponse, SheetsLoadPayload } from "./types";

export interface CanvaStatus {
  hasCredentials: boolean;
  connected: boolean;
  hasBrandTemplate: boolean;
  brandTemplateId: string | null;
}

interface ElectronAPI {
  pickServiceAccountKey: () => Promise<string | null>;
  loadPeopleFromSheets: (payload: SheetsLoadPayload) => Promise<PeopleResponse>;
  saveBinaryFile: (payload: {
    defaultFileName: string;
    filters: Array<{ name: string; extensions: string[] }>;
    /** Prefer for large exports; avoids base64 megastring IPC issues. */
    dataBytes?: Uint8Array;
    dataBase64?: string;
    openAfterSave?: boolean;
  }) => Promise<string | null>;
  canvaGetStatus?: () => Promise<CanvaStatus>;
  canvaSaveCredentials?: (payload: {
    clientId?: string;
    clientSecret?: string;
    brandTemplateId?: string;
  }) => Promise<void>;
  canvaLogin?: () => Promise<void>;
  canvaLogout?: () => Promise<void>;
  canvaSendBadgeAutofill?: (payload: {
    brandTemplateId?: string;
    title: string;
    texts: Record<string, string>;
    imagesBase64: Record<string, string>;
  }) => Promise<{ editUrl: string }>;
  /** When no brand template ID: import flattened 2-page PDF into Canva. */
  canvaSendPdf?: (payload: { pdfBase64: string; title: string }) => Promise<{ editUrl: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
