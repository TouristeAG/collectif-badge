const http = require("http");
const { loadPeopleFromSheets } = require("../electron/sheets.cjs");

const PORT = Number.parseInt(process.env.WEB_API_PORT || "8787", 10);
const HOST = process.env.WEB_API_HOST || "127.0.0.1";
const ALLOW_ORIGIN = process.env.WEB_API_ALLOW_ORIGIN || "*";
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const SPREADSHEET_ID_ALLOWLIST = (process.env.SHEETS_SPREADSHEET_ALLOWLIST || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Payload too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON payload."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  const raw = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(raw);
}

function parseServiceAccount() {
  if (!SERVICE_ACCOUNT_JSON) return null;
  try {
    const parsed = JSON.parse(SERVICE_ACCOUNT_JSON);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

const serviceAccountCredentials = parseServiceAccount();

function isSpreadsheetAllowed(spreadsheetId) {
  if (SPREADSHEET_ID_ALLOWLIST.length === 0) return true;
  return SPREADSHEET_ID_ALLOWLIST.includes(spreadsheetId);
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = req.url || "/";

  if (method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (method === "GET" && url === "/sheets/status") {
    if (!serviceAccountCredentials) {
      sendJson(res, 200, { configured: false, clientEmail: "" });
      return;
    }
    sendJson(res, 200, {
      configured: true,
      clientEmail: serviceAccountCredentials.client_email || ""
    });
    return;
  }

  if (method === "POST" && url === "/sheets/loadPeople") {
    if (!serviceAccountCredentials) {
      sendJson(res, 400, { error: "Server is missing GOOGLE_SERVICE_ACCOUNT_JSON." });
      return;
    }
    try {
      const body = await readBodyJson(req);
      const spreadsheetId = String(body?.spreadsheetId ?? "").trim();
      if (!spreadsheetId) {
        sendJson(res, 400, { error: "Spreadsheet ID is required." });
        return;
      }
      if (!isSpreadsheetAllowed(spreadsheetId)) {
        sendJson(res, 403, { error: "Spreadsheet ID is not allowed by server policy." });
        return;
      }
      const response = await loadPeopleFromSheets({
        spreadsheetId,
        sheetNames: body?.sheetNames ?? {},
        serviceAccountCredentials
      });
      sendJson(res, 200, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load people.";
      sendJson(res, 500, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Web Sheets API listening on http://${HOST}:${PORT}`);
});
