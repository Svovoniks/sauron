<p align="center">
  <img src="https://github.com/Svovoniks/sauron/blob/master/demo/eye.png?raw=true" width="100" />
</p>

## What is this app?

Sauron is an app for searching the database (currently only Postgres and ClickHouse are supported) so mostly just running selects and showing results in a pretty format

## Run on Mac
 - install the app (drag it to Applications)
 - the first time, macOS says it cannot verify the developer: open System Settings -> Privacy & Security, scroll down and press
   "Open Anyway" (on older macOS: right-click the app -> Open)
 - releases are signed ad hoc, not with an Apple Developer ID (that costs $99/year), so this one-time step is expected.
   If macOS says the app is "damaged" instead, run `xattr -cr /Applications/sauron.app` once

## Some cool features:
 - formatting json in results
 - saving queries and results of queries
 - you can click on a row and it will open a view with full values of all columns
 - you can go up and down the results table with j and k or with arrow keys
 - search in results with Ctrl/Cmd+F
 - "Open SQL file…" loads a `.sql` file into the editor (up to 5 MB); review it, then Execute runs every statement in it
 - backslash commands for Postgres (`\dt`, `\d table`, `\l`, `\i file`, ...): text starting with `\` is handed **unfiltered to the real
   `psql`** and its output is shown as is. If `psql` is not installed, a built-in version of the read-only catalog commands
   (`\dt`, `\d table`, `\l`, `\dn`, `\df`, `\du`, `\dx`, `\sf`, `\sv`, `\conninfo`, `\?`) is used instead.
 - connections are **read-only by default** and have a query timeout; Postgres connections can use TLS
 - results are capped (5,000 rows by default, "Load more" fetches more), so a big table does not freeze the app

## Everyday workflow
 - **Settings** (`Cmd/Ctrl+,` or the gear): accent colour, editor font / size / wrap / line numbers, what Execute runs, row limit, row
   density, zebra stripes, row numbers, how NULL is shown, defaults for new connections, the production guard, the `psql` binary,
   rebindable shortcuts, history retention. Changes apply immediately and are saved automatically
 - **Connection tabs** show a status dot, a lock for read-only, an environment tag (local / staging / prod) and a `...` menu: edit,
   duplicate, test, copy the URL (never the password), set the environment, make read-only, delete. `Cmd/Ctrl+O` switches connection,
   `Cmd/Ctrl+1..9` jumps to one. A **prod** connection gets a red marker and asks you to type its name before any write
 - **Command palette** (`Cmd/Ctrl+K`): actions, connections (`@`), tabs, saved queries, tables (`#`) and every setting (`>` for commands only)
 - **Query tabs** (`Cmd/Ctrl+T` new, `Cmd/Ctrl+Shift+W` close; `Cmd+W` is left to macOS, it closes the window). Each tab keeps its own SQL,
   undo history, connection and results. Tabs are restored on the next start (Settings -> General)
 - **Scripts**: every statement gets its own result tab plus a Messages log; a script stops at the first error. Execute runs the whole
   script (or the statement at the cursor, see Settings -> Editor); `Cmd/Ctrl+Shift+Enter` always runs everything, `Cmd/Ctrl+Alt+Enter` explains
   the statement at the cursor, a selection is always run on its own
 - **History** (sidebar tab): every run with its connection, time, duration and rows; filter, search, put back in the editor, run again,
   save as a query. `Alt+Cmd/Ctrl+Left/Right` steps through earlier runs. Only SQL text is stored, never results
 - **Schema** (sidebar tab): tables, views and functions with row estimates, columns with types and keys; click a column to insert it, double-click a
   table to read it. The editor completes table and column names (it understands aliases: `o.` after `join orders o`)
 - **Record view**: JSON as a collapsible tree, arrays as tags, timestamps with "3 weeks ago", filter fields, hide nulls, pin a row and
   Compare with another (`j` / `k` keep comparing), copy as JSON or INSERT
 - **Errors point at the problem**: the failing statement is underlined in the editor, with the SQLSTATE, a caret snippet, "did you mean ...?" for
   a mistyped table or column, and timeout / disconnect / read-only explanations with the next step. `Cmd/Ctrl+.` cancels a running query

## Updates
 - Sauron checks GitHub releases once at launch (Settings -> General -> "Check for updates automatically") and asks before it downloads
   anything: *Download & install*, *Later* or *Skip this version*, then *Restart now*. Settings -> About has a "Check for updates" button
 - updates are verified with a signing key: the public half is in `src-tauri/tauri.conf.json`, the private half must be set as the GitHub
   Actions secret `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty if the key has no password), otherwise the
   release workflow cannot sign the update bundles. Generate a new pair with `bunx tauri signer generate -w ~/.tauri/sauron-updater.key`
   (and put the new public key in `tauri.conf.json`); never commit the private key
 - the updater reads `latest.json` from the *latest published* release, so it only sees a release after you publish the draft;
   versions released before this feature existed have to be updated by hand once

## macOS passwords
 - macOS does not use the Keychain: it asks for the login password again after every update, once per saved connection, because it ties
   each item to the exact build that created it (only a paid Apple Developer ID avoids that). Passwords are kept in an AES-256-GCM encrypted
   file, `passwords.bin` in the app data directory (owner-only permissions, key derived from the Mac's hardware UUID), so nothing is ever asked.
   It stops the file being copied to another Mac or restored from a backup, not a process running as you on the same Mac
 - passwords saved by older versions are moved out of the Keychain the first time each connection is used (one last prompt per connection)
 - the release workflow still signs the macOS app with a fixed self-signed certificate (`Sauron Self-Signed`), so the app keeps one identity
 - the certificate lives in the GitHub Actions secrets `MACOS_CODESIGN_P12` (base64 of the .p12) and `MACOS_CODESIGN_P12_PASSWORD`; keep the
   same certificate forever, a new one counts as a different app and brings the prompts back once. Local `bun tauri build` stays ad-hoc signed

## Where is my data?
 - connections, saved queries and saved results are JSON files in the app data directory
   (macOS: `~/Library/Application Support/com.svovoniks.sauron/`); settings, query history and your open tabs are `settings.json`,
   `history.json` and `session.json` next to them. Settings -> Data & privacy shows the folder and clears the history
 - passwords are stored apart from those files (Windows Credential Manager, Secret Service on Linux, an encrypted file on macOS),
   never in them. Export asks whether to include them: "Include passwords" writes them into the JSON in **plain text**
   (import puts them back into the password store). In the connection form the eye icon shows the saved password
 - Import adds the items of an export file to what you already have (items with the same id are replaced)

## Quick Demo:

![document symbol](https://github.com/Svovoniks/sauron/blob/master/demo/demo.gif?raw=true)

## Development
 - `bun install`
 - `make run` (or `bun run tauri dev`) starts the app
 - `bun run dev` alone opens the UI in a plain browser with a fake backend (`src/dev/tauriMock.ts`)
 - `make check` runs the type check, the unit tests and clippy
 - the Rust integration tests need a database; they are skipped unless `SAURON_TEST_PG_PORT` (Postgres, with a table
   `t(id bigint, name text, flag bool, arr int[], j jsonb)` holding 2500 rows) or `SAURON_TEST_CH_PORT` (ClickHouse,
   see the comment in `src-tauri/src/clickhouse.rs`) is set
 - releases: bump the version in `package.json` and `src-tauri/Cargo.toml`, then push a tag `app-v<version>`;
   CI builds a **draft** release that you publish by hand

## Disclaimer
 - This app is mostly ai generated so there is some weird stuff happening

## Known issues
 - **psql commands are not sandboxed (accepted risk):** `\! cmd`, `\i file`, `\o |cmd`, `\copy ... program` run on your machine with your
   permissions. Do not execute backslash commands from saved queries or export files you did not write or read. The connection's
   read-only / timeout settings still apply to SQL sent through psql, but a psql script can switch them off
 - the sql query editor is a piece of vs code, so some vs code shortcuts still work (the command palette and "go to line" are removed)
 - a script stops at its first failing statement, later ones are not run. Inside `BEGIN ... COMMIT` rows are read without a cursor, so a huge select there is held in memory before the row limit applies
 - there is no light theme and no built-in demo database yet
 - "Read-only" uses the database's own read-only mode (`default_transaction_read_only` / `readonly=2`), which a script can
   switch off again; for real protection connect with a database role that only has SELECT rights
 - releases are signed ad hoc and not notarized, so macOS asks you to confirm the first start (see above); Windows may show a SmartScreen warning
