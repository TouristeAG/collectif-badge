import { useTranslation } from "react-i18next";

const GOOGLE_CLOUD_CONSOLE = "https://console.cloud.google.com/";

const STEP_COUNT = 7;

function GoogleSheetsHelpSteps() {
  const { t } = useTranslation();
  return (
    <ol className="settings-steps-list">
      {Array.from({ length: STEP_COUNT }, (_, i) => i + 1).map((n) => (
        <li key={n}>
          <strong className="sheets-help-step-title">{t(`sheetsHelp.step${n}Title`)}</strong>{" "}
          <span className="sheets-help-step-desc">{t(`sheetsHelp.step${n}Desc`)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Shared copy for the main-window modal and the settings panel. */
export function GoogleSheetsHelpPanel() {
  const { t } = useTranslation();
  return (
    <div className="sheets-help-panel">
      <p className="hint sheets-help-intro">{t("sheetsHelp.intro")}</p>
      <p className="sheets-help-console-wrap">
        <a
          className="sheets-help-console-link"
          href={GOOGLE_CLOUD_CONSOLE}
          target="_blank"
          rel="noreferrer"
        >
          {t("sheetsHelp.openConsole")}
        </a>
      </p>
      <GoogleSheetsHelpSteps />
    </div>
  );
}

interface GoogleSheetsHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function GoogleSheetsHelpModal({ isOpen, onClose }: GoogleSheetsHelpModalProps) {
  const { t } = useTranslation();
  if (!isOpen) return null;
  return (
    <div className="settings-modal-backdrop" onClick={onClose} role="presentation">
      <section
        className="settings-modal-window sheets-help-modal-window"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-modal-header">
          <div>
            <h2>{t("sheetsHelp.title")}</h2>
            <p className="hint">{t("sheetsHelp.modalSubtitle")}</p>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </header>
        <div className="settings-modal-body">
          <GoogleSheetsHelpPanel />
        </div>
      </section>
    </div>
  );
}
