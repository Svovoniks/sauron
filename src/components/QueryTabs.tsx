import { useEffect, useRef, useState } from "react";
import { comboText } from "../lib/settings";
import type { Connection } from "../types/app";
import type { QueryTab } from "../types/workspace";
import { CloseIcon, PinIcon, PlusIcon } from "./icons";

interface QueryTabsProps {
  tabs: QueryTab[];
  activeId: string | null;
  runningId: string | null;
  dirtyIds: Set<string>;
  connections: Connection[];
  highlightProd: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onReorder: (fromId: string, toId: string) => void;
}

const ENV_COLOR = { local: "var(--ok)", staging: "var(--warn)", prod: "var(--err)", "": "var(--faint)" } as const;

export function QueryTabs(props: QueryTabsProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  // Keep the active tab visible when there are many.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeId]);

  const finishRename = (id: string, value: string) => {
    setRenaming(null);
    if (value.trim()) props.onRename(id, value.trim());
  };

  return (
    <div
      className="query-tabs"
      onWheel={(event) => {
        const bar = event.currentTarget;
        if (event.deltaX === 0 && event.deltaY !== 0 && bar.scrollWidth > bar.clientWidth) bar.scrollLeft += event.deltaY;
      }}
      role="tablist"
    >
      {props.tabs.map((tab) => {
        const connection = props.connections.find((c) => c.id === tab.connectionId);
        const env = connection?.env ?? "";
        const active = tab.id === props.activeId;
        const dirty = props.dirtyIds.has(tab.id);
        return (
          <div
            aria-selected={active}
            className={`query-tab ${active ? "active" : ""} ${dragging === tab.id ? "dragging" : ""}`}
            draggable={renaming !== tab.id}
            key={tab.id}
            onAuxClick={(event) => event.button === 1 && props.onClose(tab.id)}
            onClick={() => props.onSelect(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onContextMenu(tab.id, event.clientX, event.clientY);
            }}
            onDoubleClick={() => setRenaming(tab.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => dragging && event.preventDefault()}
            onDragStart={(event) => {
              setDragging(tab.id);
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging && dragging !== tab.id) props.onReorder(dragging, tab.id);
              setDragging(null);
            }}
            ref={active ? activeRef : undefined}
            role="tab"
            title={`${tab.name}${connection ? ` · ${connection.name}` : ""}`}
          >
            <span className="query-tab-dot" style={{ background: props.highlightProd || env !== "prod" ? ENV_COLOR[env] : ENV_COLOR[""] }} />
            {props.runningId === tab.id ? <span className="mini-spinner" /> : null}
            {tab.pinned ? <PinIcon size={12} /> : null}
            {renaming === tab.id ? (
              <input
                aria-label="Tab name"
                defaultValue={tab.name}
                onBlur={(event) => finishRename(tab.id, event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") finishRename(tab.id, event.currentTarget.value);
                  if (event.key === "Escape") setRenaming(null);
                }}
                ref={inputRef}
              />
            ) : (
              <span className="query-tab-name">{tab.name}</span>
            )}
            {dirty ? <span aria-label="Unsaved changes" className="query-tab-dirty" title="Differs from the saved query" /> : null}
            <button
              aria-label={`Close ${tab.name}`}
              className="query-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                props.onClose(tab.id);
              }}
              title={`Close (${comboText("Mod+Shift+W")})`}
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      <button aria-label="New tab" className="query-tab-new" onClick={props.onNew} title={`New tab (${comboText("Mod+T")})`} type="button">
        <PlusIcon size={15} />
      </button>
    </div>
  );
}
