import type { Connection } from "../types/app";

interface ConnectionModalProps {
  show: boolean;
  editingConnection: Connection | null;
  connectionInModal: Connection;
  showPassword: boolean;
  onClose: () => void;
  onSave: () => void;
  onTogglePassword: () => void;
  onDbTypeChange: (dbType: "postgres" | "clickhouse") => void;
  onFieldChange: (field: keyof Connection, value: string) => void;
}

export function ConnectionModal({
  show,
  editingConnection,
  connectionInModal,
  showPassword,
  onClose,
  onSave,
  onTogglePassword,
  onDbTypeChange,
  onFieldChange,
}: ConnectionModalProps) {
  if (!show) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{editingConnection ? "Edit Connection" : "New Connection"}</h3>
        <div className="form-group">
          <label>Database Type</label>
          <div className={`db-type-switch ${connectionInModal.db_type === "clickhouse" ? "clickhouse" : ""}`}>
            <button className={connectionInModal.db_type === "postgres" ? "active" : ""} onClick={() => onDbTypeChange("postgres")} type="button">
              Postgres
            </button>
            <button className={connectionInModal.db_type === "clickhouse" ? "active" : ""} onClick={() => onDbTypeChange("clickhouse")} type="button">
              ClickHouse
            </button>
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="connection-name">Connection Name</label>
          <input id="connection-name" type="text" placeholder="stage" autoCorrect="off" value={connectionInModal.name} onChange={(event) => onFieldChange("name", event.target.value)} />
        </div>
        <div className="host-port-group">
          <div className="form-group">
            <label htmlFor="host">Host</label>
            <input id="host" type="text" placeholder="localhost" autoCorrect="off" value={connectionInModal.host} onChange={(event) => onFieldChange("host", event.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="port">Port</label>
            <input id="port" type="text" placeholder="5432" autoCorrect="off" value={connectionInModal.port} onChange={(event) => onFieldChange("port", event.target.value)} />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="database">Database</label>
          <input id="database" type="text" placeholder="postgres" autoCorrect="off" value={connectionInModal.database} onChange={(event) => onFieldChange("database", event.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="username">Username</label>
          <input id="username" type="text" placeholder="user" autoCorrect="off" value={connectionInModal.username} onChange={(event) => onFieldChange("username", event.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="password">Password</label>
          <div className="password-input-container">
            <input id="password" type={showPassword ? "text" : "password"} autoCorrect="off" autoCapitalize="none" value={connectionInModal.password || ""} onChange={(event) => onFieldChange("password", event.target.value)} />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="password-toggle"
              onClick={onTogglePassword}
              title={showPassword ? "Hide password" : "Show password"}
              type="button"
            >
              {showPassword ? (
                <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                  <path
                    d="M3 3 21 21M10.6 10.6a2 2 0 0 0 2.8 2.8"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                  <path
                    d="M9.9 4.2A10.9 10.9 0 0 1 12 4c5 0 9 3.8 10 8-0.4 1.7-1.4 3.2-2.7 4.4M6.1 6.1C4.3 7.6 3.2 9.7 2 12c.8 3.1 3.2 5.7 6.3 7"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                </svg>
              ) : (
                <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                  <path
                    d="M2 12c1-4.2 5-8 10-8s9 3.8 10 8c-1 4.2-5 8-10 8s-9-3.8-10-8Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                  <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div className="modal-buttons">
          <button className="button cancel-button" onClick={onClose} type="button">Cancel</button>
          <button className="button save-button" onClick={onSave} type="button">Save</button>
        </div>
      </div>
    </div>
  );
}
