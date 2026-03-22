import { useCallback, useEffect, useState } from "react";

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
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [brandTemplateId, setBrandTemplateId] = useState("");
  const [status, setStatus] = useState<CanvaStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

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
      void refresh();
      setMessage("");
    }
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const api = window.electronAPI;

  async function handleSaveCredentials() {
    setMessage("");
    if (!api?.canvaSaveCredentials) {
      setMessage("Desktop API unavailable. Run with Electron (`npm run dev`).");
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
      setMessage("API credentials saved locally.");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save credentials.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect() {
    setMessage("");
    if (!api?.canvaLogin) {
      setMessage("Desktop API unavailable.");
      return;
    }
    setBusy(true);
    try {
      await api.canvaLogin();
      setMessage("Signed in to Canva.");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Canva login failed.");
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
      setMessage("Disconnected from Canva (API keys kept).");
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-modal-backdrop" onClick={onClose} role="presentation">
      <section className="settings-modal-window" onClick={(e) => e.stopPropagation()}>
        <header className="settings-modal-header">
          <div>
            <h2>Canva</h2>
            <p className="hint">
              Connect API (OAuth). Your client secret stays only in this desktop app — it is never sent to the web UI
              bundle.
            </p>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings-modal-body">
          <div className="settings-section settings-section--intro">
            <h3>How to open this panel</h3>
            <ol className="settings-steps-list">
              <li>
                In the main window <strong>header</strong>, look for the <strong>gear icon</strong> to the{" "}
                <strong>left</strong> of the blue <strong>Refresh from Sheets</strong> button.
              </li>
              <li>Click the gear — this Canva settings window opens.</li>
              <li>
                After setup below, use <strong>Badge illustrator → Export badge → Send to Canva</strong>. With a{" "}
                <strong>brand template ID</strong>, you get editable layers; without it, the app imports a{" "}
                <strong>2‑page PDF</strong> (flattened badge) like before.
              </li>
            </ol>
          </div>

          <aside className="settings-callout" role="note">
            <strong>MFA (two-factor authentication)</strong>
            <p>
              If you don’t see MFA options in your Canva account settings, try resetting your password in Canva’s
              account settings — after that, MFA controls often become visible so you can finish securing your account
              for API / developer use.
            </p>
          </aside>

          <div className="settings-section">
            <h3>1. Create the integration (Canva Developer Portal)</h3>
            <ol className="settings-steps-list">
              <li>
                Sign in at{" "}
                <a href="https://www.canva.com/developers/" target="_blank" rel="noreferrer">
                  canva.com/developers
                </a>
                .
              </li>
              <li>
                Create a new integration and choose the <strong>Connect API</strong> type (or open{" "}
                <a
                  href="https://www.canva.com/developers/integrations/connect-api"
                  target="_blank"
                  rel="noreferrer"
                >
                  Connect API docs
                </a>
                ).
              </li>
              <li>
                In the integration’s <strong>Authentication</strong> (or similar) section, add this{" "}
                <strong>redirect URL</strong> exactly — copy/paste with no extra spaces:
              </li>
            </ol>
            <pre className="redirect-uri-box">{CANVA_REDIRECT_URI_DOC}</pre>
            <p className="hint">
              This app listens on <strong>127.0.0.1 port 32887</strong> only during “Connect to Canva”. Keep this port
              free or the login step will fail.
            </p>
            <ol className="settings-steps-list" start={4}>
              <li>
                Under <strong>Scopes</strong>, enable at least: <code>design:content:write</code>,{" "}
                <code>design:meta:read</code>, <code>brandtemplate:meta:read</code>,{" "}
                <code>brandtemplate:content:read</code>, <code>asset:read</code>, <code>asset:write</code>. Save the
                integration.
              </li>
              <li>
                Copy the integration’s <strong>Client ID</strong> and <strong>Client secret</strong> (starts with{" "}
                <code>cnvca</code>) — you’ll paste them in step 2 below.
              </li>
            </ol>
            <p className="hint">
              <strong>Alternative:</strong> set environment variables <code>CANVA_CLIENT_ID</code> and{" "}
              <code>CANVA_CLIENT_SECRET</code> when launching the app (no need to use the fields below). After changing
              scopes, use <strong>Disconnect</strong> then <strong>Connect to Canva</strong> again so the new scopes are
              granted.
            </p>
            <p className="hint">
              Autofill requires a <strong>Canva Enterprise</strong> org (or developer access approved by Canva). See{" "}
              <a href="https://www.canva.dev/docs/connect/autofill-guide/" target="_blank" rel="noreferrer">
                Autofill guide
              </a>
              .
            </p>
          </div>

          <div className="settings-section">
            <h3>2. Save API credentials in this app</h3>
            <ol className="settings-steps-list">
              <li>Paste <strong>Client ID</strong> and <strong>Client secret</strong> from the portal.</li>
              <li>
                Click <strong>Save credentials locally</strong>. They are stored in your app profile folder on disk.
              </li>
              <li>
                To update only the Client ID later, paste the new ID and leave the secret blank, then save (the saved
                secret is kept).
              </li>
            </ol>
            <label>
              Client ID
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="From Canva Developer Portal"
                autoComplete="off"
              />
            </label>
            <label>
              Client secret
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={status?.hasCredentials ? "Leave blank to keep saved secret" : "cnvca…"}
                autoComplete="off"
              />
            </label>
            <label>
              Brand template ID (Autofill)
              <input
                value={brandTemplateId}
                onChange={(e) => setBrandTemplateId(e.target.value)}
                placeholder="e.g. AEN3TrQftXo — from your published brand template URL"
                autoComplete="off"
              />
            </label>
            <p className="hint">
              Create a <strong>brand template</strong> with the Data autofill app using field names from{" "}
              <code>docs/CANVA_BRAND_TEMPLATE.md</code>. Optional env: <code>CANVA_BRAND_TEMPLATE_ID</code>. You can
              save this field alone if API keys are set via environment variables.
            </p>
            <button type="button" className="primary" onClick={() => void handleSaveCredentials()} disabled={busy}>
              Save credentials &amp; template ID
            </button>
          </div>

          <div className="settings-section">
            <h3>3. Sign in to Canva (OAuth)</h3>
            <p className="hint">
              Status:{" "}
              {status == null ? (
                "…"
              ) : (
                <>
                  {status.connected ? (
                    <strong style={{ color: "#86efac" }}>Connected to Canva</strong>
                  ) : (
                    <strong style={{ color: "#fca5a5" }}>Not connected</strong>
                  )}
                  {status.hasCredentials ? " · credentials on file" : " · add credentials in step 2 first"}
                  {status.hasBrandTemplate ? (
                    <span> · brand template ID set (editable Autofill)</span>
                  ) : (
                    <span> · no template ID — Send to Canva uses PDF import (flattened)</span>
                  )}
                </>
              )}
            </p>
            <ol className="settings-steps-list">
              <li>
                Click <strong>Connect to Canva (browser)</strong>. Your default browser opens Canva’s consent screen.
              </li>
              <li>Approve access for this integration. You’ll be redirected to a small local page saying “Connected”.</li>
              <li>Return to this app — status should show <strong>Connected to Canva</strong>.</li>
            </ol>
            <div className="settings-modal-actions">
              <button type="button" className="primary" onClick={() => void handleConnect()} disabled={busy}>
                {busy ? "Working…" : "Connect to Canva (browser)"}
              </button>
              <button type="button" onClick={() => void handleDisconnect()} disabled={busy || !status?.connected}>
                Disconnect
              </button>
            </div>
            <p className="hint">
              <strong>Disconnect</strong> removes saved login tokens from this app only; your Client ID / secret in step
              2 are kept until you overwrite them.
            </p>
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
  return (
    <button
      type="button"
      className="icon-button"
      onClick={onClick}
      title="Canva Connect settings"
      aria-label="Canva Connect settings"
    >
      <GearIcon />
    </button>
  );
}
