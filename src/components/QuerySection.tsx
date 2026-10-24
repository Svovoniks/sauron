import { useRef, type ReactNode, type RefObject } from "react";
import { comboText, type ExecScope } from "../lib/settings";
import type { RunKind } from "../hooks/useSqlEditor";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ChevronDownIcon, InfoIcon, PlayIcon, ShieldIcon, StopIcon, GearIcon } from "./icons";
import { useState } from "react";

interface QuerySectionProps {
  editorContainerRef: RefObject<HTMLDivElement>;
  tabs: ReactNode;
  isLoading: boolean;
  isCommandQuery: boolean;
  /** A backslash command on a connection that is not Postgres: it will be rejected. */
  commandUnsupported: boolean;
  /** Shown above the editor on production connections. */
  prodBanner: { name: string; host: string; readOnly: boolean } | null;
  execScope: ExecScope;
  executeShortcut: string;
  onSaveQuery: () => void;
  onOpenFile: () => void;
  onAbortQuery: () => void;
  onRun: (kind: RunKind) => void;
  onOpenSettings: (section: "editor") => void;
}

export function QuerySection({ editorContainerRef, tabs, isLoading, isCommandQuery, commandUnsupported, prodBanner, execScope, executeShortcut, onSaveQuery, onOpenFile, onAbortQuery, onRun, onOpenSettings }: QuerySectionProps) {
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const items: MenuItem[] = [
    { label: "Run statement at cursor", icon: <PlayIcon size={12} />, hint: execScope === "statement" ? comboText(executeShortcut) : undefined, onSelect: () => onRun("statement") },
    { label: "Run whole script", icon: <PlayIcon size={12} />, hint: comboText("Mod+Shift+Enter"), onSelect: () => onRun("script") },
    { label: "Explain", icon: <InfoIcon size={13} />, hint: comboText("Mod+Alt+Enter"), onSelect: () => onRun("explain") },
    { type: "separator" },
    { label: "Change default in Settings…", icon: <GearIcon size={13} />, onSelect: () => onOpenSettings("editor") },
  ];

  return (
    <div className={`query-section ${prodBanner ? "prod" : ""}`}>
      <div className="query-input-container">
        <div className="query-header">
          {tabs}
          <div className="query-header-tools">
            <button className="query-file-button" disabled={isLoading} onClick={onOpenFile} title="Load a .sql file into the editor" type="button">
              Open SQL file…
            </button>
            <span className={`query-hint ${isCommandQuery && commandUnsupported ? "unsupported" : ""}`} role={isCommandQuery && commandUnsupported ? "alert" : undefined}>
              {isCommandQuery ? (commandUnsupported ? "\\ psql commands only work on Postgres" : "\\ psql command") : `${comboText(executeShortcut)} to execute`}
            </span>
          </div>
        </div>
        {prodBanner ? (
          <div className="prod-banner" role="status">
            <ShieldIcon size={14} />
            <b>Production</b>
            <span>
              {prodBanner.name} · {prodBanner.host}
            </span>
            <span className="muted">· {prodBanner.readOnly ? "read-only · " : ""}writes need confirmation</span>
          </div>
        ) : null}
        <div className="query-editor" ref={editorContainerRef}></div>
      </div>
      <div className="query-actions">
        <button className="button save-button" onClick={onSaveQuery} type="button">
          Save
        </button>
        {isLoading ? (
          <button className="button cancel-button" onClick={onAbortQuery} title={`Abort (${comboText("Mod+.")})`} type="button">
            <StopIcon size={12} />
            Abort
          </button>
        ) : (
          <div className="run-split">
            <button className="button execute-button run-main" onClick={() => onRun("default")} title={`${execScope === "statement" ? "Run the statement at the cursor, or the selection" : "Run the script, or the selection"} (${comboText(executeShortcut)})`} type="button">
              <PlayIcon size={12} />
              {execScope === "statement" ? "Run" : "Execute"}
            </button>
            <button
              aria-label="More ways to run"
              className="button execute-button run-menu"
              data-menu-anchor
              onClick={() => {
                const rect = menuButton.current?.getBoundingClientRect();
                setMenu((current) => (current || !rect ? null : { x: rect.right - 260, y: rect.top - 6 }));
              }}
              ref={menuButton}
              type="button"
            >
              <ChevronDownIcon size={13} />
            </button>
          </div>
        )}
      </div>
      {menu ? <ContextMenu items={items} onClose={() => setMenu(null)} x={menu.x} y={menu.y} /> : null}
    </div>
  );
}
