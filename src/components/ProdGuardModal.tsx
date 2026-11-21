import { useState } from "react";
import { Modal } from "./Modal";
import { ShieldIcon, WarningIcon } from "./icons";

interface ProdGuardModalProps {
  connectionName: string;
  host: string;
  /** The statements that change data. */
  statements: string[];
  onConfirm: () => void;
  onClose: () => void;
  /** A Kafka message instead of SQL statements. */
  kafka?: boolean;
}

/** Typed confirmation before writing to a production connection. */
export function ProdGuardModal({ connectionName, host, statements, onConfirm, onClose, kafka = false }: ProdGuardModalProps) {
  const word = connectionName.trim() || "prod";
  const [typed, setTyped] = useState("");
  const shown = statements.slice(0, 3);

  return (
    <Modal className="guard-modal" onClose={onClose} title={kafka ? "Send to production?" : "Write to production?"}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed === word) onConfirm();
        }}
      >
        <div className="guard-warn">
          <WarningIcon className="guard-icon" />
          {kafka ? (
            <span>
              This message is sent to <b>{connectionName || host}</b> <span className="muted">({host})</span>, and every consumer of the topic gets it. Kafka can’t delete a single message, so it can’t be undone.
            </span>
          ) : (
            <span>
              {statements.length === 1 ? "This statement changes" : `These ${statements.length} statements change`} data on <b>{connectionName || host}</b> <span className="muted">({host})</span>. It can’t be undone from Sauron.
            </span>
          )}
        </div>
        <pre className="guard-sql">
          {shown.join("\n\n")}
          {statements.length > shown.length ? `\n\n… and ${statements.length - shown.length} more` : ""}
        </pre>
        <label className="guard-label" htmlFor="guard-input">
          Type <b className="mono">{word}</b> to confirm
        </label>
        <input autoComplete="off" id="guard-input" onChange={(event) => setTyped(event.target.value)} spellCheck={false} value={typed} />
        <div className="modal-buttons">
          <button className="button cancel-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="button delete-button" disabled={typed !== word} type="submit">
            <ShieldIcon size={14} />
            {kafka ? "Send on production" : "Run on production"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
