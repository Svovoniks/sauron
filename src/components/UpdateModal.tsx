import type { UpdateState } from "../hooks/useUpdater";
import { Modal } from "./Modal";

interface UpdateModalProps {
  state: UpdateState;
  onInstall: () => void;
  onRestart: () => void;
  onLater: () => void;
  onSkip: (version: string) => void;
}

/** Offers a found update, shows the download, and asks for the restart. */
export function UpdateModal({ state, onInstall, onRestart, onLater, onSkip }: UpdateModalProps) {
  if (state.kind === "idle" || state.kind === "checking" || state.kind === "uptodate") return null;
  const info = "info" in state ? state.info : undefined;
  const working = state.kind === "downloading" || state.kind === "installing";

  return (
    <Modal className="update-modal" onClose={working ? () => undefined : onLater} title={state.kind === "ready" ? "Update installed" : state.kind === "error" ? "Update failed" : "Update available"}>
      <div className="modal-form">
        {info ? (
          <p className="modal-message">
            Sauron <b>{info.version}</b> is available (you have {info.current_version}).
          </p>
        ) : null}
        {state.kind === "available" && info?.notes ? <pre className="update-notes">{info.notes}</pre> : null}
        {state.kind === "downloading" ? (
          <div aria-live="polite">
            <div className="update-bar" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={state.fraction === null ? undefined : Math.round(state.fraction * 100)}>
              <i className={state.fraction === null ? "indeterminate" : ""} style={state.fraction === null ? undefined : { width: `${Math.round(state.fraction * 100)}%` }} />
            </div>
            <p className="field-hint">Downloading… {state.fraction === null ? "" : `${Math.round(state.fraction * 100)}%`}</p>
          </div>
        ) : null}
        {state.kind === "installing" ? <p className="field-hint">Installing…</p> : null}
        {state.kind === "ready" ? <p className="modal-message">The new version is installed. Restart Sauron to start using it; your tabs come back as you left them.</p> : null}
        {state.kind === "error" ? (
          <p className="form-error" role="alert">
            {state.message}
          </p>
        ) : null}

        <div className="modal-buttons">
          {state.kind === "available" && info ? (
            <>
              <button className="button cancel-button" onClick={() => onSkip(info.version)} type="button">
                Skip this version
              </button>
              <button className="button cancel-button" onClick={onLater} type="button">
                Later
              </button>
              <button className="button save-button" onClick={onInstall} type="button">
                Download &amp; install
              </button>
            </>
          ) : null}
          {state.kind === "ready" ? (
            <>
              <button className="button cancel-button" onClick={onLater} type="button">
                Later
              </button>
              <button className="button save-button" onClick={onRestart} type="button">
                Restart now
              </button>
            </>
          ) : null}
          {state.kind === "error" ? (
            <>
              <button className="button cancel-button" onClick={onLater} type="button">
                Close
              </button>
              {info ? (
                <button className="button save-button" onClick={onInstall} type="button">
                  Try again
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
