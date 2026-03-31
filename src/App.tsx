import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import { BadgeIllustrator } from "./components/BadgeIllustrator";
import { CanvaSettingsButton, CanvaSettingsModal } from "./components/CanvaSettingsModal";
import { GoogleSheetsHelpModal } from "./components/GoogleSheetsHelp";
import type { PeopleResponse, PersonCategory, PersonRecord, SheetNames } from "./types";
import collectifnocturneLogo from "./assets/logo/collectifnocturne.png";

function useDarkMode(): [boolean, () => void] {
  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("theme");
      if (stored === "dark") return true;
      if (stored === "light") return false;
    } catch { /* noop */ }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.setAttribute("data-theme", "dark");
      try { localStorage.setItem("theme", "dark"); } catch { /* noop */ }
    } else {
      root.removeAttribute("data-theme");
      try { localStorage.setItem("theme", "light"); } catch { /* noop */ }
    }
  }, [isDark]);

  const toggle = useCallback(() => setIsDark((prev) => !prev), []);
  return [isDark, toggle];
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function DarkModeToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`theme-toggle ${isDark ? "is-dark" : "is-light"}`}
      onClick={onToggle}
      title={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
      aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
      aria-pressed={isDark}
    >
      <span className="theme-toggle-thumb" />
      <span className="theme-toggle-icon theme-toggle-icon--sun">
        <SunIcon />
      </span>
      <span className="theme-toggle-icon theme-toggle-icon--moon">
        <MoonIcon />
      </span>
    </button>
  );
}

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

function normalizePersonRecord(person: PersonRecord, index: number): PersonRecord {
  const fallbackId = person.id || `row-${person.source || "sheet"}-${person.rowNumber || index + 1}`;
  const normalizedSheetColumns =
    person.sheetColumns && typeof person.sheetColumns === "object" ? person.sheetColumns : undefined;
  const normalizedEventManagerIdRaw =
    typeof person.eventManagerId === "string" && person.eventManagerId.trim()
      ? person.eventManagerId
      : normalizedSheetColumns?.G;
  return {
    ...person,
    id: String(fallbackId),
    eventManagerId: typeof normalizedEventManagerIdRaw === "string" ? normalizedEventManagerIdRaw : "",
    sheetColumns: normalizedSheetColumns,
    displayName: String(person.displayName ?? "").trim() || `Person ${index + 1}`,
    abbreviation: typeof person.abbreviation === "string" ? person.abbreviation : "",
    email: typeof person.email === "string" ? person.email : "",
    phone: typeof person.phone === "string" ? person.phone : "",
    venue: typeof person.venue === "string" ? person.venue : "",
    notes: typeof person.notes === "string" ? person.notes : "",
    artistName: typeof person.artistName === "string" ? person.artistName : "",
  };
}

function normalizePeopleResponse(response: PeopleResponse): PeopleResponse {
  return {
    ...response,
    people: (response.people ?? []).map(normalizePersonRecord),
  };
}

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
  const [isDark, toggleDarkMode] = useDarkMode();
  const isDesktopApp = Boolean(window.electronAPI);
  const [updateStatus, setUpdateStatus] = useState<{
    checkedAt: number | null;
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    mandatory: boolean;
    minRequiredVersion: string | null;
    releaseUrl: string;
    notes: string;
    error: string;
  } | null>(null);

  useEffect(() => {
    document.title = t("meta.title");
  }, [t]);

  useEffect(() => {
    if (!isDesktopApp) return;
    document.body.classList.add("electron-app");
    return () => document.body.classList.remove("electron-app");
  }, [isDesktopApp]);

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
  const [serviceAccountConfigured, setServiceAccountConfigured] = useState(false);
  const [serviceAccountEmail, setServiceAccountEmail] = useState("");
  const [webApiBaseUrl, setWebApiBaseUrl] = useState(
    localStorage.getItem("webApiBaseUrl") ?? ""
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
  const [hideTemporaryGuests, setHideTemporaryGuests] = useState(true);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [networkShareRunning, setNetworkShareRunning] = useState(false);
  const [networkShareUrls, setNetworkShareUrls] = useState<string[]>([]);
  const [copiedNetworkUrl, setCopiedNetworkUrl] = useState("");
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
      if (hideTemporaryGuests && person.category === "temporary_guest") {
        return false;
      }
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
  }, [people, query, categoryFilter, hideTemporaryGuests]);

  const counts = useMemo(() => {
    const byCategory = {
      volunteer: 0,
      permanent_guest: 0,
      volunteer_guest: 0,
      temporary_guest: 0
    };
    people.forEach((person) => {
      if (person.category in byCategory) {
        byCategory[person.category as keyof typeof byCategory] += 1;
      }
    });
    return { total: people.length, ...byCategory };
  }, [people]);

  async function importKeyFile() {
    setError("");
    if (!window.electronAPI) {
      setError(t("app.errorImportDesktopOnly"));
      return;
    }
    try {
      const result = await window.electronAPI.importServiceAccountKey();
      if (result?.configured) {
        setServiceAccountConfigured(true);
        setServiceAccountEmail(result.clientEmail || "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("app.errorImportServiceAccount"));
    }
  }

  async function toggleNetworkShare() {
    setError("");
    if (!window.electronAPI) return;
    const startShare = window.electronAPI.networkShareStart;
    const stopShare = window.electronAPI.networkShareStop;
    if (typeof startShare !== "function" || typeof stopShare !== "function") {
      setError(t("app.errorNetworkShareUnavailable"));
      return;
    }
    try {
      if (!networkShareRunning && !spreadsheetId.trim()) {
        setError(t("app.errorSpreadsheetIdRequired"));
        return;
      }
      const status = networkShareRunning
        ? await stopShare()
        : await startShare({ spreadsheetId: spreadsheetId.trim() });
      setNetworkShareRunning(status.running);
      setNetworkShareUrls(status.networkUrls);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message.includes("No handler registered")) {
        setError(t("app.errorNetworkShareUnavailable"));
      } else {
        setError(message || t("app.errorNetworkShare"));
      }
    }
  }

  async function copyNetworkUrl(url: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement("input");
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      setCopiedNetworkUrl(url);
      window.setTimeout(() => setCopiedNetworkUrl(""), 1600);
    } catch {
      setError(t("app.errorCopyNetworkUrl"));
    }
  }

  const refreshFromSheets = useCallback(async () => {
    setError("");
    if (!spreadsheetId.trim()) {
      setError(t("app.errorSpreadsheetIdRequired"));
      return;
    }
    if (isDesktopApp && !serviceAccountConfigured) {
      setError(t("app.errorSpreadsheetRequired"));
      return;
    }
    setIsLoading(true);
    try {
      let response: PeopleResponse;
      if (window.electronAPI) {
        response = await window.electronAPI.loadPeopleFromSheets({
          spreadsheetId: spreadsheetId.trim(),
          sheetNames
        });
      } else {
        const baseUrlRaw = webApiBaseUrl.trim() || window.location.origin;
        const baseUrl = baseUrlRaw.replace(/\/+$/, "");
        const http = await fetch(`${baseUrl}/sheets/loadPeople`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            spreadsheetId: spreadsheetId.trim(),
            sheetNames
          })
        });
        if (!http.ok) {
          const errText = await http.text();
          try {
            const parsed = JSON.parse(errText) as { error?: string };
            throw new Error(parsed.error || errText);
          } catch {
            throw new Error(errText || t("app.errorLoadSheets"));
          }
        }
        response = (await http.json()) as PeopleResponse;
      }
      const normalizedResponse = normalizePeopleResponse(response);
      setPeople(normalizedResponse.people);
      setSelectedId((old) => (normalizedResponse.people.some((person) => person.id === old) ? old : null));
      setCheckedForIllustrator((prev) => {
        const valid = new Set(normalizedResponse.people.map((person) => person.id));
        return new Set([...prev].filter((id) => valid.has(id)));
      });
      localStorage.setItem("spreadsheetId", spreadsheetId.trim());
      localStorage.setItem("sheet.guestList", sheetNames.guestList);
      localStorage.setItem("sheet.volunteerGuestList", sheetNames.volunteerGuestList);
      localStorage.setItem("sheet.volunteers", sheetNames.volunteers);
      localStorage.setItem("sheet.tempGuestList", sheetNames.tempGuestList);
      if (!isDesktopApp) {
        localStorage.setItem("webApiBaseUrl", webApiBaseUrl.trim());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("app.errorLoadSheets"));
    } finally {
      setIsLoading(false);
    }
  }, [spreadsheetId, serviceAccountConfigured, sheetNames, t, isDesktopApp, webApiBaseUrl]);

  const refreshFromSheetsRef = useRef(refreshFromSheets);
  refreshFromSheetsRef.current = refreshFromSheets;

  useEffect(() => {
    try {
      localStorage.setItem("spreadsheetId", spreadsheetId);
    } catch {
      // ignore storage errors
    }
  }, [spreadsheetId]);

  useEffect(() => {
    if (window.electronAPI) {
      void window.electronAPI
        .getServiceAccountStatus()
        .then((status) => {
          setServiceAccountConfigured(Boolean(status?.configured));
          setServiceAccountEmail(status?.clientEmail ?? "");
        })
        .catch(() => {
          setServiceAccountConfigured(false);
          setServiceAccountEmail("");
        });
      return;
    }
    const baseUrlRaw = webApiBaseUrl.trim() || window.location.origin;
    const baseUrl = baseUrlRaw.replace(/\/+$/, "");
    void fetch(`${baseUrl}/sheets/status`)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((status) => {
        setServiceAccountConfigured(Boolean(status?.configured));
        setServiceAccountEmail(status?.clientEmail ?? "");
        if (!spreadsheetId.trim() && typeof status?.defaultSpreadsheetId === "string") {
          setSpreadsheetId(status.defaultSpreadsheetId);
        }
      })
      .catch(() => {
        setServiceAccountConfigured(false);
        setServiceAccountEmail("");
      });
  }, [webApiBaseUrl, spreadsheetId]);

  useEffect(() => {
    if (!window.electronAPI) return;
    if (typeof window.electronAPI.networkShareGetStatus !== "function") return;
    void window.electronAPI
      .networkShareGetStatus()
      .then((status) => {
        setNetworkShareRunning(status.running);
        setNetworkShareUrls(status.networkUrls);
      })
      .catch(() => {
        setNetworkShareRunning(false);
        setNetworkShareUrls([]);
      });
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.updaterCheckNow) return;
    void window.electronAPI
      .updaterCheckNow()
      .then((status) => setUpdateStatus(status))
      .catch(() => {
        /* ignore updater bootstrap failures */
      });
  }, []);

  useEffect(() => {
    if (!spreadsheetId.trim()) return;
    if (!serviceAccountConfigured) return;
    void refreshFromSheetsRef.current();
    // Intentionally auto-refresh only when startup settings are ready.
  }, [spreadsheetId, serviceAccountConfigured, isDesktopApp, webApiBaseUrl]);

  return (
    <main className="app">
      {isDesktopApp && updateStatus?.updateAvailable && (
        <div className={`setup-card ${updateStatus.mandatory ? "update-banner-mandatory" : "update-banner"}`}>
          <div className="setup-card-header" style={{ marginBottom: "0.5rem" }}>
            <h2>{updateStatus.mandatory ? t("app.updateMandatoryTitle") : t("app.updateAvailableTitle")}</h2>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {t("app.updateBody", {
              current: updateStatus.currentVersion,
              latest: updateStatus.latestVersion ?? "?",
            })}
          </p>
          {updateStatus.notes ? (
            <p className="hint" style={{ marginTop: "0.35rem" }}>
              {updateStatus.notes}
            </p>
          ) : null}
          <div className="topbar-actions" style={{ marginTop: "0.6rem" }}>
            <button
              type="button"
              className="primary"
              onClick={() => void window.electronAPI?.updaterOpenUpdatePage?.()}
            >
              {t("app.updateNow")}
            </button>
            {!updateStatus.mandatory && (
              <button
                type="button"
                onClick={() => setUpdateStatus((prev) => (prev ? { ...prev, updateAvailable: false } : prev))}
              >
                {t("app.updateLater")}
              </button>
            )}
            {updateStatus.mandatory && (
              <button type="button" onClick={() => void window.electronAPI?.appQuit?.()}>
                {t("app.quitApp")}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="app-hero-surface">
        <header className="topbar">
          <div className="topbar-brand">
            <div className="topbar-logo-wrap">
              <img
                className="topbar-logo"
                src={collectifnocturneLogo}
                alt={t("meta.brandLogoAlt")}
                decoding="async"
              />
            </div>
            <div className="topbar-titles">
              <h1>{t("meta.title")}</h1>
              <p className="topbar-tagline">{t("app.tagline")}</p>
            </div>
          </div>
          <div className="topbar-actions">
            <DarkModeToggle isDark={isDark} onToggle={toggleDarkMode} />
            <CanvaSettingsButton onClick={() => setIsCanvaSettingsOpen(true)} />
            <button className="primary topbar-refresh" onClick={refreshFromSheets} disabled={isLoading}>
              {isLoading ? t("app.refreshing") : t("app.refreshSheets")}
            </button>
          </div>
        </header>
      </div>
      {isDesktopApp && (
        <section className="network-share-card">
          <div className="network-share-head">
            <div>
              <h3>{t("app.networkShareTitle")}</h3>
              <p>{t("app.networkShareDescription")}</p>
            </div>
            <button
              type="button"
              className={`network-share-toggle ${networkShareRunning ? "is-on" : ""}`}
              onClick={() => void toggleNetworkShare()}
              aria-pressed={networkShareRunning}
            >
              <span className="network-share-toggle-dot" />
              {networkShareRunning ? t("app.networkShareOn") : t("app.networkShareOff")}
            </button>
          </div>
          {networkShareRunning && networkShareUrls.length > 0 ? (
            <div className="network-share-url-block">
              <span className="network-share-url-label">{t("app.networkShareRunningOn")}:</span>
              {networkShareUrls.length > 1 ? (
                <p className="network-share-multi-hint">{t("app.networkShareMultiUrlHint")}</p>
              ) : null}
              <ul className="network-share-url-list">
                {networkShareUrls.map((url) => (
                  <li key={url} className="network-share-url-row">
                    <a href={url} target="_blank" rel="noreferrer" className="network-share-link">
                      {url}
                    </a>
                    <button
                      type="button"
                      className="icon-button network-share-copy-btn"
                      onClick={() => void copyNetworkUrl(url)}
                      aria-label={t("app.copyNetworkUrl")}
                      title={t("app.copyNetworkUrl")}
                    >
                      ⧉
                    </button>
                    {copiedNetworkUrl === url ? (
                      <span className="network-share-copied">{t("app.copied")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="network-share-off-hint">{t("app.networkShareOffHint")}</p>
          )}
        </section>
      )}

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
            {t("app.serviceAccountImport")}
            <input
              value={
                serviceAccountConfigured
                  ? serviceAccountEmail || t("app.serviceAccountConfigured")
                  : t("app.serviceAccountNotConfigured")
              }
              readOnly
            />
            {isDesktopApp ? (
              <button type="button" onClick={importKeyFile}>
                {t("app.importJson")}
              </button>
            ) : null}
          </label>
          {!isDesktopApp && (
            <label>
              {t("app.webApiBaseUrl")}
              <input
                value={webApiBaseUrl}
                onChange={(event) => setWebApiBaseUrl(event.target.value)}
                placeholder="https://api.example.com"
              />
            </label>
          )}
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
        <article className="stats-temp-guests">
          <label className="stats-hide-toggle">
            <input
              type="checkbox"
              checked={hideTemporaryGuests}
              onChange={(event) => setHideTemporaryGuests(event.target.checked)}
            />
            <span className="stats-hide-toggle-switch" aria-hidden="true" />
            <span>{t("app.hideShort")}</span>
          </label>
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

                {selectedPerson.eventManagerId && (
                  <>
                    <dt>{t("app.detailEventManagerId")}</dt>
                    <dd>{selectedPerson.eventManagerId}</dd>
                  </>
                )}

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

              {selectedPerson.sheetColumns && Object.keys(selectedPerson.sheetColumns).length > 0 && (
                <div className="detail-spreadsheet-columns">
                  <h3>{t("app.detailSpreadsheetColumnsTitle")}</h3>
                  <p className="detail-spreadsheet-columns-hint">{t("app.detailSpreadsheetColumnsHint")}</p>
                  <dl>
                    {Object.keys(selectedPerson.sheetColumns)
                      .sort()
                      .map((letter) => (
                        <Fragment key={letter}>
                          <dt>{t("app.detailColumnLetter", { letter })}</dt>
                          <dd>{selectedPerson.sheetColumns?.[letter]}</dd>
                        </Fragment>
                      ))}
                  </dl>
                </div>
              )}
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
      {isDesktopApp && updateStatus?.mandatory && updateStatus.updateAvailable && (
        <div className="update-blocking-overlay">
          <section className="update-blocking-modal">
            <h2 style={{ marginTop: 0 }}>{t("app.updateMandatoryTitle")}</h2>
            <p className="hint">
              {t("app.updateBody", {
                current: updateStatus.currentVersion,
                latest: updateStatus.latestVersion ?? "?",
              })}
            </p>
            {updateStatus.notes ? <p className="hint">{updateStatus.notes}</p> : null}
            <div className="topbar-actions">
              <button
                type="button"
                className="primary"
                onClick={() => void window.electronAPI?.updaterOpenUpdatePage?.()}
              >
                {t("app.updateNow")}
              </button>
              <button type="button" onClick={() => void window.electronAPI?.appQuit?.()}>
                {t("app.quitApp")}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
