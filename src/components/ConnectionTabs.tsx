import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ConnStatus } from "../hooks/useConnectionStatus";
import { comboText } from "../lib/settings";
import { ENV_LABEL, ENVS, type Connection, type Env } from "../types/app";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { BoltIcon, ChevronDownIcon, CopyIcon, DatabaseIcon, DotsIcon, DownloadIcon, EditIcon, GearIcon, LinkIcon, LockIcon, PlusIcon, TrashIcon, UploadIcon } from "./icons";

interface ConnectionTabsProps {
  connections: Connection[];
  activeConnectionId: string | null;
  statusOf: (id: string) => ConnStatus;
  highlightProd: boolean;
  settingsShortcut: string;
  onAddConnection: () => void;
  onAddFromUrl: () => void;
  onEditConnection: (connection: Connection) => void;
  onDuplicateConnection: (connection: Connection) => void;
  onDeleteConnection: (connection: Connection) => void;
  onTestConnection: (connection: Connection) => void;
  onCopyUrl: (connection: Connection) => void;
  onSetEnv: (connection: Connection, env: Env) => void;
  onToggleReadOnly: (connection: Connection) => void;
  onSelectTab: (connection: Connection) => void;
  onReorderConnections: (fromId: string, toId: string) => void;
  onImportConnections: () => void;
  onExportConnections: () => void;
  onOpenSettings: () => void;
  onWindowDragStart: (event: MouseEvent<HTMLDivElement>) => void;
}

const isConnectionIncomplete = (c: Connection) => !c.name.trim() || !c.host.trim() || !c.port.trim() || !c.database.trim() || !c.username.trim();

const STATUS_TEXT = { ok: "Connected", err: "Last attempt failed", checking: "Checking…", "": "Not connected yet" } as const;

/** Event the ⌘O shortcut sends to open the connection switcher. */
export const OPEN_SWITCHER_EVENT = "sauron:open-switcher";

interface OpenMenu {
  /** The control that opened it: clicking that control again closes the menu instead of reopening it. */
  owner: string;
  x: number;
  y: number;
  items: MenuItem[];
}

export function ConnectionTabs(props: ConnectionTabsProps) {
  const { connections, activeConnectionId, statusOf, highlightProd } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const switcherRef = useRef<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  const connectionMenu = (connection: Connection, x: number, y: number): OpenMenu => {
    const status = statusOf(connection.id);
    const items: MenuItem[] = [
      { type: "label", text: `${connection.name || "Unnamed"} · ${connection.db_type === "postgres" ? "Postgres" : "ClickHouse"}${status.version ? ` · ${status.version.replace(/^PostgreSQL |^ClickHouse /, "")}` : ""}` },
      { label: "Edit…", icon: <EditIcon />, onSelect: () => props.onEditConnection(connection) },
      { label: "Duplicate", icon: <CopyIcon />, onSelect: () => props.onDuplicateConnection(connection) },
      { label: "Test connection", icon: <BoltIcon />, onSelect: () => props.onTestConnection(connection) },
      { label: "Copy connection URL", icon: <LinkIcon />, hint: "no password", onSelect: () => props.onCopyUrl(connection) },
      { type: "separator" },
      { type: "label", text: "Environment" },
      ...ENVS.map((env): MenuItem => ({ label: ENV_LABEL[env], checked: connection.env === env, onSelect: () => props.onSetEnv(connection, env) })),
      { type: "separator" },
      { label: connection.read_only ? "Allow writes" : "Make read-only", icon: <LockIcon />, onSelect: () => props.onToggleReadOnly(connection) },
      { type: "separator" },
      { label: "Delete…", icon: <TrashIcon />, danger: true, onSelect: () => props.onDeleteConnection(connection) },
    ];
    return { owner: `connection:${connection.id}`, x, y, items };
  };

  const switcherMenu = (): OpenMenu | null => {
    const rect = switcherRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      owner: "switcher",
      x: rect.left,
      y: rect.bottom + 6,
      items: [
        { type: "label", text: "Switch connection" },
        ...connections.map((connection, index): MenuItem => ({
          label: (
            <>
              {connection.name || "Unnamed"} <span className="muted">· {connection.database || connection.host}</span>
            </>
          ),
          icon: connection.read_only ? <LockIcon /> : <DatabaseIcon />,
          hint: index < 9 ? `${comboText("Mod+" + (index + 1))}` : undefined,
          checked: connection.id === activeConnectionId,
          onSelect: () => props.onSelectTab(connection),
        })),
        ...(connections.length === 0 ? [{ type: "label", text: "No connections yet" } as MenuItem] : []),
      ],
    };
  };

  /** Opens `next`, or closes the menu when it is already open for the same control. */
  const toggleMenu = (next: OpenMenu | null) => setMenu((current) => (!next || current?.owner === next.owner ? null : next));

  useEffect(() => {
    const open = () => toggleMenu(switcherMenu());
    window.addEventListener(OPEN_SWITCHER_EVENT, open);
    return () => window.removeEventListener(OPEN_SWITCHER_EVENT, open);
  });

  const addMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    toggleMenu({
      owner: "add",
      x: rect.left,
      y: rect.bottom + 6,
      items: [
        { label: "New connection…", icon: <PlusIcon />, onSelect: props.onAddConnection },
        { label: "Paste connection URL…", icon: <LinkIcon />, onSelect: props.onAddFromUrl },
        { type: "separator" },
        { label: "Import from file…", icon: <UploadIcon />, onSelect: props.onImportConnections },
        { label: "Export…", icon: <DownloadIcon />, onSelect: props.onExportConnections },
      ],
    });
  };

  // Selecting a connection from anywhere (switcher, palette, Mod+1..9, sidebar) brings its tab into view.
  useEffect(() => {
    const bar = containerRef.current;
    const tab = bar?.querySelector<HTMLElement>(".conn-tab.active");
    if (!bar || !tab) return;
    const margin = 24;
    const barBox = bar.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    const left = tabBox.left - barBox.left + bar.scrollLeft;
    const right = left + tabBox.width;
    if (left - margin < bar.scrollLeft) bar.scrollTo({ left: Math.max(0, left - margin), behavior: "smooth" });
    else if (right + margin > bar.scrollLeft + bar.clientWidth) bar.scrollTo({ left: right + margin - bar.clientWidth, behavior: "smooth" });
  }, [activeConnectionId, connections.length]);

  const tabLabel = (connection: Connection): ReactNode => connection.name || "Unnamed";

  return (
    <div className="connection-bar" onMouseDown={(event) => event.target === event.currentTarget && props.onWindowDragStart(event)}>
      <button aria-label={`Settings (${comboText(props.settingsShortcut)})`} className="conn-gear" onClick={props.onOpenSettings} title={`Settings (${comboText(props.settingsShortcut)})`} type="button">
        <GearIcon size={17} />
      </button>
      <button className="conn-switcher" data-menu-anchor onClick={() => toggleMenu(switcherMenu())} ref={switcherRef} title="Switch connection" type="button">
        <DatabaseIcon />
        All connections
        <kbd>{comboText("Mod+O")}</kbd>
        <ChevronDownIcon size={12} />
      </button>
      <div
        className="connection-tabs"
        onWheel={(event) => {
          // A plain mouse wheel scrolls the bar sideways (a trackpad already sends horizontal deltas).
          const bar = event.currentTarget;
          if (event.deltaX === 0 && event.deltaY !== 0 && bar.scrollWidth > bar.clientWidth) bar.scrollLeft += event.deltaY;
        }}
        onMouseDown={(event) => event.target === event.currentTarget && props.onWindowDragStart(event)}
        ref={containerRef}
      >
      {connections.map((connection, index) => {
        const status = statusOf(connection.id);
        const active = connection.id === activeConnectionId;
        const prod = connection.env === "prod" && highlightProd;
        return (
          <div
            className={`conn-tab ${active ? "active" : ""} ${isConnectionIncomplete(connection) ? "invalid" : ""} ${dragging === connection.id ? "dragging" : ""} ${dropTarget === connection.id ? "drop-target" : ""} env-${connection.env || "none"} ${prod ? "prod-marked" : ""}`}
            draggable
            key={connection.id}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(connectionMenu(connection, event.clientX, event.clientY));
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropTarget(null);
            }}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              setDropTarget(connection.id);
            }}
            onDragStart={(event) => {
              setDragging(connection.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", connection.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging && dragging !== connection.id) props.onReorderConnections(dragging, connection.id);
              setDragging(null);
              setDropTarget(null);
            }}
            title={`${connection.host}:${connection.port} · ${connection.database} · ${STATUS_TEXT[status.state]}${status.error ? `: ${status.error.split("\n")[0]}` : ""}`}
          >
            <button
              aria-label={`${connection.name || "Unnamed"} (${comboText("Mod+" + (index + 1))})`}
              aria-pressed={active}
              className="conn-tab-main"
              onClick={() => props.onSelectTab(connection)}
              type="button"
            >
              <span className={`conn-dot ${status.state}`} />
              {connection.read_only ? (
                <span className="conn-lock" title="Read-only connection">
                  <LockIcon size={12} />
                </span>
              ) : null}
              <span className="conn-name">{tabLabel(connection)}</span>
              {connection.env ? <span className="env-tag">{connection.env}</span> : null}
            </button>
            <button
              aria-label={`Actions for ${connection.name || "Unnamed"}`}
              className="conn-more"
              data-menu-anchor
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                toggleMenu(connectionMenu(connection, rect.left, rect.bottom + 6));
              }}
              title="Connection actions"
              type="button"
            >
              <DotsIcon />
            </button>
          </div>
        );
      })}
      <button aria-label="Add connection" className="conn-add" data-menu-anchor onClick={addMenu} title="Add or import connections" type="button">
        <PlusIcon size={15} />
      </button>
      </div>
      {menu ? <ContextMenu items={menu.items} onClose={() => setMenu(null)} x={menu.x} y={menu.y} /> : null}
    </div>
  );
}
