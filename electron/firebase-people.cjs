/**
 * Firestore roster + Storage profile photos + org membership for Collectif Badgé.
 */
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const {
  getConfig,
  getValidSession,
  saveSession,
  memberBootstrapField,
  getPaths
} = require("./firebase-auth.cjs");

const PHOTO_CLEARED = "-";

function clean(value) {
  return String(value ?? "").trim();
}

function isStoredPhotoRef(value) {
  const t = clean(value);
  return Boolean(t) && t !== PHOTO_CLEARED;
}

function firestoreValue(field) {
  if (field == null || typeof field !== "object") return undefined;
  if ("stringValue" in field) return field.stringValue;
  if ("integerValue" in field) return Number.parseInt(String(field.integerValue), 10);
  if ("doubleValue" in field) return Number(field.doubleValue);
  if ("booleanValue" in field) return Boolean(field.booleanValue);
  if ("nullValue" in field) return null;
  if ("timestampValue" in field) return field.timestampValue;
  if ("arrayValue" in field) {
    const values = field.arrayValue?.values || [];
    return values.map((v) => firestoreValue(v));
  }
  if ("mapValue" in field) {
    const fields = field.mapValue?.fields || {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = firestoreValue(v);
    }
    return out;
  }
  return undefined;
}

function fieldsToObject(fields) {
  const out = {};
  if (!fields || typeof fields !== "object") return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = firestoreValue(v);
  }
  return out;
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (typeof value === "string") fields[key] = { stringValue: value };
    else if (typeof value === "number" && Number.isInteger(value)) {
      fields[key] = { integerValue: String(value) };
    } else if (typeof value === "number") fields[key] = { doubleValue: value };
    else if (typeof value === "boolean") fields[key] = { booleanValue: value };
  }
  return fields;
}

async function firestoreFetch(projectId, idToken, relativePath, options = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${relativePath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body };
}

async function listCollection(projectId, idToken, collectionPath) {
  const docs = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams();
    params.set("pageSize", "300");
    if (pageToken) params.set("pageToken", pageToken);
    const { ok, status, body } = await firestoreFetch(
      projectId,
      idToken,
      `${collectionPath}?${params.toString()}`,
      { method: "GET" }
    );
    if (!ok) {
      const msg = body?.error?.message || `Firestore list failed (${status})`;
      throw new Error(msg);
    }
    for (const doc of body?.documents || []) {
      docs.push(doc);
    }
    pageToken = body?.nextPageToken || "";
  } while (pageToken);
  return docs;
}

function makeRecord(source, rowNumber, category, displayName, details = {}) {
  return {
    id: `${source}:${rowNumber}`,
    source,
    rowNumber,
    category,
    displayName: clean(displayName),
    ...details
  };
}

function mapGuestDoc(doc, index, orgId) {
  const data = fieldsToObject(doc.fields);
  const docId = String(doc.name || "").split("/").pop() || "";
  const nanoId = clean(data.nanoId) || clean(docId);
  const name = clean(data.name);
  if (!name && !nanoId) return null;
  if (data.isVolunteerBenefit === true) return null;

  const isTemp = data.isTemporaryGuest === true;
  const photoUrl = isStoredPhotoRef(data.profilePhotoUrl) ? clean(data.profilePhotoUrl) : "";
  const photoPath = isStoredPhotoRef(data.profilePhotoPath)
    ? clean(data.profilePhotoPath)
    : photoUrl || nanoId
      ? `orgs/${orgId}/profilePhotos/guests/${nanoId}.jpg`
      : "";

  // Skip encrypted-looking / empty contact fields (email_enc etc. are separate keys).
  const email = typeof data.email === "string" ? clean(data.email) : "";
  const phone = typeof data.phone === "string" ? clean(data.phone) : "";
  const nfc =
    typeof data.nfcCardUid === "string" && !clean(data.nfcCardUid).includes("_enc")
      ? clean(data.nfcCardUid)
      : "";

  return makeRecord(
    isTemp ? "firebase_temp_guests" : "firebase_guests",
    index + 1,
    isTemp ? "temporary_guest" : "permanent_guest",
    name || nanoId,
    {
      eventManagerId: nanoId,
      abbreviation: clean(data.lastNameAbbreviation),
      email: email || undefined,
      phone: phone || undefined,
      invitations: Number(data.invitations) || 0,
      venue: clean(data.temporaryVenueName) || clean(data.venueName) || undefined,
      notes: typeof data.notes === "string" ? clean(data.notes) || undefined : undefined,
      eventDate: clean(data.temporaryEventDate) || undefined,
      artistName: clean(data.temporaryArtistName) || undefined,
      artistContactPhone: clean(data.temporaryContactPhone) || undefined,
      nfcCardUid: nfc || undefined,
      profilePhotoUrl: photoUrl || undefined,
      profilePhotoPath: isStoredPhotoRef(data.profilePhotoPath) || photoUrl ? photoPath : undefined
    }
  );
}

function mapVolunteerDoc(doc, index, orgId) {
  const data = fieldsToObject(doc.fields);
  const docId = String(doc.name || "").split("/").pop() || "";
  const id = clean(data.id) || clean(docId);
  const name = clean(data.name);
  if (!name && !id) return null;

  const photoUrl = isStoredPhotoRef(data.profilePhotoUrl) ? clean(data.profilePhotoUrl) : "";
  const photoPath = isStoredPhotoRef(data.profilePhotoPath)
    ? clean(data.profilePhotoPath)
    : photoUrl || id
      ? `orgs/${orgId}/profilePhotos/volunteers/${id}.jpg`
      : "";

  const email = typeof data.email === "string" ? clean(data.email) : "";
  const phone = typeof data.phone === "string" ? clean(data.phone) : "";
  const nfc =
    typeof data.nfcCardUid === "string" && !clean(data.nfcCardUid).includes("_enc")
      ? clean(data.nfcCardUid)
      : "";

  return makeRecord("firebase_volunteers", index + 1, "volunteer", name || id, {
    eventManagerId: id,
    abbreviation: clean(data.lastNameAbbreviation),
    email: email || undefined,
    phone: phone || undefined,
    rank: clean(data.currentRank) || undefined,
    active: data.isActive !== false,
    nfcCardUid: nfc || undefined,
    profilePhotoUrl: photoUrl || undefined,
    profilePhotoPath: isStoredPhotoRef(data.profilePhotoPath) || photoUrl ? photoPath : undefined
  });
}

async function ensureMembership() {
  const valid = await getValidSession();
  if (!valid) {
    throw new Error("Sign in with Google first.");
  }
  const { config, session } = valid;
  const orgId = config.orgId;
  const uid = session.uid;
  const memberPath = `orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(uid)}`;

  const getRes = await firestoreFetch(config.projectId, session.idToken, memberPath, {
    method: "GET"
  });

  if (getRes.ok && getRes.body?.fields) {
    const data = fieldsToObject(getRes.body.fields);
    const role = clean(data.role) || "member";
    const next = { ...session, memberReady: true, memberRole: role };
    await saveSession(next);
    return { alreadyMember: true, role };
  }

  const invitation = clean(config.bootstrapCode);
  if (!invitation) {
    throw new Error(
      "Not a member of this organization yet. Paste a full noctulist-fb:1 join code that includes the invitation code, then sign in again."
    );
  }

  const hashed = memberBootstrapField(invitation);
  const createBody = {
    fields: toFirestoreFields({
      role: "member",
      email: session.email || "",
      updatedAt: Date.now(),
      bootstrapCode: hashed
    })
  };

  const createUrl = `orgs/${encodeURIComponent(orgId)}/members?documentId=${encodeURIComponent(uid)}`;
  let write = await firestoreFetch(config.projectId, session.idToken, createUrl, {
    method: "POST",
    body: JSON.stringify(createBody)
  });

  if (!write.ok && (write.status === 409 || /already exists/i.test(write.body?.error?.message || ""))) {
    // Idempotent re-join: keep existing role; only refresh allowed fields.
    const existingRole =
      clean(fieldsToObject(getRes.body?.fields || {}).role) || "member";
    write = await firestoreFetch(
      config.projectId,
      session.idToken,
      `${memberPath}?updateMask.fieldPaths=email&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=bootstrapCode`,
      {
        method: "PATCH",
        body: JSON.stringify({
          fields: toFirestoreFields({
            email: session.email || "",
            updatedAt: Date.now(),
            bootstrapCode: hashed
          })
        })
      }
    );
    if (write.ok) {
      const next = { ...session, memberReady: true, memberRole: existingRole };
      await saveSession(next);
      return { alreadyMember: true, role: existingRole };
    }
  }

  if (!write.ok) {
    const msg = write.body?.error?.message || `Membership write failed (${write.status})`;
    throw new Error(
      `${msg}. Confirm the invitation code is current and your email domain is allowed.`
    );
  }

  const next = { ...session, memberReady: true, memberRole: "member" };
  await saveSession(next);
  return { alreadyMember: false, role: "member" };
}

async function loadPeopleFromFirebase() {
  const valid = await getValidSession();
  if (!valid) {
    throw new Error("Sign in with Google first.");
  }
  await ensureMembership();
  const again = await getValidSession();
  if (!again) {
    throw new Error("Session expired during membership setup.");
  }
  const { config, session } = again;
  const orgId = config.orgId;

  const [guestDocs, volunteerDocs] = await Promise.all([
    listCollection(config.projectId, session.idToken, `orgs/${orgId}/guests`),
    listCollection(config.projectId, session.idToken, `orgs/${orgId}/volunteers`)
  ]);

  const guests = [];
  guestDocs.forEach((doc, index) => {
    const person = mapGuestDoc(doc, index, orgId);
    if (person) guests.push(person);
  });

  const volunteers = [];
  volunteerDocs.forEach((doc, index) => {
    const person = mapVolunteerDoc(doc, index, orgId);
    if (person) volunteers.push(person);
  });

  const byKey = new Map();
  [...volunteers, ...guests].forEach((person) => {
    byKey.set(person.id, person);
  });

  const people = Array.from(byKey.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "fr", { sensitivity: "base" })
  );

  return {
    people,
    counts: {
      total: people.length,
      volunteers: people.filter((p) => p.category === "volunteer").length,
      permanentGuests: people.filter((p) => p.category === "permanent_guest").length,
      volunteerGuests: people.filter((p) => p.category === "volunteer_guest").length,
      temporaryGuests: people.filter((p) => p.category === "temporary_guest").length
    }
  };
}

function parseFirebaseStorageDownloadUrl(url) {
  const trimmed = clean(url);
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("gs://")) {
    const rest = trimmed.replace(/^gs:\/\//i, "");
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1).replace(/^\/+/, "") };
  }
  const match = trimmed.match(
    /https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/i
  );
  if (!match) return null;
  const bucket = match[1];
  const encodedPath = match[2];
  const objectPath = decodeURIComponent(encodedPath);
  return { bucket, path: objectPath.replace(/^\/+/, "") };
}

function storageBucketCandidates(storedBucket, projectId) {
  const stored = clean(storedBucket).replace(/^gs:\/\//, "").replace(/\/+$/, "");
  const pid = clean(projectId);
  const list = [];
  if (stored) list.push(stored);
  if (pid) {
    list.push(`${pid}.firebasestorage.app`);
    list.push(`${pid}.appspot.com`);
  }
  return [...new Set(list)];
}

async function downloadStorageBytes(bucket, objectPath, idToken) {
  const encoded = encodeURIComponent(objectPath).replace(/%2F/gi, "%2F");
  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encoded}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!res.ok) {
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}

async function fetchProfilePhoto(payload) {
  const valid = await getValidSession();
  if (!valid) {
    throw new Error("Sign in with Google first.");
  }
  const { config, session } = valid;
  const url = clean(payload?.profilePhotoUrl);
  const storagePath = clean(payload?.profilePhotoPath);
  if (!isStoredPhotoRef(url) && !isStoredPhotoRef(storagePath)) {
    return null;
  }

  const parsed = url ? parseFirebaseStorageDownloadUrl(url) : null;
  const objectPath = clean(parsed?.path) || storagePath;
  if (!objectPath) return null;

  const cacheKey = crypto.createHash("sha1").update(objectPath).digest("hex");
  const { photoCacheDir } = getPaths();
  await fs.mkdir(photoCacheDir, { recursive: true });
  const cacheFile = path.join(photoCacheDir, `${cacheKey}.jpg`);
  try {
    const existing = await fs.readFile(cacheFile);
    if (existing?.length) {
      return { base64: existing.toString("base64"), mimeType: "image/jpeg", fromCache: true };
    }
  } catch {
    /* miss */
  }

  const buckets = storageBucketCandidates(
    parsed?.bucket || config.storageBucket,
    config.projectId
  );
  let bytes = null;
  for (const bucket of buckets) {
    bytes = await downloadStorageBytes(bucket, objectPath, session.idToken);
    if (bytes) break;
  }
  if (!bytes && url && !parsed) {
    const res = await fetch(url);
    if (res.ok) {
      bytes = Buffer.from(await res.arrayBuffer());
    }
  }
  if (!bytes?.length) {
    return null;
  }
  await fs.writeFile(cacheFile, bytes);
  return { base64: bytes.toString("base64"), mimeType: "image/jpeg", fromCache: false };
}

module.exports = {
  ensureMembership,
  loadPeopleFromFirebase,
  fetchProfilePhoto,
  isStoredPhotoRef
};
