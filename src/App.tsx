import { useMemo, useState } from "react";
import "./App.css";
import { BadgeIllustrator } from "./components/BadgeIllustrator";
import { CanvaSettingsButton, CanvaSettingsModal } from "./components/CanvaSettingsModal";
import type { PersonCategory, PersonRecord, SheetNames } from "./types";

const DEFAULT_SHEET_NAMES: SheetNames = {
  guestList: "Guest List",
  volunteerGuestList: "Volunteer Guest List",
  volunteers: "Volunteers",
  tempGuestList: "Temp Guest List"
};

const CATEGORY_OPTIONS: Array<{ value: PersonCategory | "all"; label: string }> = [
  { value: "all", label: "All people" },
  { value: "volunteer", label: "Volunteers" },
  { value: "permanent_guest", label: "Permanent guests" },
  { value: "volunteer_guest", label: "Volunteer guests" },
  { value: "temporary_guest", label: "Temporary guests" }
];

function categoryLabel(category: PersonCategory): string {
  switch (category) {
    case "volunteer":
      return "Volunteer";
    case "permanent_guest":
      return "Permanent guest";
    case "volunteer_guest":
      return "Volunteer guest";
    case "temporary_guest":
      return "Temporary guest";
    default:
      return category;
  }
}

function App() {
  const [spreadsheetId, setSpreadsheetId] = useState(localStorage.getItem("spreadsheetId") ?? "");
  const [serviceAccountKeyPath, setServiceAccountKeyPath] = useState(
    localStorage.getItem("serviceAccountKeyPath") ?? ""
  );
  const [sheetNames, setSheetNames] = useState<SheetNames>({
    guestList: localStorage.getItem("sheet.guestList") ?? DEFAULT_SHEET_NAMES.guestList,
    volunteerGuestList:
      localStorage.getItem("sheet.volunteerGuestList") ?? DEFAULT_SHEET_NAMES.volunteerGuestList,
    volunteers: localStorage.getItem("sheet.volunteers") ?? DEFAULT_SHEET_NAMES.volunteers,
    tempGuestList: localStorage.getItem("sheet.tempGuestList") ?? DEFAULT_SHEET_NAMES.tempGuestList
  });

  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<PersonCategory | "all">("all");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isIllustratorOpen, setIsIllustratorOpen] = useState(false);
  const [isCanvaSettingsOpen, setIsCanvaSettingsOpen] = useState(false);

  const selectedPerson = useMemo(
    () => people.find((person) => person.id === selectedId) ?? null,
    [people, selectedId]
  );

  const filteredPeople = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((person) => {
      if (categoryFilter !== "all" && person.category !== categoryFilter) {
        return false;
      }
      if (!q) return true;

      const searchable = [
        person.displayName,
        person.email,
        person.phone,
        person.nfcCardUid,
        person.venue,
        person.notes,
        person.artistName
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchable.includes(q);
    });
  }, [people, query, categoryFilter]);

  const counts = useMemo(() => {
    const byCategory = {
      volunteer: 0,
      permanent_guest: 0,
      volunteer_guest: 0,
      temporary_guest: 0
    };
    people.forEach((person) => {
      byCategory[person.category] += 1;
    });
    return { total: people.length, ...byCategory };
  }, [people]);

  async function pickKeyFile() {
    setError("");
    if (!window.electronAPI) {
      setError("Desktop API unavailable. Please run this app with Electron (`npm run dev`).");
      return;
    }
    const file = await window.electronAPI.pickServiceAccountKey();
    if (file) {
      setServiceAccountKeyPath(file);
      localStorage.setItem("serviceAccountKeyPath", file);
    }
  }

  async function refreshFromSheets() {
    setError("");
    if (!window.electronAPI) {
      setError("Desktop API unavailable. Please run this app with Electron (`npm run dev`).");
      return;
    }

    if (!spreadsheetId.trim() || !serviceAccountKeyPath.trim()) {
      setError("Please set Spreadsheet ID and Service Account JSON path first.");
      return;
    }

    setIsLoading(true);
    try {
      const response = await window.electronAPI.loadPeopleFromSheets({
        spreadsheetId: spreadsheetId.trim(),
        serviceAccountKeyPath: serviceAccountKeyPath.trim(),
        sheetNames
      });
      setPeople(response.people);
      setSelectedId((old) => (response.people.some((person) => person.id === old) ? old : null));
      localStorage.setItem("spreadsheetId", spreadsheetId.trim());
      localStorage.setItem("sheet.guestList", sheetNames.guestList);
      localStorage.setItem("sheet.volunteerGuestList", sheetNames.volunteerGuestList);
      localStorage.setItem("sheet.volunteers", sheetNames.volunteers);
      localStorage.setItem("sheet.tempGuestList", sheetNames.tempGuestList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Google Sheets data.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Collectif Badge Manager</h1>
          <p>Read-only sync from Google Sheets for volunteers and guests.</p>
        </div>
        <div className="topbar-actions">
          <CanvaSettingsButton onClick={() => setIsCanvaSettingsOpen(true)} />
          <button className="primary" onClick={refreshFromSheets} disabled={isLoading}>
            {isLoading ? "Refreshing..." : "Refresh from Sheets"}
          </button>
        </div>
      </header>

      <CanvaSettingsModal isOpen={isCanvaSettingsOpen} onClose={() => setIsCanvaSettingsOpen(false)} />

      <section className="setup-card">
        <div className="form-grid">
          <label>
            Spreadsheet ID
            <input
              value={spreadsheetId}
              onChange={(event) => setSpreadsheetId(event.target.value)}
              placeholder="1AbCdEfGh..."
            />
          </label>
          <label className="key-picker">
            Service account JSON path
            <input
              value={serviceAccountKeyPath}
              onChange={(event) => setServiceAccountKeyPath(event.target.value)}
              placeholder="/path/to/service-account.json"
            />
            <button type="button" onClick={pickKeyFile}>
              Browse
            </button>
          </label>
          <label>
            Volunteers sheet
            <input
              value={sheetNames.volunteers}
              onChange={(event) =>
                setSheetNames((old) => ({ ...old, volunteers: event.target.value }))
              }
            />
          </label>
          <label>
            Permanent guests sheet
            <input
              value={sheetNames.guestList}
              onChange={(event) => setSheetNames((old) => ({ ...old, guestList: event.target.value }))}
            />
          </label>
          <label>
            Volunteer guests sheet
            <input
              value={sheetNames.volunteerGuestList}
              onChange={(event) =>
                setSheetNames((old) => ({ ...old, volunteerGuestList: event.target.value }))
              }
            />
          </label>
          <label>
            Temporary guests sheet
            <input
              value={sheetNames.tempGuestList}
              onChange={(event) =>
                setSheetNames((old) => ({ ...old, tempGuestList: event.target.value }))
              }
            />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="stats">
        <article>
          <strong>{counts.total}</strong>
          <span>Total</span>
        </article>
        <article>
          <strong>{counts.volunteer}</strong>
          <span>Volunteers</span>
        </article>
        <article>
          <strong>{counts.permanent_guest}</strong>
          <span>Permanent guests</span>
        </article>
        <article>
          <strong>{counts.volunteer_guest}</strong>
          <span>Volunteer guests</span>
        </article>
        <article>
          <strong>{counts.temporary_guest}</strong>
          <span>Temporary guests</span>
        </article>
      </section>

      <section className="workspace">
        <aside className="list-panel">
          <div className="list-toolbar">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, email, phone, venue..."
            />
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value as PersonCategory | "all")}
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="list">
            {filteredPeople.map((person) => {
              const isSelected = person.id === selectedId;
              return (
                <button
                  key={person.id}
                  className={`person-row ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedId(person.id)}
                >
                  <div className="avatar">{person.displayName.slice(0, 1).toUpperCase()}</div>
                  <div className="person-main">
                    <strong>{person.displayName}</strong>
                    <small>{categoryLabel(person.category)}</small>
                  </div>
                  <span className={`pill ${person.category}`}>{categoryLabel(person.category)}</span>
                </button>
              );
            })}
            {filteredPeople.length === 0 && <p className="empty">No people found with this filter.</p>}
          </div>
        </aside>

        <section className="detail-panel">
          {selectedPerson ? (
            <>
              <div className="detail-header">
                <h2>{selectedPerson.displayName}</h2>
                <span className={`pill ${selectedPerson.category}`}>
                  {categoryLabel(selectedPerson.category)}
                </span>
              </div>
              <dl>
                <dt>Sheet source</dt>
                <dd>
                  {selectedPerson.source} (row {selectedPerson.rowNumber})
                </dd>

                {selectedPerson.abbreviation && (
                  <>
                    <dt>Last name (sheet column: Abbreviation)</dt>
                    <dd>{selectedPerson.abbreviation}</dd>
                  </>
                )}
                {selectedPerson.rank && (
                  <>
                    <dt>Rank</dt>
                    <dd>{selectedPerson.rank}</dd>
                  </>
                )}
                {selectedPerson.email && (
                  <>
                    <dt>Email</dt>
                    <dd>{selectedPerson.email}</dd>
                  </>
                )}
                {selectedPerson.phone && (
                  <>
                    <dt>Phone</dt>
                    <dd>{selectedPerson.phone}</dd>
                  </>
                )}
                {typeof selectedPerson.active === "boolean" && (
                  <>
                    <dt>Status</dt>
                    <dd>{selectedPerson.active ? "Active" : "Inactive"}</dd>
                  </>
                )}
                {typeof selectedPerson.invitations === "number" && (
                  <>
                    <dt>Invitations</dt>
                    <dd>{selectedPerson.invitations}</dd>
                  </>
                )}
                {selectedPerson.venue && (
                  <>
                    <dt>Venue</dt>
                    <dd>{selectedPerson.venue}</dd>
                  </>
                )}
                {selectedPerson.eventDate && (
                  <>
                    <dt>Event date</dt>
                    <dd>{selectedPerson.eventDate}</dd>
                  </>
                )}
                {selectedPerson.artistName && (
                  <>
                    <dt>Artist/Group</dt>
                    <dd>{selectedPerson.artistName}</dd>
                  </>
                )}
                {selectedPerson.artistContactPhone && (
                  <>
                    <dt>Artist contact</dt>
                    <dd>{selectedPerson.artistContactPhone}</dd>
                  </>
                )}
                {selectedPerson.nfcCardUid && (
                  <>
                    <dt>NFC UID</dt>
                    <dd>{selectedPerson.nfcCardUid}</dd>
                  </>
                )}
                {selectedPerson.notes && (
                  <>
                    <dt>Notes</dt>
                    <dd>{selectedPerson.notes}</dd>
                  </>
                )}
              </dl>
            </>
          ) : (
            <div className="empty-detail">
              <h2>Select a person</h2>
              <p>Choose someone in the list to prepare the badge workflow.</p>
            </div>
          )}
        </section>
      </section>

      {selectedPerson && (
        <button className="floating-illustrator-btn primary" onClick={() => setIsIllustratorOpen(true)}>
          Open in badge illustrator
        </button>
      )}

      {isIllustratorOpen && selectedPerson && (
        <div className="illustrator-modal-backdrop" onClick={() => setIsIllustratorOpen(false)}>
          <section className="illustrator-modal-window" onClick={(event) => event.stopPropagation()}>
            <header className="illustrator-modal-header">
              <div>
                <h2>{selectedPerson.displayName}</h2>
                <p>Large badge workspace</p>
              </div>
              <button className="modal-close-btn" onClick={() => setIsIllustratorOpen(false)}>
                Close
              </button>
            </header>
            <BadgeIllustrator key={selectedPerson.id} person={selectedPerson} />
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
