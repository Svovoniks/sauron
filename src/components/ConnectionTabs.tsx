import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import type { Connection } from "../types/app";
import { EditIcon, GripIcon, TrashIcon } from "./icons";

interface ConnectionTabsProps {
  connections: Connection[];
  activeConnectionId: string | null;
  onAddConnection: () => void;
  onEditConnection: (connection: Connection) => void;
  onDeleteConnection: (connection: Connection) => void;
  onSelectTab: (connection: Connection) => void;
  onReorderConnections: (fromId: string, toId: string) => void;
  onImportConnections: () => void;
  onExportConnections: () => void;
  onWindowDragStart: (event: MouseEvent<HTMLDivElement>) => void;
}

const isConnectionIncomplete = (connection: Connection) =>
  !connection.name.trim() || !connection.host.trim() || !connection.port.trim() || !connection.database.trim() || !connection.username.trim();

export function ConnectionTabs({
  connections,
  activeConnectionId,
  onAddConnection,
  onEditConnection,
  onDeleteConnection,
  onSelectTab,
  onReorderConnections,
  onImportConnections,
  onExportConnections,
  onWindowDragStart,
}: ConnectionTabsProps) {
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const velocityRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const [draggingConnectionId, setDraggingConnectionId] = useState<string | null>(null);

  const handleWheelScroll = (event: WheelEvent<HTMLDivElement>) => {
    const container = tabsContainerRef.current;
    if (!container) return;
    if (container.scrollWidth <= container.clientWidth) return;
    if (event.deltaY === 0) return;

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
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  useEffect(() => {
    const handleMouseUp = () => setDraggingConnectionId(null);
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const startReorder = (event: MouseEvent<HTMLButtonElement>, connectionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDraggingConnectionId(connectionId);
  };

  const handleReorderHover = (targetConnectionId: string) => {
    if (!draggingConnectionId || draggingConnectionId === targetConnectionId) return;
    onReorderConnections(draggingConnectionId, targetConnectionId);
  };

  return (
    <div
      className="connection-tabs"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onWindowDragStart(event);
      }}
      onWheel={handleWheelScroll}
      ref={tabsContainerRef}
    >
      {connections.map((connection) => {
        const isDragging = draggingConnectionId === connection.id;
        return (
          <div
            className={`tab-container ${isConnectionIncomplete(connection) ? "invalid" : ""} ${isDragging ? "dragging" : ""}`}
            key={connection.id}
            onMouseEnter={() => handleReorderHover(connection.id)}
            onMouseUp={() => setDraggingConnectionId(null)}
          >
            <div className="tab-actions">
              <button
                aria-label="Reorder connection"
                className={`drag-tab ${isDragging ? "active" : ""}`}
                onMouseDown={(event) => startReorder(event, connection.id)}
                title="Drag to reorder"
                type="button"
              >
                <GripIcon />
              </button>
              <button
                aria-label="Edit connection"
                className="edit-tab"
                onClick={() => onEditConnection(connection)}
                title="Edit connection"
                type="button"
              >
                <EditIcon />
              </button>
              <button
                aria-label="Delete connection"
                className="delete-tab"
                onClick={() => onDeleteConnection(connection)}
                title="Delete connection"
                type="button"
              >
                <TrashIcon />
              </button>
            </div>
            <button
              aria-pressed={connection.id === activeConnectionId}
              className={`tab ${connection.id === activeConnectionId ? "active" : ""}`}
              onClick={() => onSelectTab(connection)}
              type="button"
            >
              {connection.name || "Unnamed"}
              {connection.read_only ? (
                <span className="tab-badge" title="Read-only connection">
                  RO
                </span>
              ) : null}
            </button>
          </div>
        );
      })}
      <button className="add-tab" onClick={onAddConnection} type="button">
        +
      </button>
      <div className="import-export-buttons">
        <button className="import-button" onClick={onImportConnections} type="button">
          Import
        </button>
        <button className="export-button" onClick={onExportConnections} type="button">
          Export
        </button>
      </div>
    </div>
  );
}
