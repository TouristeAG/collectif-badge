import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import { BadgeIllustrator } from "./components/BadgeIllustrator";
import { CanvaSettingsButton, CanvaSettingsModal } from "./components/CanvaSettingsModal";
import { GoogleSheetsHelpModal } from "./components/GoogleSheetsHelp";
import type { PersonCategory, PersonRecord, SheetNames } from "./types";

const DEFAULT_SHEET_NAMES: SheetNames = {
  guestList: "Guest List",
  volunteerGuestList: "Volunteer Guest List",
  volunteers: "Volunteers",
  tempGuestList: "Temp Guest List"
};

type PersonListRowProps = {
  person: PersonRecord;
  isSelected: boolean;
  isChecked: boolean;
  categoryLabelText: string;
  includeInIllustratorAria: string;
  onToggleCheck: (id: string) => void;
  onSelectId: (id: string) => void;
};

const PersonListRow = memo(function PersonListRow({
  person,
  isSelected,
  isChecked,
  categoryLabelText,
  includeInIllustratorAria,
  onToggleCheck,
  onSelectId
}: PersonListRowProps) {
  return (
    <div className={`person-row ${isSelected ? "selected" : ""}`}>
      <label className="person-select-cell">
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onToggleCheck(person.id)}
          aria-label={includeInIllustratorAria}
        />
      </label>
      <button type="button" className="person-row-main" onClick={() => onSelectId(person.id)}>
        <div className="avatar">{person.displayName.slice(0, 1).toUpperCase()}</div>
        <div className="person-main">
          <strong>{person.displayName}</strong>
          <small>{categoryLabelText}</small>
        </div>
        <span className={`pill ${person.category}`}>{categoryLabelText}</span>
      </button>
    </div>
  );
});

function App() {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = t("meta.title");
  }, [t]);

  const CATEGORY_OPTIONS = useMemo(
    () =>
      [
        { value: "all" as const, label: t("app.filterAll") },
        { value: "volunteer" as const, label: t("app.filterVolunteers") },
        { value: "permanent_guest" as const, label: t("app.filterPermanentGuests") },
        { value: "volunteer_guest" as const, label: t("app.filterVolunteerGuests") },
        { value: "temporary_guest" as const, label: t("app.filterTempGuests") }
      ] as const,
    [t]
  );

  const categoryLabel = useCallback(
    (category: PersonCategory): string => {
      switch (category) {
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
  /** When non-empty, opening the illustrator uses these people (sheet order). Otherwise the single selected row is used. */
  const [checkedForIllustrator, setCheckedForIllustrator] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<PersonCategory | "all">("all");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isIllustratorOpen, setIsIllustratorOpen] = useState(false);
  const [isCanvaSettingsOpen, setIsCanvaSettingsOpen] = useState(false);
  const [isSheetsHelpOpen, setIsSheetsHelpOpen] = useState(false);

  const selectedPerson = useMemo(
    () => people.find((person) => person.id === selectedId) ?? null,
    [people, selectedId]
  );

  const illustratorPeople = useMemo(() => {
    const checkedOrdered = people.filter((person) => checkedForIllustrator.has(person.id));
    if (checkedOrdered.length > 0) {
      return checkedOrdered;
    }
    if (selectedPerson) {
      return [selectedPerson];
    }
    return [];
  }, [people, checkedForIllustrator, selectedPerson]);

  const toggleIllustratorCheck = useCallback((id: string) => {
    setCheckedForIllustrator((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

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
      setError(t("app.errorDesktopApi"));
      return;
    }
    const file = await window.electronAPI.pickServiceAccountKey();
    if (file) {
      setServiceAccountKeyPath(file);
      localStorage.setItem("serviceAccountKeyPath", file);
    }
  }

  const refreshFromSheets = useCallback(async () => {
    setError("");
    if (!window.electronAPI) {
      setError(t("app.errorDesktopApi"));
      return;
    }

    if (!spreadsheetId.trim() || !serviceAccountKeyPath.trim()) {
      setError(t("app.errorSpreadsheetRequired"));
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
      setCheckedForIllustrator((prev) => {
        const valid = new Set(response.people.map((person) => person.id));
        return new Set([...prev].filter((id) => valid.has(id)));
      });
      localStorage.setItem("spreadsheetId", spreadsheetId.trim());
      localStorage.setItem("sheet.guestList", sheetNames.guestList);
      localStorage.setItem("sheet.volunteerGuestList", sheetNames.volunteerGuestList);
      localStorage.setItem("sheet.volunteers", sheetNames.volunteers);
      localStorage.setItem("sheet.tempGuestList", sheetNames.tempGuestList);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("app.errorLoadSheets"));
    } finally {
      setIsLoading(false);
    }
  }, [spreadsheetId, serviceAccountKeyPath, sheetNames, t]);

  const refreshFromSheetsRef = useRef(refreshFromSheets);
  refreshFromSheetsRef.current = refreshFromSheets;

  useEffect(() => {
    if (!window.electronAPI) return;
    if (!spreadsheetId.trim() || !serviceAccountKeyPath.trim()) return;
    void refreshFromSheetsRef.current();
    // Intentionally once on mount: use persisted settings from the first paint only.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startup auto-refresh only
  }, []);

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>{t("meta.title")}</h1>
          <p>{t("app.tagline")}</p>
        </div>
        <div className="topbar-actions">
          <CanvaSettingsButton onClick={() => setIsCanvaSettingsOpen(true)} />
          <button className="primary" onClick={refreshFromSheets} disabled={isLoading}>
            {isLoading ? t("app.refreshing") : t("app.refreshSheets")}
          </button>
        </div>
      </header>

      <CanvaSettingsModal isOpen={isCanvaSettingsOpen} onClose={() => setIsCanvaSettingsOpen(false)} />
      <GoogleSheetsHelpModal isOpen={isSheetsHelpOpen} onClose={() => setIsSheetsHelpOpen(false)} />

      <section className="setup-card">
        <div className="setup-card-header">
          <h2>{t("sheetsHelp.cardTitle")}</h2>
          <button
            type="button"
            className="icon-button setup-card-help-btn"
            onClick={() => setIsSheetsHelpOpen(true)}
            aria-label={t("sheetsHelp.openHelpAria")}
            title={t("sheetsHelp.openHelpTitle")}
          >
            ?
          </button>
        </div>
        <div className="form-grid">
          <label>
            {t("app.spreadsheetId")}
            <input
              value={spreadsheetId}
              onChange={(event) => setSpreadsheetId(event.target.value)}
              placeholder="1AbCdEfGh..."
            />
          </label>
          <label className="key-picker">
            {t("app.serviceAccountPath")}
            <input
              value={serviceAccountKeyPath}
              onChange={(event) => setServiceAccountKeyPath(event.target.value)}
              placeholder="/path/to/service-account.json"
            />
            <button type="button" onClick={pickKeyFile}>
              {t("common.browse")}
            </button>
          </label>
          <label>
            {t("app.volunteersSheet")}
            <input
              value={sheetNames.volunteers}
              onChange={(event) =>
                setSheetNames((old) => ({ ...old, volunteers: event.target.value }))
              }
            />
          </label>
          <label>
            {t("app.permanentGuestsSheet")}
            <input
              value={sheetNames.guestList}
              onChange={(event) => setSheetNames((old) => ({ ...old, guestList: event.target.value }))}
            />
          </label>
          <label>
            {t("app.volunteerGuestsSheet")}
            <input
              value={sheetNames.volunteerGuestList}
              onChange={(event) =>
                setSheetNames((old) => ({ ...old, volunteerGuestList: event.target.value }))
              }
            />
          </label>
          <label>
            {t("app.tempGuestsSheet")}
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
          <span>{t("app.statsTotal")}</span>
        </article>
        <article>
          <strong>{counts.volunteer}</strong>
          <span>{t("app.statsVolunteers")}</span>
        </article>
        <article>
          <strong>{counts.permanent_guest}</strong>
          <span>{t("app.statsPermanentGuests")}</span>
        </article>
        <article>
          <strong>{counts.volunteer_guest}</strong>
          <span>{t("app.statsVolunteerGuests")}</span>
        </article>
        <article>
          <strong>{counts.temporary_guest}</strong>
          <span>{t("app.statsTempGuests")}</span>
        </article>
      </section>

      <section className="workspace">
        <aside className="list-panel">
          <div className="list-toolbar">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("app.searchPlaceholder")}
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
          <p className="list-multi-hint">{t("app.listMultiHint")}</p>
          <div className="list">
            {filteredPeople.map((person) => (
              <PersonListRow
                key={person.id}
                person={person}
                isSelected={person.id === selectedId}
                isChecked={checkedForIllustrator.has(person.id)}
                categoryLabelText={categoryLabel(person.category)}
                includeInIllustratorAria={t("app.includeInIllustrator", { name: person.displayName })}
                onToggleCheck={toggleIllustratorCheck}
                onSelectId={setSelectedId}
              />
            ))}
            {filteredPeople.length === 0 && <p className="empty">{t("app.emptyList")}</p>}
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
                <dt>{t("app.detailSheetSource")}</dt>
                <dd>
                  {selectedPerson.source} (row {selectedPerson.rowNumber})
                </dd>

                {selectedPerson.abbreviation && (
                  <>
                    <dt>{t("app.detailAbbreviation")}</dt>
                    <dd>{selectedPerson.abbreviation}</dd>
                  </>
                )}
                {selectedPerson.rank && (
                  <>
                    <dt>{t("app.detailRank")}</dt>
                    <dd>{selectedPerson.rank}</dd>
                  </>
                )}
                {selectedPerson.email && (
                  <>
                    <dt>{t("app.detailEmail")}</dt>
                    <dd>{selectedPerson.email}</dd>
                  </>
                )}
                {selectedPerson.phone && (
                  <>
                    <dt>{t("app.detailPhone")}</dt>
                    <dd>{selectedPerson.phone}</dd>
                  </>
                )}
                {typeof selectedPerson.active === "boolean" && (
                  <>
                    <dt>{t("app.detailStatus")}</dt>
                    <dd>{selectedPerson.active ? t("app.detailActive") : t("app.detailInactive")}</dd>
                  </>
                )}
                {typeof selectedPerson.invitations === "number" && (
                  <>
                    <dt>{t("app.detailInvitations")}</dt>
                    <dd>{selectedPerson.invitations}</dd>
                  </>
                )}
                {selectedPerson.venue && (
                  <>
                    <dt>{t("app.detailVenue")}</dt>
                    <dd>{selectedPerson.venue}</dd>
                  </>
                )}
                {selectedPerson.eventDate && (
                  <>
                    <dt>{t("app.detailEventDate")}</dt>
                    <dd>{selectedPerson.eventDate}</dd>
                  </>
                )}
                {selectedPerson.artistName && (
                  <>
                    <dt>{t("app.detailArtist")}</dt>
                    <dd>{selectedPerson.artistName}</dd>
                  </>
                )}
                {selectedPerson.artistContactPhone && (
                  <>
                    <dt>{t("app.detailArtistContact")}</dt>
                    <dd>{selectedPerson.artistContactPhone}</dd>
                  </>
                )}
                {selectedPerson.nfcCardUid && (
                  <>
                    <dt>{t("app.detailNfcUid")}</dt>
                    <dd>{selectedPerson.nfcCardUid}</dd>
                  </>
                )}
                {selectedPerson.notes && (
                  <>
                    <dt>{t("app.detailNotes")}</dt>
                    <dd>{selectedPerson.notes}</dd>
                  </>
                )}
              </dl>
            </>
          ) : (
            <div className="empty-detail">
              <h2>{t("app.emptyDetailTitle")}</h2>
              <p>{t("app.emptyDetailBody")}</p>
            </div>
          )}
        </section>
      </section>

      {illustratorPeople.length > 0 && (
        <button className="floating-illustrator-btn primary" onClick={() => setIsIllustratorOpen(true)}>
          {illustratorPeople.length > 1
            ? t("app.openIllustratorMulti", { count: illustratorPeople.length })
            : t("app.openIllustratorOne")}
        </button>
      )}

      {isIllustratorOpen && illustratorPeople.length > 0 && (
        <div className="illustrator-modal-backdrop" onClick={() => setIsIllustratorOpen(false)}>
          <section className="illustrator-modal-window" onClick={(event) => event.stopPropagation()}>
            <header className="illustrator-modal-header">
              <div>
                <h2>
                  {illustratorPeople.length > 1
                    ? t("app.illustratorModalMultiTitle", { count: illustratorPeople.length })
                    : illustratorPeople[0].displayName}
                </h2>
                <p>{t("app.illustratorModalSubtitle")}</p>
              </div>
              <button className="modal-close-btn" onClick={() => setIsIllustratorOpen(false)}>
                {t("common.close")}
              </button>
            </header>
            <BadgeIllustrator
              key={illustratorPeople.map((p) => p.id).join("|")}
              people={illustratorPeople as [PersonRecord, ...PersonRecord[]]}
            />
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
