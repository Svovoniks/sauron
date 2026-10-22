import { useState } from "react";
import { defaultPort, type ConnectionDraft, type DbType, type SslMode } from "../types/app";
import { EyeIcon, EyeOffIcon } from "./icons";
import { Modal } from "./Modal";

interface ConnectionModalProps {
  initial: ConnectionDraft;
  isEditing: boolean;
  /** Whether a password is already stored in the keychain for this connection (null = unknown). */
  hasSavedPassword: boolean | null;
  onClose: () => void;
  onSave: (draft: ConnectionDraft) => void;
  /** Reads the saved password from the keychain (for the eye icon). */
  loadSavedPassword: () => Promise<string | null>;
}

const SSL_OPTIONS: Record<DbType, { value: SslMode; label: string }[]> = {
  postgres: [
    { value: "disable", label: "Off (no encryption)" },
    { value: "prefer", label: "Prefer (encrypt if the server supports it)" },
    { value: "require", label: "Require (encrypted, certificate not checked)" },
    { value: "verify", label: "Verify (encrypted, certificate checked)" },
  ],
  clickhouse: [
    { value: "disable", label: "Off (http)" },
    { value: "require", label: "https (certificate not checked)" },
    { value: "verify", label: "https (certificate checked)" },
  ],
};

function validate(draft: ConnectionDraft): string | null {
  if (!draft.host.trim()) return "Host is required.";
  const port = Number(draft.port);
  if (!/^\d+$/.test(draft.port.trim()) || port < 1 || port > 65535) return "Port must be a number from 1 to 65535.";
  if (!Number.isInteger(draft.timeout_secs) || draft.timeout_secs < 0) return "Timeout must be 0 or a positive number.";
  return null;
}

export function ConnectionModal({ initial, isEditing, hasSavedPassword, onClose, onSave, loadSavedPassword }: ConnectionModalProps) {
  const [draft, setDraft] = useState<ConnectionDraft>(initial);
  const [showPassword, setShowPassword] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const patch = (changes: Partial<ConnectionDraft>) => setDraft((current) => ({ ...current, ...changes }));

  const changeDbType = (dbType: DbType) => {
    if (dbType === draft.db_type) return;
    patch({
      db_type: dbType,
      // keep a custom port, but follow the default of the new database type
      port: draft.port.trim() === "" || draft.port === defaultPort(draft.db_type) ? defaultPort(dbType) : draft.port,
      ssl_mode: SSL_OPTIONS[dbType].some((option) => option.value === draft.ssl_mode) ? draft.ssl_mode : "require",
    });
  };

  const error = validate(draft);

  return (
    <Modal onClose={onClose} title={isEditing ? "Edit Connection" : "New Connection"}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!error) onSave({ ...draft, host: draft.host.trim(), port: draft.port.trim() });
        }}
      >
        <div className="form-group">
          <label id="db-type-label">Database Type</label>
          <div
            aria-labelledby="db-type-label"
            className={`db-type-switch ${draft.db_type === "clickhouse" ? "clickhouse" : ""}`}
            role="group"
          >
            <button
              aria-pressed={draft.db_type === "postgres"}
              className={draft.db_type === "postgres" ? "active" : ""}
              onClick={() => changeDbType("postgres")}
              type="button"
            >
              Postgres
            </button>
            <button
              aria-pressed={draft.db_type === "clickhouse"}
              className={draft.db_type === "clickhouse" ? "active" : ""}
              onClick={() => changeDbType("clickhouse")}
              type="button"
            >
              ClickHouse
            </button>
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="connection-name">Connection Name</label>
          <input
            autoCorrect="off"
            id="connection-name"
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="stage"
            type="text"
            value={draft.name}
          />
        </div>
        <div className="host-port-group">
          <div className="form-group">
            <label htmlFor="host">Host</label>
            <input
              autoCorrect="off"
              id="host"
              onChange={(event) => patch({ host: event.target.value })}
              placeholder="localhost"
              type="text"
              value={draft.host}
            />
          </div>
          <div className="form-group">
            <label htmlFor="port">Port</label>
            <input
              autoCorrect="off"
              id="port"
              inputMode="numeric"
              onChange={(event) => patch({ port: event.target.value })}
              placeholder={defaultPort(draft.db_type)}
              type="text"
              value={draft.port}
            />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="database">Database</label>
          <input
            autoCorrect="off"
            id="database"
            onChange={(event) => patch({ database: event.target.value })}
            placeholder={draft.db_type === "postgres" ? "postgres" : "default"}
            type="text"
            value={draft.database}
          />
        </div>
        <div className="form-group">
          <label htmlFor="username">Username</label>
          <input
            autoCorrect="off"
            id="username"
            onChange={(event) => patch({ username: event.target.value })}
            placeholder="user"
            type="text"
            value={draft.username}
          />
        </div>
        <div className="form-group">
          <label htmlFor="password">Password</label>
          <div className="password-input-container">
            <input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              id="password"
              onChange={(event) => patch({ password: event.target.value })}
              placeholder={isEditing && hasSavedPassword ? "Saved in the keychain - click the eye to show it" : ""}
              type={showPassword ? "text" : "password"}
              value={draft.password}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="password-toggle"
              onClick={async () => {
                // Editing with an untouched empty field: reveal means "show me the saved password".
                if (!showPassword && isEditing && hasSavedPassword && draft.password === "") {
                  try {
                    const saved = await loadSavedPassword();
                    if (saved) patch({ password: saved });
                    setPasswordError(null);
                  } catch (error) {
                    setPasswordError(error instanceof Error ? error.message : String(error));
                  }
                }
                setShowPassword((value) => !value);
              }}
              title={showPassword ? "Hide password" : "Show password"}
              type="button"
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>
        {passwordError ? (
          <p className="form-error" role="alert">
            {passwordError}
          </p>
        ) : null}
        <div className="form-group">
          <label htmlFor="ssl-mode">Encryption (TLS)</label>
          <select
            id="ssl-mode"
            onChange={(event) => patch({ ssl_mode: event.target.value as SslMode })}
            value={draft.ssl_mode}
          >
            {SSL_OPTIONS[draft.db_type].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="host-port-group settings-row">
          <div className="form-group">
            <label htmlFor="timeout">Timeout (seconds)</label>
            <input
              id="timeout"
              inputMode="numeric"
              min={0}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                patch({ timeout_secs: Number.isNaN(parsed) ? 0 : Math.max(0, parsed) });
              }}
              type="text"
              value={String(draft.timeout_secs)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="read-only">Access</label>
            <label className="toggle-field" htmlFor="read-only">
              <input
                checked={draft.read_only}
                className="toggle-input"
                id="read-only"
                onChange={(event) => patch({ read_only: event.target.checked })}
                type="checkbox"
              />
              <span aria-hidden="true" className="toggle-track" />
              <span>Read-only</span>
            </label>
          </div>
        </div>
        <p className="field-hint">
          Read-only blocks INSERT / UPDATE / DELETE / DDL on this connection. The timeout stops queries that run too long (0 = no limit).
        </p>
        {submitted && error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-buttons">
          <button className="button cancel-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="button save-button" type="submit">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
