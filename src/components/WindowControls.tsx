import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

/** Minimize / maximize / close for Windows and Linux, where the native title bar is hidden (macOS keeps its traffic lights). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const unlisten = win.onResized(sync);
    return () => void unlisten.then((stop) => stop());
  }, []);

  const run = (action: (win: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () =>
    void action(getCurrentWindow()).catch((error) => console.warn("Window action failed.", error));

  return (
    <div className="window-controls">
      <button aria-label="Minimize" onClick={run((win) => win.minimize())} title="Minimize" type="button">
        <svg aria-hidden="true" height="10" viewBox="0 0 10 10" width="10">
          <path d="M0 5h10" stroke="currentColor" />
        </svg>
      </button>
      <button aria-label={maximized ? "Restore" : "Maximize"} onClick={run((win) => win.toggleMaximize())} title={maximized ? "Restore" : "Maximize"} type="button">
        <svg aria-hidden="true" fill="none" height="10" viewBox="0 0 10 10" width="10">
          {maximized ? (
            <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" stroke="currentColor" />
          ) : (
            <rect height="9" stroke="currentColor" width="9" x=".5" y=".5" />
          )}
        </svg>
      </button>
      <button aria-label="Close" className="window-close" onClick={run((win) => win.close())} title="Close" type="button">
        <svg aria-hidden="true" height="10" viewBox="0 0 10 10" width="10">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" />
        </svg>
      </button>
    </div>
  );
}
