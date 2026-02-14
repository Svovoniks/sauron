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
            <button className="password-toggle" onClick={onTogglePassword} type="button">
              {showPassword ? "Hide" : "Show"}
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
