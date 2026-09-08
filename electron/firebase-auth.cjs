/**
 * Google Web OAuth loopback + Firebase Auth (Identity Toolkit REST).
 * Mirrors NoctuList DesktopFirebaseAuthService / DesktopFirebaseGoogleRestSignIn.
 */
const crypto = require("crypto");
const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { app, shell } = require("electron");
const { hasJoinSecrets, isComplete, normalizePayload } = require("./firebase-join.cjs");

const CONFIG_FILE = "firebase-join-config.json";
const SESSION_FILE = "firebase-auth-session.json";

/** Prefer NoctuList ports (already on institution Web clients), then Collectif Badgé port. */
const OAUTH_PORTS = [8889, 8888, 8765, 9090, 8890];

function getPaths() {
  const userData = app.getPath("userData");
  return {
    configPath: path.join(userData, CONFIG_FILE),
    sessionPath: path.join(userData, SESSION_FILE),
    photoCacheDir: path.join(userData, "profile-photos")
  };
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function getConfig() {
  const { configPath } = getPaths();
  const raw = await loadJson(configPath, null);
  if (!raw || typeof raw !== "object") return null;
  const payload = normalizePayload(raw);
  return isComplete(payload) ? payload : null;
}

async function saveConfig(payload) {
  const normalized = normalizePayload(payload);
  if (!isComplete(normalized)) {
    throw new Error("Firebase config incomplete (need orgId, projectId, applicationId, apiKey).");
  }
  const { configPath } = getPaths();
  const existing = await loadJson(configPath, {});
  const merged = {
    ...existing,
    ...normalized,
    // Keep previous secrets if paste omitted them (v2 public QR).
    webClientId: normalized.webClientId || clean(existing.webClientId),
    webClientSecret: normalized.webClientSecret || clean(existing.webClientSecret),
    bootstrapCode: normalized.bootstrapCode || clean(existing.bootstrapCode),
    storageBucket: normalized.storageBucket || clean(existing.storageBucket)
  };
  await saveJson(configPath, merged);
  return merged;
}

function clean(value) {
  return String(value ?? "").trim();
}

async function clearConfig() {
  const { configPath, sessionPath } = getPaths();
  await fs.unlink(configPath).catch(() => {});
  await fs.unlink(sessionPath).catch(() => {});
}

async function getSession() {
  const { sessionPath } = getPaths();
  const session = await loadJson(sessionPath, null);
  if (!session?.idToken || !session?.uid) return null;
  return session;
}

async function saveSession(session) {
  const { sessionPath } = getPaths();
  await saveJson(sessionPath, session);
}

async function clearSession() {
  const { sessionPath } = getPaths();
  await fs.unlink(sessionPath).catch(() => {});
}

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg =
      body?.error?.message ||
      body?.error_description ||
      body?.error ||
      text ||
      `HTTP ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Start a one-shot localhost server on the first free OAuth port.
 * @returns {Promise<{ port: number, redirectUri: string, waitForCode: () => Promise<string>, stop: () => void }>}
 */
function startOAuthReceiver() {
  return new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = () => {
      if (index >= OAUTH_PORTS.length) {
        reject(
          new Error(
            `Could not bind OAuth callback on ports ${OAUTH_PORTS.join(", ")}. Close other NoctuList/Badge windows waiting for Google Sign-In.`
          )
        );
        return;
      }
      const port = OAUTH_PORTS[index++];
      /** @type {(v: any) => void} */
      let settleCode;
      /** @type {(e: Error) => void} */
      let rejectCode;
      const codePromise = new Promise((res, rej) => {
        settleCode = res;
        rejectCode = rej;
      });
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url || "/", `http://localhost:${port}`);
          if (url.pathname !== "/Callback") {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          const err = url.searchParams.get("error");
          if (err) {
            const desc = url.searchParams.get("error_description") || err;
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<html><body><h1>Sign-in failed</h1><p>${desc}</p></body></html>`);
            rejectCode(new Error(`Google Sign-In failed: ${desc}`));
            return;
          }
          const code = url.searchParams.get("code");
          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<html><body><h1>Missing code</h1></body></html>");
            rejectCode(new Error("OAuth callback missing authorization code."));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h1>Collectif Badgé</h1><p>Signed in. You can close this tab and return to the app.</p></body></html>"
          );
          settleCode(code);
        } catch (e) {
          rejectCode(e instanceof Error ? e : new Error(String(e)));
        }
      });
      server.on("error", () => {
        tryNext();
      });
      server.listen(port, "127.0.0.1", () => {
        const redirectUri = `http://localhost:${port}/Callback`;
        const timer = setTimeout(() => {
          rejectCode(new Error("Google Sign-In timed out. Complete sign-in in the browser, then try again."));
        }, 180_000);
        resolve({
          port,
          redirectUri,
          waitForCode: async () => {
            try {
              return await codePromise;
            } finally {
              clearTimeout(timer);
            }
          },
          stop: () => {
            clearTimeout(timer);
            try {
              server.close();
            } catch {
              /* ignore */
            }
          }
        });
      });
    };
    tryNext();
  });
}

async function exchangeGoogleCode({ code, redirectUri, webClientId, webClientSecret }) {
  const body = formEncode({
    code,
    client_id: webClientId,
    client_secret: webClientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  return httpJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
}

async function signInWithGoogleIdToken({ apiKey, googleIdToken, projectId }) {
  const referers = [
    null,
    projectId ? `https://${projectId}.firebaseapp.com/` : null,
    projectId ? `https://${projectId}.web.app/` : null,
    "http://localhost/",
    "http://localhost"
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  let lastError = null;
  for (const referer of referers) {
    const headers = { "Content-Type": "application/json; charset=UTF-8" };
    if (referer) {
      headers.Referer = referer;
      headers.Origin = referer.replace(/\/$/, "");
    }
    const requestUri = projectId ? `https://${projectId}.firebaseapp.com` : "http://localhost";
    try {
      const body = await httpJson(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
            requestUri,
            returnIdpCredential: true,
            returnSecureToken: true
          })
        }
      );
      if (body?.error) {
        lastError = new Error(body.error.message || "Identity Toolkit error");
        continue;
      }
      if (!body?.idToken || !body?.localId) {
        throw new Error("Firebase Auth returned no idToken/localId.");
      }
      return {
        idToken: body.idToken,
        refreshToken: body.refreshToken || "",
        uid: body.localId,
        email: body.email || "",
        expiresIn: Number.parseInt(String(body.expiresIn || "3600"), 10) || 3600
      };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError || new Error("Firebase Auth sign-in failed.");
}

async function refreshFirebaseIdToken(apiKey, refreshToken) {
  const body = formEncode({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  const result = await httpJson(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }
  );
  return {
    idToken: result.id_token,
    refreshToken: result.refresh_token || refreshToken,
    uid: result.user_id,
    expiresIn: Number.parseInt(String(result.expires_in || "3600"), 10) || 3600
  };
}

async function getValidSession() {
  const config = await getConfig();
  if (!config) return null;
  const session = await getSession();
  if (!session) return null;
  const expiresAt = Number(session.expiresAt || 0);
  if (expiresAt > Date.now() + 60_000 && session.idToken) {
    return { config, session };
  }
  if (!session.refreshToken) {
    await clearSession();
    return null;
  }
  try {
    const refreshed = await refreshFirebaseIdToken(config.apiKey, session.refreshToken);
    const next = {
      ...session,
      idToken: refreshed.idToken,
      refreshToken: refreshed.refreshToken,
      uid: refreshed.uid || session.uid,
      expiresAt: Date.now() + refreshed.expiresIn * 1000
    };
    await saveSession(next);
    return { config, session: next };
  } catch {
    await clearSession();
    return null;
  }
}

async function signInWithGoogle() {
  const config = await getConfig();
  if (!config) {
    throw new Error("Configure Firebase first (scan or paste a NoctuList join code).");
  }
  if (!clean(config.webClientId) || !clean(config.webClientSecret)) {
    throw new Error(
      "Desktop Firebase Sign-In needs the institution Web client ID + Client secret (included in a full noctulist-fb:1 join QR)."
    );
  }

  const receiver = await startOAuthReceiver();
  try {
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", config.webClientId);
    authUrl.searchParams.set("redirect_uri", receiver.redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("access_type", "offline");

    await shell.openExternal(authUrl.toString());
    const code = await receiver.waitForCode();
    const tokenResponse = await exchangeGoogleCode({
      code,
      redirectUri: receiver.redirectUri,
      webClientId: config.webClientId,
      webClientSecret: config.webClientSecret
    });
    const googleIdToken = tokenResponse.id_token;
    if (!googleIdToken) {
      throw new Error(
        "Google returned no OpenID id_token. Confirm the Web OAuth client has openid scope and localhost Callback URIs."
      );
    }
    const firebase = await signInWithGoogleIdToken({
      apiKey: config.apiKey,
      googleIdToken,
      projectId: config.projectId
    });
    const session = {
      uid: firebase.uid,
      email: firebase.email,
      idToken: firebase.idToken,
      refreshToken: firebase.refreshToken,
      expiresAt: Date.now() + firebase.expiresIn * 1000
    };
    await saveSession(session);
    return { config, session };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/redirect_uri/i.test(msg)) {
      throw new Error(
        `${msg} Add Authorized redirect URIs on the institution Web OAuth client: ` +
          OAUTH_PORTS.map((p) => `http://localhost:${p}/Callback`).join(", ")
      );
    }
    throw e instanceof Error ? e : new Error(msg);
  } finally {
    receiver.stop();
  }
}

async function getStatus() {
  const config = await getConfig();
  const valid = await getValidSession();
  return {
    configured: Boolean(config),
    signedIn: Boolean(valid?.session),
    email: valid?.session?.email || "",
    orgId: config?.orgId || "",
    projectId: config?.projectId || "",
    hasJoinSecrets: config ? hasJoinSecrets(config) : false,
    memberReady: Boolean(valid?.session?.memberReady)
  };
}

/** SHA-256 hex of uppercase trimmed code — same as NoctuList BootstrapCodeHash.hash */
function bootstrapHash(code) {
  const normalized = clean(code).toUpperCase();
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Double-hash convention used by NoctuList member join + metadata/config. */
function memberBootstrapField(plaintextCode) {
  return bootstrapHash(bootstrapHash(plaintextCode));
}

module.exports = {
  getPaths,
  getConfig,
  saveConfig,
  clearConfig,
  getSession,
  saveSession,
  clearSession,
  getValidSession,
  signInWithGoogle,
  getStatus,
  bootstrapHash,
  memberBootstrapField,
  OAUTH_PORTS
};
