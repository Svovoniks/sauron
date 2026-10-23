import { comboText, type Settings } from "../lib/settings";
import { DatabaseIcon, PlugIcon, UploadIcon } from "./icons";

interface WelcomeProps {
  shortcuts: Settings["shortcuts"];
  onConnect: () => void;
  onImport: () => void;
}

/** What a new user sees instead of an empty table. */
export function Welcome({ shortcuts, onConnect, onImport }: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="wcard">
        <div className="logo">
          <DatabaseIcon size={26} />
        </div>
        <div>
          <h1>Welcome to Sauron</h1>
          <p>Search Postgres and ClickHouse quickly and safely. Connections are read-only by default.</p>
        </div>
        <div className="choices">
          <button className="choice main" onClick={onConnect} type="button">
            <PlugIcon size={20} />
            <div>
              <b>Connect to a database</b>
              <span>Fill in a form or paste a connection URL. Passwords go to your system keychain, never to a file.</span>
            </div>
          </button>
          <button className="choice" onClick={onImport} type="button">
            <UploadIcon size={18} />
            <div>
              <b>Import from a file</b>
              <span>A Sauron export from a teammate or another computer.</span>
            </div>
          </button>
        </div>
        <div className="tips">
          <span>
            <kbd>{comboText(shortcuts.execute)}</kbd> run
          </span>
          <span>
            <kbd>{comboText(shortcuts.find)}</kbd> search results
          </span>
          <span>
            <kbd>j</kbd>
            <kbd>k</kbd> move through records
          </span>
          <span>
            <kbd>\dt</kbd> list tables
          </span>
          <span>
            <kbd>{comboText(shortcuts.palette)}</kbd> anything
          </span>
          <span>
            <kbd>{comboText(shortcuts.settings)}</kbd> settings
          </span>
        </div>
      </div>
    </div>
  );
}
