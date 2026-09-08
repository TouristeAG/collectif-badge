import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import jsQR from "jsqr";
import type { FirebaseStatus } from "../types";

type Props = {
  status: FirebaseStatus | null;
  busy: boolean;
  onSaveJoinCode: (raw: string) => Promise<void>;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onClear: () => Promise<void>;
  onOpenHelp: () => void;
  /** When true, omit the card title (parent already shows sync setup header). */
  embedded?: boolean;
};

export function FirebaseBackendPanel({
  status,
  busy,
  onSaveJoinCode,
  onSignIn,
  onSignOut,
  onClear,
  onOpenHelp,
  embedded = false
}: Props) {
  const { t } = useTranslation();
  const [joinInput, setJoinInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanSaved, setScanSaved] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopScan = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  }, []);

  useEffect(() => () => stopScan(), [stopScan]);

  const handleDecoded = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed.startsWith("noctulist-fb:")) return;
      stopScan();
      // Never surface the join payload in the UI after a QR scan.
      setJoinInput("");
      setScanError("");
      setScanSaved(false);
      try {
        await onSaveJoinCode(trimmed);
        setScanSaved(true);
      } catch (e) {
        setScanError(e instanceof Error ? e.message : t("firebase.saveFailed"));
      }
    },
    [onSaveJoinCode, stopScan, t]
  );

  const startScan = useCallback(async () => {
    setScanError("");
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error(t("firebase.cameraUnavailable"));
      }
      video.srcObject = stream;
      await video.play();

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error(t("firebase.cameraUnavailable"));
      }

      const tick = () => {
        if (!streamRef.current || !videoRef.current) return;
        const v = videoRef.current;
        if (v.readyState >= 2) {
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert"
          });
          if (code?.data) {
            void handleDecoded(code.data);
            return;
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      stopScan();
      setScanError(e instanceof Error ? e.message : t("firebase.cameraUnavailable"));
    }
  }, [handleDecoded, stopScan, t]);

  async function submitPaste() {
    setScanError("");
    setScanSaved(false);
    const raw = joinInput.trim();
    try {
      await onSaveJoinCode(raw);
      setJoinInput("");
    } catch (e) {
      setScanError(e instanceof Error ? e.message : t("firebase.saveFailed"));
    }
  }

  async function handleClear() {
    setJoinInput("");
    setScanSaved(false);
    setScanError("");
    await onClear();
  }

  const configured = Boolean(status?.configured);
  const signedIn = Boolean(status?.signedIn);

  return (
    <div className={embedded ? "firebase-panel firebase-panel-embedded" : "firebase-panel"}>
      {!embedded ? (
        <div className="setup-card-header">
          <h2>{t("firebase.cardTitle")}</h2>
          <button
            type="button"
            className="icon-button setup-card-help-btn"
            onClick={onOpenHelp}
            aria-label={t("firebase.openHelpAria")}
            title={t("firebase.openHelpTitle")}
          >
            ?
          </button>
        </div>
      ) : (
        <h3 className="sync-setup-backend-title">{t("firebase.cardTitle")}</h3>
      )}
      <p className="hint">{t("firebase.intro")}</p>

      {!configured ? (
        <>
          <label>
            {t("firebase.joinCode")}
            <textarea
              value={joinInput}
              onChange={(e) => {
                setJoinInput(e.target.value);
                setScanSaved(false);
              }}
              rows={3}
              placeholder={t("firebase.joinCodePlaceholder")}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </label>

          <div className="topbar-actions" style={{ marginTop: "0.6rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="primary"
              disabled={busy || !joinInput.trim()}
              onClick={() => void submitPaste()}
            >
              {t("firebase.saveJoin")}
            </button>
            {!scanning ? (
              <button type="button" disabled={busy} onClick={() => void startScan()}>
                {t("firebase.scanQr")}
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={stopScan}>
                {t("firebase.stopScan")}
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="topbar-actions" style={{ marginTop: "0.25rem", flexWrap: "wrap" }}>
          {!scanning ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setScanSaved(false);
                void startScan();
              }}
            >
              {t("firebase.rescanQr")}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={stopScan}>
              {t("firebase.stopScan")}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void handleClear()}>
            {t("firebase.clearConfig")}
          </button>
        </div>
      )}

      {scanning ? (
        <div className="firebase-scan-wrap">
          <video ref={videoRef} className="firebase-scan-video" muted playsInline />
          <p className="hint">{t("firebase.scanHint")}</p>
        </div>
      ) : null}

      {scanSaved && !scanError ? <p className="hint">{t("firebase.qrSavedHidden")}</p> : null}
      {scanError ? <p className="error-banner">{scanError}</p> : null}

      <div className="firebase-status-block">
        <p className="hint" style={{ margin: 0 }}>
          {configured
            ? t("firebase.statusConfigured", {
                org: status?.orgId || "—",
                project: status?.projectId || "—"
              })
            : t("firebase.statusNotConfigured")}
        </p>
        <p className="hint" style={{ margin: "0.35rem 0 0" }}>
          {signedIn
            ? t("firebase.statusSignedIn", { email: status?.email || "—" })
            : t("firebase.statusSignedOut")}
        </p>
        {!status?.hasJoinSecrets && configured ? (
          <p className="hint" style={{ margin: "0.35rem 0 0" }}>
            {t("firebase.missingSecretsHint")}
          </p>
        ) : null}
      </div>

      <div className="topbar-actions" style={{ marginTop: "0.75rem" }}>
        {!signedIn ? (
          <button
            type="button"
            className="primary"
            disabled={busy || !configured}
            onClick={() => void onSignIn()}
          >
            {t("firebase.signInGoogle")}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void onSignOut()}>
            {t("firebase.signOut")}
          </button>
        )}
      </div>
    </div>
  );
}

type HelpProps = { isOpen: boolean; onClose: () => void };

export function FirebaseHelpModal({ isOpen, onClose }: HelpProps) {
  const { t } = useTranslation();
  if (!isOpen) return null;
  return (
    <div className="settings-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="settings-modal-window sheets-help-modal-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="firebase-help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-modal-header">
          <h2 id="firebase-help-title">{t("firebase.helpTitle")}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </header>
        <div className="settings-modal-body">
          <p>{t("firebase.helpIntro")}</p>
          <ol className="sheets-help-steps">
            <li>{t("firebase.helpStep1")}</li>
            <li>{t("firebase.helpStep2")}</li>
            <li>{t("firebase.helpStep3")}</li>
            <li>{t("firebase.helpStep4")}</li>
          </ol>
          <p className="hint">{t("firebase.helpRedirects")}</p>
        </div>
      </div>
    </div>
  );
}
