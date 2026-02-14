import { useEffect, useRef, type WheelEvent } from "react";
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
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const velocityRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);

  const isConnectionInvalid = (connection: Connection) => {
    return (
      !connection.name.trim() ||
      !connection.host.trim() ||
      !connection.port.trim() ||
      !connection.database.trim() ||
      !connection.username.trim()
    );
  };

  const handleWheelScroll = (event: WheelEvent<HTMLDivElement>) => {
    const container = tabsContainerRef.current;
    if (!container) return;
    if (container.scrollWidth <= container.clientWidth) return;
    if (event.deltaY === 0) return;

    event.preventDefault();

    velocityRef.current += event.deltaY * 0.35;

    if (animationFrameRef.current !== null) return;

    const animate = () => {
      const activeContainer = tabsContainerRef.current;
      if (!activeContainer) {
        animationFrameRef.current = null;
        return;
      }

      activeContainer.scrollLeft += velocityRef.current;
      velocityRef.current *= 0.82;

      if (Math.abs(velocityRef.current) < 0.2) {
        velocityRef.current = 0;
        animationFrameRef.current = null;
        return;
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return (
    <div className="connection-tabs" onWheel={handleWheelScroll} ref={tabsContainerRef}>
      {connections.map((connection) => {
        const isInvalid = isConnectionInvalid(connection);
        return (
          <div className={`tab-container ${isInvalid ? "invalid" : ""}`} key={connection.id}>
            <div className="tab-actions">
              <button
                aria-label="Edit connection"
                className="edit-tab"
                onClick={() => onEditConnection(connection)}
                title="Edit connection"
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                  <path
                    d="M4 20h4l10-10-4-4L4 16v4z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                  <path d="m13 7 4 4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
              </button>
              <button
                aria-label="Delete connection"
                className="delete-tab"
                onClick={() => onDeleteConnection(connection)}
                title="Delete connection"
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14">
                  <path d="M3 6h18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  <path d="M8 6V4h8v2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  <path d="M19 6v14H5V6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                  <path d="M10 11v6M14 11v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                </svg>
              </button>
            </div>
            <button className={`tab ${connection.active ? "active" : ""}`} onClick={() => onSelectTab(connection)} type="button">
              {connection.name || "Unnamed"}
            </button>
          </div>
        );
      })}
      <button className="add-tab" onClick={onAddConnection} type="button">+</button>
      <div className="import-export-buttons">
        <button className="import-button" onClick={onImportConnections} type="button">Import</button>
        <button className="export-button" onClick={onExportConnections} type="button">Export</button>
      </div>
    </div>
  );
}
