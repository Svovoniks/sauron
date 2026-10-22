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

## Where is my data?
 - connections, saved queries and saved results are JSON files in the app data directory
   (macOS: `~/Library/Application Support/com.svovoniks.sauron/`)
 - passwords are stored in the system keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux),
   never in those files. Export asks whether to include them: "Include passwords" writes them into the JSON in **plain text**
   (import puts them back into the keychain). In the connection form the eye icon shows the saved password
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
 - only the last statement of a script shows its result; earlier statements are executed and their results discarded
 - "Read-only" uses the database's own read-only mode (`default_transaction_read_only` / `readonly=2`), which a script can
   switch off again; for real protection connect with a database role that only has SELECT rights
 - releases are signed ad hoc and not notarized, so macOS asks you to confirm the first start (see above); Windows may show a SmartScreen warning
