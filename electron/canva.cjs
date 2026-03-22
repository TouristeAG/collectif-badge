/**
 * Canva Connect API — OAuth (PKCE) + Brand template autofill (native text + image fields).
 * Token exchange and API calls run in the main process (client secret never exposed to renderer).
 */
const crypto = require("crypto");
const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { app } = require("electron");

const CANVA_OAUTH_PORT = 32887;
const REDIRECT_URI = `http://127.0.0.1:${CANVA_OAUTH_PORT}/canva/oauth/callback`;

/** Scopes for OAuth — users must re-authorize after scope changes. @see https://www.canva.dev/docs/connect/autofill-guide/ */
const OAUTH_SCOPES = [
  "design:content:write",
  "design:meta:read",
  "brandtemplate:meta:read",
  "brandtemplate:content:read",
  "asset:read",
  "asset:write"
].join(" ");

function getPaths() {
  const userData = app.getPath("userData");
  return {
    tokensPath: path.join(userData, "canva-tokens.json"),
    credentialsPath: path.join(userData, "canva-credentials.json")
  };
}

function base64Url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkce() {
  const codeVerifier = base64Url(crypto.randomBytes(64));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(crypto.randomBytes(32));
  return { codeVerifier, codeChallenge, state };
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function getBrandTemplateId() {
  const env = process.env.CANVA_BRAND_TEMPLATE_ID?.trim();
  if (env) return env;
  const { credentialsPath } = getPaths();
  const cfg = await loadJson(credentialsPath, {});
  return cfg.brandTemplateId?.trim() || null;
}

async function getClientCredentials() {
  const envId = process.env.CANVA_CLIENT_ID?.trim();
  const envSecret = process.env.CANVA_CLIENT_SECRET?.trim();
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }
  const { credentialsPath } = getPaths();
  const cfg = await loadJson(credentialsPath, {});
  if (cfg.clientId && cfg.clientSecret) {
    return { clientId: String(cfg.clientId).trim(), clientSecret: String(cfg.clientSecret).trim() };
  }
  return null;
}

async function saveCredentials(payload) {
  const { clientId, clientSecret, brandTemplateId } = payload ?? {};
  const { credentialsPath } = getPaths();
  const existing = await loadJson(credentialsPath, {});
  const nextId = (clientId && String(clientId).trim()) || existing.clientId;
  const nextSecret = (clientSecret && String(clientSecret).trim()) || existing.clientSecret;

  const envId = process.env.CANVA_CLIENT_ID?.trim();
  const envSecret = process.env.CANVA_CLIENT_SECRET?.trim();
  const effId = nextId || envId;
  const effSecret = nextSecret || envSecret;
  if (!effId || !effSecret) {
    throw new Error("Client ID and Client Secret are required (or set CANVA_* environment variables).");
  }

  /** @type {Record<string, string>} */
  const merged = {};
  if (nextId) merged.clientId = nextId;
  if (nextSecret) merged.clientSecret = nextSecret;
  if (brandTemplateId !== undefined) {
    const t = String(brandTemplateId).trim();
    if (t) merged.brandTemplateId = t;
    // empty string clears template (omit key in merged)
  } else if (existing.brandTemplateId) {
    merged.brandTemplateId = existing.brandTemplateId;
  }

  await fs.writeFile(credentialsPath, JSON.stringify(merged, null, 2), "utf8");
}

async function loadTokens() {
  const { tokensPath } = getPaths();
  return loadJson(tokensPath, null);
}

async function saveTokens(data) {
  const { tokensPath } = getPaths();
  await fs.writeFile(tokensPath, JSON.stringify(data, null, 2), "utf8");
}

async function clearTokens() {
  try {
    await fs.unlink(getPaths().tokensPath);
  } catch {
    /* noop */
  }
}

function buildAuthUrl(clientId, codeChallenge, state) {
  const params = new URLSearchParams({
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: OAUTH_SCOPES,
    response_type: "code",
    client_id: clientId,
    state,
    redirect_uri: REDIRECT_URI
  });
  return `https://www.canva.com/api/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(clientId, clientSecret, codeVerifier, code) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
    code,
    redirect_uri: REDIRECT_URI
  });
  const res = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Canva token exchange failed (${res.status}): ${err}`);
  }
  return res.json();
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  return fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  }).then(async (res) => {
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Canva token refresh failed (${res.status}): ${err}`);
    }
    return res.json();
  });
}

async function getValidAccessToken() {
  const creds = await getClientCredentials();
  if (!creds) {
    throw new Error("Canva API credentials missing. Add Client ID & Secret in Settings (or CANVA_* env vars).");
  }
  let tokens = await loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("Not signed in to Canva. Use Settings → Connect to Canva.");
  }

  const now = Date.now() / 1000;
  const skew = 120;
  if (tokens.access_token && tokens.expires_at && tokens.expires_at > now + skew) {
    return tokens.access_token;
  }

  const refreshed = await refreshAccessToken(creds.clientId, creds.clientSecret, tokens.refresh_token);
  const next = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    expires_at: now + (refreshed.expires_in || 14400),
    scope: refreshed.scope
  };
  await saveTokens(next);
  return next.access_token;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {import("electron").Shell} shell
 */
function startLoginFlow(shell) {
  return getClientCredentials().then((creds) => {
    if (!creds) {
      throw new Error("Configure Client ID and Client Secret in Settings first.");
    }
    const { codeVerifier, codeChallenge, state } = generatePkce();
    const authUrl = buildAuthUrl(creds.clientId, codeChallenge, state);

    return new Promise((resolve, reject) => {
      const timeoutMs = 5 * 60 * 1000;
      /** @type {import("http").Server | undefined} */
      let server;
      const timer = setTimeout(() => {
        try {
          server?.close();
        } catch {
          /* noop */
        }
        reject(new Error("Canva login timed out. Try again."));
      }, timeoutMs);

      server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (url.pathname === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.pathname !== "/canva/oauth/callback") {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const err = url.searchParams.get("error");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (err) {
          res.end(
            `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1.5rem"><p>Authorization failed: ${err}</p><p>You can close this tab.</p></body></html>`
          );
          clearTimeout(timer);
          server.close();
          reject(new Error(url.searchParams.get("error_description") || err));
          return;
        }
        if (!code || returnedState !== state) {
          res.end(
            `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1.5rem"><p>Invalid OAuth response.</p></body></html>`
          );
          clearTimeout(timer);
          server.close();
          reject(new Error("OAuth validation failed (state or code)."));
          return;
        }
        res.end(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1.5rem"><p><strong>Connected.</strong> You can close this tab and return to COLLECTIF BADGÉ.</p></body></html>`
        );
        clearTimeout(timer);
        server.close(() => {
          exchangeCodeForTokens(creds.clientId, creds.clientSecret, codeVerifier, code)
            .then((tokenResponse) => {
              const now = Date.now() / 1000;
              return saveTokens({
                access_token: tokenResponse.access_token,
                refresh_token: tokenResponse.refresh_token,
                expires_at: now + (tokenResponse.expires_in || 14400),
                scope: tokenResponse.scope
              });
            })
            .then(resolve)
            .catch(reject);
        });
      });

      server.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });

      server.listen(CANVA_OAUTH_PORT, "127.0.0.1", () => {
        shell.openExternal(authUrl);
      });
    });
  });
}

/**
 * @param {string} accessToken
 * @param {Buffer} pngBuffer
 * @param {string} fileLabel
 */
async function uploadPngAsset(accessToken, pngBuffer, fileLabel) {
  const safeName = String(fileLabel || "upload.png")
    .replace(/[^\w.\-]/g, "_")
    .slice(0, 50);
  const nameBase64 = Buffer.from(safeName || "upload.png", "utf8").toString("base64");
  const metadata = JSON.stringify({ name_base64: nameBase64 });

  const start = await fetch("https://api.canva.com/rest/v1/asset-uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Asset-Upload-Metadata": metadata
    },
    body: pngBuffer
  });

  if (!start.ok) {
    const err = await start.text();
    throw new Error(`Canva asset upload failed to start (${start.status}): ${err}`);
  }

  const body = await start.json();
  const job = body.job;
  if (job?.status === "success" && job.asset?.id) {
    return job.asset.id;
  }
  const jobId = job?.id;
  if (!jobId) {
    throw new Error("Canva asset upload: missing job id.");
  }

  for (let i = 0; i < 120; i++) {
    if (i > 0) await sleep(1000);
    const poll = await fetch(`https://api.canva.com/rest/v1/asset-uploads/${jobId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!poll.ok) {
      const err = await poll.text();
      throw new Error(`Canva asset upload poll failed (${poll.status}): ${err}`);
    }
    const polled = (await poll.json()).job;
    if (polled.status === "success" && polled.asset?.id) {
      return polled.asset.id;
    }
    if (polled.status === "failed") {
      throw new Error(polled.error?.message || polled.error?.code || "Canva asset upload failed.");
    }
  }

  throw new Error("Canva asset upload timed out.");
}

function extractAutofillEditUrl(job) {
  const design = job?.result?.design;
  const url = design?.url || design?.urls?.edit_url;
  if (!url) {
    throw new Error("Autofill succeeded but no design URL was returned.");
  }
  return url;
}

/**
 * @param {string} accessToken
 * @param {string} jobId
 */
async function pollAutofillJob(accessToken, jobId) {
  for (let i = 0; i < 120; i++) {
    if (i > 0) await sleep(1000);
    const poll = await fetch(`https://api.canva.com/rest/v1/autofills/${jobId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!poll.ok) {
      const err = await poll.text();
      throw new Error(`Canva autofill poll failed (${poll.status}): ${err}`);
    }
    const job = (await poll.json()).job;
    if (job.status === "success") {
      return extractAutofillEditUrl(job);
    }
    if (job.status === "failed") {
      throw new Error(job.error?.message || job.error?.code || "Canva autofill failed.");
    }
  }
  throw new Error("Canva autofill timed out.");
}

/**
 * Upload PNGs and run brand-template autofill so the design has native text + image elements.
 * @param {{ brandTemplateId?: string | null, title: string, texts: Record<string, string>, imagesBase64: Record<string, string> }} payload
 */
async function sendBadgeAutofill(payload) {
  const { title, texts, imagesBase64 } = payload ?? {};
  const brandTemplateId =
    (payload?.brandTemplateId && String(payload.brandTemplateId).trim()) || (await getBrandTemplateId());

  if (!brandTemplateId) {
    throw new Error(
      "Brand template ID required. Paste it in Settings (gear) or set CANVA_BRAND_TEMPLATE_ID. See docs/CANVA_BRAND_TEMPLATE.md"
    );
  }

  const accessToken = await getValidAccessToken();
  const data = {};

  for (const [k, v] of Object.entries(texts || {})) {
    if (v != null && String(v).trim() !== "") {
      data[k] = { type: "text", text: String(v) };
    }
  }

  for (const [k, b64] of Object.entries(imagesBase64 || {})) {
    if (b64 && typeof b64 === "string") {
      const buf = Buffer.from(b64, "base64");
      const assetId = await uploadPngAsset(accessToken, buf, `${k}.png`);
      data[k] = { type: "image", asset_id: assetId };
    }
  }

  if (Object.keys(data).length === 0) {
    throw new Error("Nothing to send to Canva — add text or enable image elements.");
  }

  const body = {
    brand_template_id: brandTemplateId,
    title: String(title || "Badge").slice(0, 200),
    data
  };

  const start = await fetch("https://api.canva.com/rest/v1/autofills", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!start.ok) {
    const err = await start.text();
    throw new Error(`Canva autofill failed to start (${start.status}): ${err}`);
  }

  const resBody = await start.json();
  const job = resBody.job;
  if (job?.status === "success" && job.result) {
    return extractAutofillEditUrl(job);
  }
  const jobId = job?.id;
  if (!jobId) {
    throw new Error("Canva autofill: missing job id.");
  }
  return pollAutofillJob(accessToken, jobId);
}

/** @deprecated Flat PDF import — prefer sendBadgeAutofill for editable layers. */
async function importPdfAndGetEditUrl(pdfBuffer, title) {
  const accessToken = await getValidAccessToken();
  const safeTitle = String(title || "Badge").slice(0, 50);
  const titleBase64 = Buffer.from(safeTitle, "utf8").toString("base64");
  const importMetadata = JSON.stringify({
    title_base64: titleBase64,
    mime_type: "application/pdf"
  });

  const start = await fetch("https://api.canva.com/rest/v1/imports", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Import-Metadata": importMetadata
    },
    body: pdfBuffer
  });

  if (!start.ok) {
    const err = await start.text();
    throw new Error(`Canva import failed to start (${start.status}): ${err}`);
  }

  const body = await start.json();
  const jobId = body.job?.id;
  if (!jobId) {
    throw new Error("Canva import: missing job id.");
  }

  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const poll = await fetch(`https://api.canva.com/rest/v1/imports/${jobId}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!poll.ok) {
      const err = await poll.text();
      throw new Error(`Canva import poll failed (${poll.status}): ${err}`);
    }
    const job = (await poll.json()).job;
    if (job.status === "success") {
      const editUrl = job.result?.designs?.[0]?.urls?.edit_url;
      if (!editUrl) {
        throw new Error("Canva import succeeded but no edit URL was returned.");
      }
      return editUrl;
    }
    if (job.status === "failed") {
      throw new Error(job.error?.message || job.error?.code || "Canva import failed.");
    }
  }

  throw new Error("Canva import timed out.");
}

async function getStatus() {
  const creds = await getClientCredentials();
  const tokens = await loadTokens();
  const brandTemplateId = await getBrandTemplateId();
  return {
    hasCredentials: Boolean(creds),
    connected: Boolean(tokens?.refresh_token),
    hasBrandTemplate: Boolean(brandTemplateId),
    brandTemplateId
  };
}

async function logout() {
  await clearTokens();
}

module.exports = {
  REDIRECT_URI,
  getStatus,
  saveCredentials,
  getClientCredentials,
  getBrandTemplateId,
  startLoginFlow,
  logout,
  sendBadgeAutofill,
  importPdfAndGetEditUrl
};
