const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { loadPeopleFromSheets } = require("./sheets.cjs");
const canva = require("./canva.cjs");

const isDev = !app.isPackaged;
const SERVICE_ACCOUNT_FILE_NAME = "google-service-account.json";
const NETWORK_SHARE_PORT = 4173;
const NETWORK_SHARE_HOST = "0.0.0.0";
const UPDATE_METADATA_URL =
  "https://raw.githubusercontent.com/TouristeAG/collectif-badge/main/version.json";
const UPDATE_FALLBACK_URL = "https://github.com/TouristeAG/collectif-badge/releases/latest";

const networkShareState = {
  server: null,
  running: false,
  port: NETWORK_SHARE_PORT,
  localUrl: "",
  networkUrls: [],
  defaultSpreadsheetId: ""
};
let updateStatusCache = {
  checkedAt: null,
  currentVersion: app.getVersion(),
  latestVersion: null,
  updateAvailable: false,
  mandatory: false,
  minRequiredVersion: null,
  releaseUrl: UPDATE_FALLBACK_URL,
  notes: "",
  error: ""
};

function getServiceAccountStoragePath() {
  return path.join(app.getPath("userData"), SERVICE_ACCOUNT_FILE_NAME);
}

async function readStoredServiceAccount() {
  const filePath = getServiceAccountStoragePath();
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid service account JSON.");
  }
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new Error("Missing required service account fields.");
  }
  return parsed;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: "COLLECTIF BADGÉ",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function getRendererDistRoot() {
  return path.join(__dirname, "..", "dist");
}

function normalizeVersion(version) {
  return String(version ?? "")
    .trim()
    .replace(/^v/i, "");
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (!response || response.statusCode == null) {
          reject(new Error("Update request failed."));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Update metadata HTTP ${response.statusCode}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid update metadata JSON."));
          }
        });
      })
      .on("error", reject);
  });
}

async function checkForUpdatesFromRemote() {
  const currentVersion = app.getVersion();
  const metadata = await fetchJson(UPDATE_METADATA_URL);
  const latestVersion = normalizeVersion(metadata?.version || currentVersion);
  const minRequiredVersion = normalizeVersion(metadata?.minRequiredVersion || "");
  const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;
  const forcedByMinRequired = minRequiredVersion
    ? compareVersions(currentVersion, minRequiredVersion) < 0
    : false;
  const mandatory = forcedByMinRequired || (Boolean(metadata?.mandatory) && updateAvailable);
  const releaseUrl = typeof metadata?.releaseUrl === "string" && metadata.releaseUrl.trim()
    ? metadata.releaseUrl.trim()
    : UPDATE_FALLBACK_URL;
  const notes = typeof metadata?.notes === "string" ? metadata.notes : "";
  const result = {
    checkedAt: Date.now(),
    currentVersion,
    latestVersion,
    updateAvailable,
    mandatory,
    minRequiredVersion: minRequiredVersion || null,
    releaseUrl,
    notes,
    error: ""
  };
  updateStatusCache = result;
  return result;
}

function mimeTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".woff")) return "font/woff";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function isIpv4(entry) {
  return entry.family === "IPv4" || entry.family === 4;
}

/**
 * Prefer en* (Wi‑Fi / Ethernet on macOS) over VPN (utun), bridges, Docker, etc.
 * The first URL was often a virtual interface — colleagues then see resets or timeouts.
 */
function getLocalNetworkUrls(port) {
  const ifaces = os.networkInterfaces();
  const scored = [];
  for (const name of Object.keys(ifaces)) {
    const entries = ifaces[name] || [];
    for (const entry of entries) {
      if (!isIpv4(entry) || entry.internal) continue;
      const addr = entry.address;
      if (!addr || addr.startsWith("169.254.")) continue;
      let score = 80;
      if (/^en\d/.test(name)) score = 0;
      else if (/^bridge\d|^awdl\d|^llw\d|^utun\d/i.test(name)) score = 60;
      else if (/docker|vnic|vmnet|vEthernet|vboxnet|virbr/i.test(name)) score = 50;
      scored.push({ score, name, addr, url: `http://${addr}:${port}` });
    }
  }
  scored.sort(
    (a, b) => a.score - b.score || a.name.localeCompare(b.name) || a.addr.localeCompare(b.addr)
  );
  const seen = new Set();
  const urls = [];
  for (const row of scored) {
    if (seen.has(row.addr)) continue;
    seen.add(row.addr);
    urls.push(row.url);
  }
  return urls;
}

async function startNetworkShareServer(payload) {
  if (networkShareState.running) return networkShareState;
  const defaultSpreadsheetId = String(payload?.spreadsheetId ?? "").trim();
  if (!defaultSpreadsheetId) {
    throw new Error("Spreadsheet ID is required to start network sharing.");
  }
  const distRoot = getRendererDistRoot();
  try {
    await fs.access(path.join(distRoot, "index.html"));
  } catch {
    throw new Error("Web build not found. Run npm run build:web first.");
  }

  await readStoredServiceAccount();

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const rawUrl = req.url || "/";
      const urlPath = rawUrl.split("?")[0];

      if (urlPath === "/sheets/status" && method === "GET") {
        try {
          const parsed = await readStoredServiceAccount();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              configured: true,
              clientEmail: parsed.client_email,
              defaultSpreadsheetId: networkShareState.defaultSpreadsheetId
            })
          );
        } catch {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              configured: false,
              clientEmail: "",
              defaultSpreadsheetId: networkShareState.defaultSpreadsheetId
            })
          );
        }
        return;
      }

      if (urlPath === "/sheets/loadPeople" && method === "POST") {
        let body = "";
        await new Promise((resolve, reject) => {
          req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1024 * 1024) {
              reject(new Error("Payload too large."));
            }
          });
          req.on("end", resolve);
          req.on("error", reject);
        });
        const parsedBody = body ? JSON.parse(body) : {};
        const spreadsheetId = String(parsedBody?.spreadsheetId ?? "").trim() || networkShareState.defaultSpreadsheetId;
        const response = await loadPeopleFromSheets({
          spreadsheetId,
          sheetNames: parsedBody?.sheetNames,
          serviceAccountKeyPath: getServiceAccountStoragePath()
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(response));
        return;
      }

      // Static files + SPA fallback.
      let requestedPath = urlPath === "/" ? "index.html" : urlPath;
      requestedPath = decodeURIComponent(requestedPath).replace(/^[/\\]+/, "");
      const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
      let absolute = path.join(distRoot, normalized);
      if (!absolute.startsWith(distRoot)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      let fileData;
      try {
        fileData = await fs.readFile(absolute);
      } catch {
        absolute = path.join(distRoot, "index.html");
        fileData = await fs.readFile(absolute);
      }
      res.writeHead(200, { "Content-Type": mimeTypeFor(absolute) });
      res.end(fileData);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Server error";
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(NETWORK_SHARE_PORT, NETWORK_SHARE_HOST, () => resolve(undefined));
  });

  networkShareState.server = server;
  networkShareState.running = true;
  networkShareState.port = NETWORK_SHARE_PORT;
  networkShareState.localUrl = `http://localhost:${NETWORK_SHARE_PORT}`;
  networkShareState.networkUrls = getLocalNetworkUrls(NETWORK_SHARE_PORT);
  networkShareState.defaultSpreadsheetId = defaultSpreadsheetId;
  return networkShareState;
}

async function stopNetworkShareServer() {
  if (!networkShareState.running || !networkShareState.server) return networkShareState;
  await new Promise((resolve, reject) => {
    networkShareState.server.close((err) => (err ? reject(err) : resolve(undefined)));
  });
  networkShareState.server = null;
  networkShareState.running = false;
  networkShareState.localUrl = "";
  networkShareState.networkUrls = [];
  networkShareState.defaultSpreadsheetId = "";
  return networkShareState;
}

ipcMain.handle("dialog:importServiceAccountKey", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose Google Service Account JSON",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  const raw = await fs.readFile(selectedPath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid service account JSON.");
  }
  if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new Error("Missing required service account fields.");
  }
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(getServiceAccountStoragePath(), JSON.stringify(parsed, null, 2), "utf-8");
  return { configured: true, clientEmail: parsed.client_email };
});

ipcMain.handle("sheets:getServiceAccountStatus", async () => {
  try {
    const parsed = await readStoredServiceAccount();
    return { configured: true, clientEmail: parsed.client_email };
  } catch {
    return { configured: false, clientEmail: "" };
  }
});

ipcMain.handle("sheets:loadPeople", async (_, payload) => {
  const serviceAccountKeyPath = getServiceAccountStoragePath();
  try {
    await readStoredServiceAccount();
  } catch {
    throw new Error("Service account JSON is not imported yet.");
  }
  return loadPeopleFromSheets({
    ...(payload ?? {}),
    serviceAccountKeyPath
  });
});

ipcMain.handle("networkShare:getStatus", async () => ({
  running: networkShareState.running,
  localUrl: networkShareState.localUrl,
  networkUrls: networkShareState.networkUrls,
  defaultSpreadsheetId: networkShareState.defaultSpreadsheetId
}));

ipcMain.handle("networkShare:start", async (_, payload) => {
  const state = await startNetworkShareServer(payload);
  return {
    running: state.running,
    localUrl: state.localUrl,
    networkUrls: state.networkUrls,
    defaultSpreadsheetId: state.defaultSpreadsheetId
  };
});

ipcMain.handle("networkShare:stop", async () => {
  const state = await stopNetworkShareServer();
  return {
    running: state.running,
    localUrl: state.localUrl,
    networkUrls: state.networkUrls,
    defaultSpreadsheetId: state.defaultSpreadsheetId
  };
});

ipcMain.handle("updater:getStatus", async () => updateStatusCache);

ipcMain.handle("updater:checkNow", async () => {
  try {
    return await checkForUpdatesFromRemote();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update check failed.";
    updateStatusCache = {
      ...updateStatusCache,
      checkedAt: Date.now(),
      error: message
    };
    return updateStatusCache;
  }
});

ipcMain.handle("updater:openUpdatePage", async () => {
  const url = updateStatusCache.releaseUrl || UPDATE_FALLBACK_URL;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("app:quit", () => {
  app.quit();
});

ipcMain.handle("dialog:saveBinaryFile", async (_, payload) => {
  const { defaultFileName, filters, dataBase64, dataBytes, openAfterSave } = payload ?? {};
  const result = await dialog.showSaveDialog({
    title: "Save export",
    defaultPath: defaultFileName,
    filters: Array.isArray(filters) ? filters : []
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  /** Prefer raw bytes over base64 — large exports (multi .bs) as base64 strings can crash V8 during IPC clone. */
  let buffer;
  if (dataBytes != null) {
    if (Buffer.isBuffer(dataBytes)) {
      buffer = dataBytes;
    } else if (dataBytes instanceof Uint8Array || ArrayBuffer.isView(dataBytes)) {
      const view = dataBytes;
      buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    } else {
      throw new Error("Invalid dataBytes for saveBinaryFile.");
    }
  } else if (typeof dataBase64 === "string" && dataBase64.length > 0) {
    buffer = Buffer.from(dataBase64, "base64");
  } else {
    throw new Error("Missing file data for saveBinaryFile.");
  }

  await fs.writeFile(result.filePath, buffer);

  if (openAfterSave) {
    await shell.openPath(result.filePath);
  }

  return result.filePath;
});

ipcMain.handle("canva:getStatus", () => canva.getStatus());

ipcMain.handle("canva:saveCredentials", async (_, payload) => {
  await canva.saveCredentials(payload ?? {});
});

ipcMain.handle("canva:login", async () => {
  await canva.startLoginFlow(shell);
});

ipcMain.handle("canva:logout", async () => {
  await canva.logout();
});

ipcMain.handle("canva:sendBadgeAutofill", async (_, payload) => {
  const editUrl = await canva.sendBadgeAutofill(payload ?? {});
  await shell.openExternal(editUrl);
  return { editUrl };
});

/** Fallback when no brand template: import 2-page PDF (flattened badge) into Canva. */
ipcMain.handle("canva:sendPdf", async (_, payload) => {
  const { pdfBase64, title } = payload ?? {};
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    throw new Error("Missing PDF data.");
  }
  const buffer = Buffer.from(pdfBase64, "base64");
  const editUrl = await canva.importPdfAndGetEditUrl(buffer, title || "Badge");
  await shell.openExternal(editUrl);
  return { editUrl };
});

app.whenReady().then(() => {
  createWindow();
  void checkForUpdatesFromRemote().catch(() => {
    /* ignore startup update failures */
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (networkShareState.server) {
    try {
      networkShareState.server.close();
    } catch {
      /* ignore */
    }
  }
});
