import type { Connection } from "../types/app";

interface ConnectionTabsProps {
  connections: Connection[];
  onAddConnection: () => void;
  onEditConnection: (connection: Connection) => void;
  onDeleteConnection: (connection: Connection) => void;
  onSelectTab: (connection: Connection) => void;
  onImportConnections: () => void;
  onExportConnections: () => void;
}

export function ConnectionTabs({
  connections,
  onAddConnection,
  onEditConnection,
  onDeleteConnection,
  onSelectTab,
  onImportConnections,
  onExportConnections,
}: ConnectionTabsProps) {
  return (
    <div className="connection-tabs">
      {connections.map((connection) => (
        <div className="tab-container" key={connection.id}>
          <div className="tab-actions">
            <button className="edit-tab" onClick={() => onEditConnection(connection)} type="button">Edit</button>
            <button className="delete-tab" onClick={() => onDeleteConnection(connection)} type="button">X</button>
          </div>
          <button className={`tab ${connection.active ? "active" : ""}`} onClick={() => onSelectTab(connection)} type="button">{connection.name}</button>
        </div>
      ))}
      <button className="add-tab" onClick={onAddConnection} type="button">+</button>
      <div className="import-export-buttons">
        <button className="import-button" onClick={onImportConnections} type="button">Import</button>
        <button className="export-button" onClick={onExportConnections} type="button">Export</button>
      </div>
    </div>
  );
}
