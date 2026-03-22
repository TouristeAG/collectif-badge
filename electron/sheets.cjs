const fs = require("fs/promises");
const { google } = require("googleapis");

const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const DEFAULT_SHEET_NAMES = {
  guestList: "Guest List",
  volunteerGuestList: "Volunteer Guest List",
  volunteers: "Volunteers",
  tempGuestList: "Temp Guest List"
};

function clean(value) {
  return String(value ?? "").trim();
}

function yesNoToBoolean(value) {
  return clean(value).toLowerCase() === "yes";
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

async function createSheetsClient(serviceAccountPath) {
  const raw = await fs.readFile(serviceAccountPath, "utf-8");
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [READONLY_SCOPE]
  });
  return google.sheets({ version: "v4", auth });
}

async function readRange(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return response.data.values ?? [];
}

function parseVolunteers(rows) {
  const people = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const eventManagerId = clean(row[0]);
    const name = clean(row[1]);
    if (!name) return;

    people.push(
      makeRecord("volunteers", rowNumber, "volunteer", name, {
        eventManagerId,
        abbreviation: clean(row[2]),
        email: clean(row[3]),
        phone: clean(row[4]),
        active: yesNoToBoolean(row[8]),
        rank: clean(row[7]),
        nfcCardUid: clean(row[10])
      })
    );
  });
  return people;
}

function parseGuestList(rows) {
  const people = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const name = clean(row[0]);
    if (!name) return;

    const isVolunteerBenefit = yesNoToBoolean(row[6]);
    people.push(
      makeRecord(
        "guest_list",
        rowNumber,
        isVolunteerBenefit ? "volunteer_guest" : "permanent_guest",
        name,
        {
          email: clean(row[1]),
          phone: clean(row[2]),
          invitations: Number.parseInt(clean(row[3]), 10) || 0,
          venue: clean(row[4]),
          notes: clean(row[5]),
          nfcCardUid: clean(row[8])
        }
      )
    );
  });
  return people;
}

function parseVolunteerGuestList(rows) {
  const people = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const name = clean(row[0]);
    if (!name) return;

    people.push(
      makeRecord("volunteer_guest_list", rowNumber, "volunteer_guest", name, {
        abbreviation: clean(row[1]),
        invitations: Number.parseInt(clean(row[2]), 10) || 0,
        venue: clean(row[3]),
        notes: clean(row[4]),
        nfcCardUid: clean(row[7])
      })
    );
  });
  return people;
}

function parseTempGuestList(rows) {
  const people = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const guestName = clean(row[4]);
    if (!guestName) return;

    people.push(
      makeRecord("temp_guest_list", rowNumber, "temporary_guest", guestName, {
        eventDate: clean(row[1]),
        artistName: clean(row[2]),
        artistContactPhone: clean(row[3]),
        notes: clean(row[5])
      })
    );
  });
  return people;
}

async function loadPeopleFromSheets(payload) {
  const spreadsheetId = clean(payload?.spreadsheetId);
  const serviceAccountKeyPath = clean(payload?.serviceAccountKeyPath);
  const sheetNames = {
    ...DEFAULT_SHEET_NAMES,
    ...(payload?.sheetNames ?? {})
  };

  if (!spreadsheetId) {
    throw new Error("Spreadsheet ID is required.");
  }
  if (!serviceAccountKeyPath) {
    throw new Error("Service account key path is required.");
  }

  const sheets = await createSheetsClient(serviceAccountKeyPath);
  const [volunteerRows, guestRows, volunteerGuestRows, tempGuestRows] = await Promise.all([
    readRange(sheets, spreadsheetId, `${sheetNames.volunteers}!A2:K`),
    readRange(sheets, spreadsheetId, `${sheetNames.guestList}!A2:I`),
    readRange(sheets, spreadsheetId, `${sheetNames.volunteerGuestList}!A2:H`),
    readRange(sheets, spreadsheetId, `${sheetNames.tempGuestList}!A2:F`)
  ]);

  const volunteers = parseVolunteers(volunteerRows);
  const guests = parseGuestList(guestRows);
  const volunteerGuests = parseVolunteerGuestList(volunteerGuestRows);
  const tempGuests = parseTempGuestList(tempGuestRows);

  const byKey = new Map();
  [...volunteers, ...guests, ...volunteerGuests, ...tempGuests].forEach((person) => {
    byKey.set(person.id, person);
  });

  const people = Array.from(byKey.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "fr", { sensitivity: "base" })
  );

  return {
    people,
    counts: {
      total: people.length,
      volunteers: people.filter((person) => person.category === "volunteer").length,
      permanentGuests: people.filter((person) => person.category === "permanent_guest").length,
      volunteerGuests: people.filter((person) => person.category === "volunteer_guest").length,
      temporaryGuests: people.filter((person) => person.category === "temporary_guest").length
    }
  };
}

module.exports = {
  loadPeopleFromSheets
};
