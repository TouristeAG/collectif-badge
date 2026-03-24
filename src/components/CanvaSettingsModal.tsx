import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import i18n, { LANGUAGE_STORAGE_KEY } from "../i18n/config";
import { GoogleSheetsHelpPanel } from "./GoogleSheetsHelp";

/** Must match `electron/canva.cjs` — add this exact URL in the Canva Developer Portal. */
export const CANVA_REDIRECT_URI_DOC =
  "http://127.0.0.1:32887/canva/oauth/callback";

interface CanvaStatus {
  hasCredentials: boolean;
  connected: boolean;
  hasBrandTemplate: boolean;
  brandTemplateId: string | null;
}

interface CanvaSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CanvaSettingsModal({ isOpen, onClose }: CanvaSettingsModalProps) {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [brandTemplateId, setBrandTemplateId] = useState("");
  const [status, setStatus] = useState<CanvaStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [language, setLanguage] = useState<"fr" | "en">(() =>
    (localStorage.getItem("app.language") as "fr" | "en" | null) === "en" ? "en" : "fr"
  );

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.canvaGetStatus) {
      setStatus(null);
      return;
    }
    try {
      const s = await api.canvaGetStatus();
      setStatus(s);
      setBrandTemplateId(s.brandTemplateId ?? "");
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setLanguage(i18n.language.startsWith("en") ? "en" : "fr");
      void refresh();
      setMessage("");
    }
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const api = window.electronAPI;

  function handleLanguageChange(lng: "fr" | "en") {
    setLanguage(lng);
    void i18n.changeLanguage(lng);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  }

  async function handleSaveCredentials() {
    setMessage("");
    if (!api?.canvaSaveCredentials) {
      setMessage(t("canva.msgNoApi"));
      return;
    }
    setBusy(true);
    try {
      await api.canvaSaveCredentials({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        brandTemplateId: brandTemplateId.trim(),
      });
      setClientSecret("");
      setMessage(t("canva.msgCredentialsSaved"));
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("canva.msgSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect() {
    setMessage("");
    if (!api?.canvaLogin) {
      setMessage(t("canva.msgNoApi"));
      return;
    }
    setBusy(true);
    try {
      await api.canvaLogin();
      setMessage(t("canva.msgSignedIn"));
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("canva.msgLoginFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setMessage("");
    if (!api?.canvaLogout) return;
    setBusy(true);
    try {
      await api.canvaLogout();
      setMessage(t("canva.msgDisconnected"));
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("canva.msgDisconnectFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckUpdates() {
    setMessage("");
    if (!api?.updaterCheckNow) {
      setMessage(t("settings.updatesUnavailable"));
      return;
    }
    setBusy(true);
    try {
      const status = await api.updaterCheckNow();
      if (status.error) {
        setMessage(status.error);
      } else if (status.updateAvailable) {
        setMessage(
          t("settings.updateFound", {
            current: status.currentVersion,
            latest: status.latestVersion ?? "?",
          })
        );
      } else {
        setMessage(t("settings.upToDate", { version: status.currentVersion }));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settings.updateCheckFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-modal-backdrop" onClick={onClose} role="presentation">
      <section className="settings-modal-window" onClick={(e) => e.stopPropagation()}>
        <header className="settings-modal-header">
          <div>
            <h2>{t("settings.title")}</h2>
            <p className="hint">{t("settings.modalIntro")}</p>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </header>

        <div className="settings-modal-body">
          <div className="settings-section">
            <h3>{t("settings.languageSection")}</h3>
            <label>
              {t("settings.languageLabel")}
              <select
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value as "fr" | "en")}
                aria-label={t("settings.languageLabel")}
              >
                <option value="fr">{t("settings.languageFr")}</option>
                <option value="en">{t("settings.languageEn")}</option>
              </select>
            </label>
          </div>

          <div className="settings-section">
            <h3>{t("settings.updatesSection")}</h3>
            <p className="hint">{t("settings.updatesIntro")}</p>
            <button type="button" className="primary" onClick={() => void handleCheckUpdates()} disabled={busy}>
              {busy ? t("settings.checkingUpdates") : t("settings.checkUpdates")}
            </button>
          </div>

          <div className="settings-section settings-section--intro">
            <h3>{t("settings.sheetsHelpSection")}</h3>
            <GoogleSheetsHelpPanel />
          </div>

          <aside className="settings-callout" role="note">
            <strong>{t("canva.mfaTitle")}</strong>
            <p>{t("canva.mfaBody")}</p>
          </aside>

          <div className="settings-section">
            <h3>{t("canva.sectionTitle")}</h3>
            <p className="hint" style={{ marginBottom: "0.75rem" }}>
              {t("canva.headerHint")}
            </p>
            <h4 className="settings-subsection-title" style={{ marginTop: "0.5rem", marginBottom: "0.35rem" }}>
              {t("canva.step1Title")}
            </h4>
            <ol className="settings-steps-list">
              <li>
                <Trans
                  i18nKey="canva.step1Li1"
                  components={{
                    link: <a href="https://www.canva.com/developers/" target="_blank" rel="noreferrer" />,
                  }}
                />
              </li>
              <li>
                <Trans
                  i18nKey="canva.step1Li2"
                  components={{
                    ca: (
                      <a
                        href="https://www.canva.com/developers/integrations/connect-api"
                        target="_blank"
                        rel="noreferrer"
                      />
                    ),
                  }}
                />
              </li>
            </ol>
            <p className="hint" style={{ margin: "0.5rem 0" }}>
              {t("canva.step1Li3Prefix")}
            </p>
            <pre className="redirect-uri-box">{CANVA_REDIRECT_URI_DOC}</pre>
            <p className="hint">{t("canva.step1PortHint")}</p>
            <ol className="settings-steps-list" start={3}>
              <li>{t("canva.step1Li4")}</li>
              <li>{t("canva.step1Li5")}</li>
            </ol>
            <p className="hint">{t("canva.step1AltHint")}</p>
            <p className="hint">
              <Trans
                i18nKey="canva.step1AutofillHint"
                components={{
                  link: (
                    <a
                      href="https://www.canva.dev/docs/connect/autofill-guide/"
                      target="_blank"
                      rel="noreferrer"
                    />
                  ),
                }}
              />
            </p>
          </div>

          <div className="settings-section">
            <h3>{t("canva.step2Title")}</h3>
            <ol className="settings-steps-list">
              <li>{t("canva.step2Li1")}</li>
              <li>{t("canva.step2Li2")}</li>
              <li>{t("canva.step2Li3")}</li>
            </ol>
            <label>
              {t("canva.labelClientId")}
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={t("canva.placeholderClientId")}
                autoComplete="off"
              />
            </label>
            <label>
              {t("canva.labelClientSecret")}
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={status?.hasCredentials ? t("canva.placeholderSecretKeep") : t("canva.placeholderSecretNew")}
                autoComplete="off"
              />
            </label>
            <label>
              {t("canva.labelBrandTemplate")}
              <input
                value={brandTemplateId}
                onChange={(e) => setBrandTemplateId(e.target.value)}
                placeholder={t("canva.placeholderBrandTemplate")}
                autoComplete="off"
              />
            </label>
            <p className="hint">{t("canva.brandTemplateHint")}</p>
            <button type="button" className="primary" onClick={() => void handleSaveCredentials()} disabled={busy}>
              {t("canva.saveCredentials")}
            </button>
          </div>

          <div className="settings-section">
            <h3>{t("canva.step3Title")}</h3>
            <p className="hint">
              {t("canva.statusPrefix")}{" "}
              {status == null ? (
                t("canva.statusEllipsis")
              ) : (
                <>
                  {status.connected ? (
                    <strong style={{ color: "#86efac" }}>{t("canva.statusConnected")}</strong>
                  ) : (
                    <strong style={{ color: "#fca5a5" }}>{t("canva.statusNotConnected")}</strong>
                  )}
                  {status.hasCredentials ? t("canva.statusCredentialsOk") : t("canva.statusCredentialsMissing")}
                  {status.hasBrandTemplate ? t("canva.statusBrandYes") : t("canva.statusBrandNo")}
                </>
              )}
            </p>
            <ol className="settings-steps-list">
              <li>{t("canva.step3Li1")}</li>
              <li>{t("canva.step3Li2")}</li>
              <li>{t("canva.step3Li3")}</li>
            </ol>
            <div className="settings-modal-actions">
              <button type="button" className="primary" onClick={() => void handleConnect()} disabled={busy}>
                {busy ? t("canva.working") : t("canva.connectBrowser")}
              </button>
              <button type="button" onClick={() => void handleDisconnect()} disabled={busy || !status?.connected}>
                {t("canva.disconnect")}
              </button>
            </div>
            <p className="hint">{t("canva.disconnectHint")}</p>
          </div>

          <div className="settings-section">
            <h3>{t("settings.hostingSection")}</h3>
            <p className="hint">{t("settings.hostingIntro")}</p>
            <ol className="settings-steps-list">
              <li>{t("settings.hostingStep1")}</li>
              <li>{t("settings.hostingStep2")}</li>
              <li>{t("settings.hostingStep3")}</li>
              <li>{t("settings.hostingStep4")}</li>
            </ol>
            <p className="hint">{t("settings.hostingCmdExport")}</p>
            <pre className="redirect-uri-box">{t("settings.hostingCmdExportValue")}</pre>
            <p className="hint">{t("settings.hostingCmdApi")}</p>
            <pre className="redirect-uri-box">{t("settings.hostingCmdApiValue")}</pre>
            <p className="hint">{t("settings.hostingCmdWeb")}</p>
            <pre className="redirect-uri-box">{t("settings.hostingCmdWebValue")}</pre>
            <p className="hint">{t("settings.hostingCmdIp")}</p>
            <pre className="redirect-uri-box">{t("settings.hostingCmdIpValue")}</pre>
            <p className="hint">{t("settings.hostingOutro")}</p>
          </div>

          <div className="settings-section">
            <h3>{t("settings.networkShareFixSection")}</h3>
            <p className="hint">{t("settings.networkShareFixIntro")}</p>
            <ol className="settings-steps-list">
              <li>{t("settings.networkShareFixStep1")}</li>
              <li>{t("settings.networkShareFixStep2")}</li>
              <li>{t("settings.networkShareFixStep3")}</li>
            </ol>
            <p className="hint">{t("settings.networkShareFixCmdRun")}</p>
            <pre className="redirect-uri-box">{t("settings.networkShareFixCmdRunValue")}</pre>
            <p className="hint">{t("settings.networkShareFixCmdVerify")}</p>
            <pre className="redirect-uri-box">{t("settings.networkShareFixCmdVerifyValue")}</pre>
            <p className="hint">{t("settings.networkShareFixOutro")}</p>
          </div>

          {message && <p className="settings-modal-message">{message}</p>}
        </div>
      </section>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function CanvaSettingsButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="icon-button"
      onClick={onClick}
      title={t("canva.gearTitle")}
      aria-label={t("canva.gearAria")}
    >
      <GearIcon />
    </button>
  );
}
