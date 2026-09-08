/**
 * NoctuList Firebase join codec — mirrors FirebaseJoinCodec (noctulist-fb:1|2:…).
 */
const PREFIX = "noctulist-fb";
const VERSION = 1;
const PUBLIC_VERSION = 2;

function clean(value) {
  return String(value ?? "").trim();
}

function base64UrlToBuffer(b64url) {
  let b64 = clean(b64url).replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  if (pad > 0) b64 += "=".repeat(pad);
  return Buffer.from(b64, "base64");
}

function isComplete(payload) {
  return Boolean(
    clean(payload?.orgId) &&
      clean(payload?.projectId) &&
      clean(payload?.applicationId) &&
      clean(payload?.apiKey)
  );
}

function hasJoinSecrets(payload) {
  return (
    isComplete(payload) &&
    Boolean(clean(payload?.webClientId)) &&
    Boolean(clean(payload?.webClientSecret)) &&
    Boolean(clean(payload?.bootstrapCode))
  );
}

function normalizePayload(raw) {
  return {
    orgId: clean(raw.orgId),
    projectId: clean(raw.projectId),
    applicationId: clean(raw.applicationId || raw.appId),
    apiKey: clean(raw.apiKey),
    webClientId: clean(raw.webClientId || raw.clientId),
    webClientSecret: clean(raw.webClientSecret || raw.clientSecret),
    bootstrapCode: clean(raw.bootstrapCode),
    storageBucket: clean(raw.storageBucket)
  };
}

function decodeJoinCode(raw) {
  const trimmed = clean(raw);
  const parts = trimmed.split(":");
  if (parts.length < 3 || parts[0] !== PREFIX) {
    throw new Error("Not a NoctuList Firebase join code (expected noctulist-fb:…).");
  }
  const version = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(version)) {
    throw new Error("Invalid join code version.");
  }
  const b64 = parts.slice(2).join(":");
  let decoded;
  try {
    decoded = JSON.parse(base64UrlToBuffer(b64).toString("utf8"));
  } catch {
    throw new Error("Join code payload is not valid JSON.");
  }
  if (version === VERSION) {
    const payload = normalizePayload(decoded);
    if (!isComplete(payload)) {
      throw new Error("Join code missing required fields (orgId, projectId, applicationId, apiKey).");
    }
    return payload;
  }
  if (version === PUBLIC_VERSION) {
    const payload = normalizePayload(decoded);
    if (!isComplete(payload)) {
      throw new Error("Join code missing required fields (orgId, projectId, applicationId, apiKey).");
    }
    return payload;
  }
  throw new Error(`Unsupported join code version ${version}.`);
}

/**
 * Accept a full join code, or a Firebase web config paste / JSON object.
 */
function parseFirebaseConfigInput(raw) {
  const text = clean(raw);
  if (!text) {
    throw new Error("Empty Firebase configuration.");
  }
  if (text.startsWith(`${PREFIX}:`)) {
    return decodeJoinCode(text);
  }
  // Strict JSON
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object") {
      const payload = normalizePayload(obj);
      if (isComplete(payload)) return payload;
    }
  } catch {
    /* fall through to regex extract */
  }
  const extracted = {};
  const pattern =
    /(?:["']?)(apiKey|appId|applicationId|projectId|orgId|messagingSenderId|storageBucket|webClientId|clientId|webClientSecret|clientSecret|bootstrapCode)(?:["']?)\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(pattern)) {
    extracted[match[1]] = match[2];
  }
  const payload = normalizePayload(extracted);
  if (!isComplete(payload)) {
    throw new Error(
      "Could not parse Firebase config. Paste a noctulist-fb join code or a web config with apiKey, appId, and projectId."
    );
  }
  return payload;
}

module.exports = {
  PREFIX,
  decodeJoinCode,
  parseFirebaseConfigInput,
  isComplete,
  hasJoinSecrets,
  normalizePayload
};
