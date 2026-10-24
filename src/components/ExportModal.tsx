import { Modal } from "./Modal";

interface ExportModalProps {
  connectionCount: number;
  onClose: () => void;
  onExport: (includePasswords: boolean) => void;
  /** Settings → Data & privacy: passwords are the default choice. */
  passwordsByDefault?: boolean;
}

export function ExportModal({ connectionCount, onClose, onExport, passwordsByDefault = false }: ExportModalProps) {
  return (
    <Modal onClose={onClose} title="Export">
      <div className="modal-form">
        <p className="modal-message">
          Export connections, saved queries and saved results to a JSON file. Passwords are left out;
          include them only if you need to move the connections to another machine.
        </p>
        {connectionCount > 0 && (
          <p className="field-hint">
            With passwords, the file contains them as <b>plain text</b>: anyone who can read the file can use them.
          </p>
        )}
        <div className="modal-buttons">
          <button className="button cancel-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className={`button ${passwordsByDefault && connectionCount > 0 ? "cancel-button" : "save-button"}`} onClick={() => onExport(false)} type="button">
            Without passwords
          </button>
          {connectionCount > 0 && (
            <button className="button delete-button" onClick={() => onExport(true)} type="button">
              Include passwords
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
