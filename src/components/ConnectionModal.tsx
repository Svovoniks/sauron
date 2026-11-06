import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { parseConnectionUrl, splitHosts } from "../lib/connUrl";
import { testConnection } from "../lib/db/query";
import { defaultPort, ENV_LABEL, type Connection, type ConnectionDraft, type DbType, type Env, type SslMode, type TargetSessionAttrs, type TestReport } from "../types/app";
import { expandPastedHosts, fromHostRows, toHostRows, type HostRow } from "../lib/hostList";
import { CheckIcon, CloseIcon, EyeIcon, EyeOffIcon, FileIcon, LinkIcon, PlusIcon, WarningIcon } from "./icons";
import { Modal } from "./Modal";

interface ConnectionModalProps {
  initial: ConnectionDraft;
  isEditing: boolean;
  /** Whether a password is already stored in the keychain for this connection (null = unknown). */
  hasSavedPassword: boolean | null;
  /** Open with the URL box focused ("Paste connection URL…"). */
  focusUrl?: boolean;
  onClose: () => void;
  /** Returns true when saved. */
  onSave: (draft: ConnectionDraft) => void;
  /** Called after a test, so the tab's status dot can follow. */
  onTested?: (draft: ConnectionDraft, report: TestReport | null, error: string | null) => void;
  /** Reads the saved password from the keychain (for the eye icon). */
  loadSavedPassword: () => Promise<string | null>;
  /** The default certificate files from Settings, for connections that use them. */
  defaultCerts: DefaultCerts;
}

const SSL_OPTIONS: Record<DbType, { value: SslMode; label: string }[]> = {
  postgres: [
    { value: "disable", label: "Off (no encryption)" },
    { value: "prefer", label: "Prefer (encrypt if the server supports it)" },
    { value: "require", label: "Require (encrypted, certificate not checked)" },
    { value: "verify-ca", label: "Verify CA (encrypted, certificate authority checked)" },
    { value: "verify", label: "Verify (encrypted, certificate checked)" },
  ],
  clickhouse: [
    { value: "disable", label: "Off (http)" },
    { value: "require", label: "https (certificate not checked)" },
    { value: "verify", label: "https (certificate checked)" },
  ],
};

const SSL_HINT: Record<SslMode, string> = {
  disable: "No encryption. Only for local databases.",
  prefer: "Encrypts when the server supports it; falls back to plain text.",
  require: "Always encrypted, but the certificate isn’t checked.",
  "verify-ca": "Encrypted, and the certificate must be signed by the root certificate below (or a system one). The host name isn’t checked.",
  verify: "Encrypted, and the certificate and host name are verified. Recommended for remote servers.",
};

const TARGET_OPTIONS: { value: TargetSessionAttrs; label: string; hint: string }[] = [
  { value: "any", label: "Any node", hint: "The first host that answers, primary or replica." },
  { value: "read-write", label: "Primary (read-write)", hint: "The first host that accepts writes. Skips replicas, so writes keep working after a failover." },
  { value: "read-only", label: "Replica (read-only)", hint: "The first host that only allows reads. Keeps queries off the primary." },
];

type CertField = "ssl_root_cert" | "ssl_cert" | "ssl_key";
type DefaultCerts = Record<CertField, string>;

const CERT_FIELDS: { field: CertField; label: string; placeholder: string }[] = [
  { field: "ssl_root_cert", label: "Root certificate", placeholder: "~/certs/stepcaroot.pem" },
  { field: "ssl_cert", label: "Client certificate", placeholder: "~/certs/certificate.pem" },
  { field: "ssl_key", label: "Client key", placeholder: "~/certs/private.pem" },
];

const TIMEOUTS = [15, 30, 60, 300, 900, 0];
const timeoutLabel = (secs: number) => (secs === 0 ? "none" : secs >= 60 && secs % 60 === 0 ? `${secs / 60} min` : `${secs} s`);

const validPort = (text: string) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 65535;

/** Postgres takes libpq's lists: several hosts, and one port for all of them or one port per host. */
function validateAddress(draft: ConnectionDraft): string | null {
  if (draft.db_type !== "postgres") {
    if (!draft.host.trim()) return "Host is required.";
    if (draft.host.includes(",")) return "Several hosts are only supported for Postgres.";
    return validPort(draft.port.trim()) ? null : "Port must be a number from 1 to 65535.";
  }
  const hosts = splitHosts(draft.host);
  if (hosts.length === 0) return "Host is required.";
  const ports = draft.port.split(",").map((p) => p.trim());
  if (ports.length === 1) return validPort(ports[0]) ? null : "Port must be a number from 1 to 65535.";
  if (!ports.every(validPort)) return "Each port must be a number from 1 to 65535.";
  if (ports.length !== hosts.length) return `${ports.length} ports for ${hosts.length} hosts: give one port for all hosts, or one port per host.`;
  return null;
}

function validate(draft: ConnectionDraft, defaultCerts: DefaultCerts): string | null {
  const address = validateAddress(draft);
  if (address) return address;
  if (!Number.isInteger(draft.timeout_secs) || draft.timeout_secs < 0) return "Timeout must be 0 or a positive number.";
  if (draft.db_type !== "postgres") return null;
  const certs = draft.use_default_certs ? defaultCerts : draft;
  if (draft.use_default_certs && !certs.ssl_root_cert && !certs.ssl_cert) return "No default certificates are set yet: add them in Settings → Connections, or turn off “Use the default certificates”.";
  if (!certs.ssl_cert.trim() !== !certs.ssl_key.trim())
    return draft.use_default_certs ? "The default certificates in Settings need both the client certificate and the client key, or neither." : "Set both the client certificate and the client key, or neither.";
  if ((certs.ssl_cert.trim() || certs.ssl_root_cert.trim()) && draft.ssl_mode === "disable") return "Certificates need encryption: pick a TLS mode other than Off.";
  return null;
}

const ENV_CHOICES: Env[] = ["local", "staging", "prod"];

/** A host row plus a stable React key, so removing a row in the middle keeps focus and values in place. */
type KeyedRow = HostRow & { key: number };
let nextRowKey = 0;
const keyed = (rows: HostRow[]): KeyedRow[] => rows.map((row) => ({ ...row, key: nextRowKey++ }));

export function ConnectionModal({ initial, isEditing, hasSavedPassword, focusUrl, onClose, onSave, onTested, loadSavedPassword, defaultCerts }: ConnectionModalProps) {
  const [draft, setDraft] = useState<ConnectionDraft>(initial);
  const [showPassword, setShowPassword] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [urlText, setUrlText] = useState("");
  const [urlState, setUrlState] = useState<"" | "ok" | "bad">("");
  const [certsOpen, setCertsOpen] = useState(() => initial.use_default_certs || CERT_FIELDS.some(({ field }) => initial[field] !== ""));
  const [test, setTest] = useState<{ running: boolean; report: TestReport | null; error: string | null }>({ running: false, report: null, error: null });
  const [rows, setRows] = useState<KeyedRow[]>(() => keyed(toHostRows(initial.host, initial.port)));
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const hostRefs = useRef(new Map<number, HTMLInputElement>());
  const urlRef = useRef<HTMLInputElement | null>(null);
  const tempId = useRef(`test-${crypto.randomUUID()}`);

  useEffect(() => {
    if (focusUrl) urlRef.current?.focus();
  }, [focusUrl]);

  useEffect(() => {
    if (focusRow === null) return;
    hostRefs.current.get(focusRow)?.focus();
    setFocusRow(null);
  }, [focusRow]);

  const patch = (changes: Partial<ConnectionDraft>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setTest((t) => (t.report || t.error ? { running: false, report: null, error: null } : t));
  };

  /** Rows are what the form shows; the draft keeps the saved shape (comma lists). */
  const updateRows = (next: KeyedRow[]) => {
    setRows(next);
    patch(fromHostRows(next));
  };

  const changeHost = (index: number, value: string) => {
    if (!value.includes(",")) return updateRows(rows.map((row, i) => (i === index ? { ...row, host: value } : row)));
    // A pasted or typed list becomes one row per host; a trailing comma starts a new empty row.
    const expanded = expandPastedHosts(rows, index, value);
    const added = expanded.length - rows.length + 1;
    const next = [...rows.slice(0, index), ...keyed(expanded.slice(index, index + added)), ...rows.slice(index + 1)];
    if (value.trimEnd().endsWith(",")) {
      const empty = keyed([{ host: "", port: rows[index].port }])[0];
      next.splice(index + added, 0, empty);
      setFocusRow(empty.key);
    }
    updateRows(next);
  };

  const addRow = () => {
    const row = keyed([{ host: "", port: rows[rows.length - 1]?.port ?? defaultPort(draft.db_type) }])[0];
    updateRows([...rows, row]);
    setFocusRow(row.key);
  };

  const removeRow = (index: number) => updateRows(rows.filter((_, i) => i !== index));

  const changeDbType = (dbType: DbType) => {
    if (dbType === draft.db_type) return;
    const swapPort = (port: string) => (port.trim() === "" || port === defaultPort(draft.db_type) ? defaultPort(dbType) : port);
    const next = rows.map((row) => ({ ...row, port: swapPort(row.port) }));
    setRows(next);
    patch({
      db_type: dbType,
      ...fromHostRows(next),
      ssl_mode: SSL_OPTIONS[dbType].some((option) => option.value === draft.ssl_mode) ? draft.ssl_mode : "require",
    });
  };

  const onUrlChange = (text: string) => {
    setUrlText(text);
    if (!text.trim()) return setUrlState("");
    const parsed = parseConnectionUrl(text);
    if (!parsed) return setUrlState("bad");
    setUrlState("ok");
    const { name, ...rest } = parsed;
    if (rest.host !== undefined) setRows(keyed(toHostRows(rest.host, rest.port ?? draft.port)));
    patch({ ...rest, name: draft.name.trim() ? draft.name : (name ?? "") });
  };

  const error = validate(draft, defaultCerts);

  const browse = async (field: CertField) => {
    const selected = await open({ multiple: false });
    if (typeof selected === "string") patch({ [field]: selected });
  };

  const runTest = async () => {
    setSubmitted(true);
    if (error) return;
    setTest({ running: true, report: null, error: null });
    const connection: Connection = {
      id: draft.id || tempId.current,
      name: draft.name,
      host: draft.host.trim(),
      port: draft.port.trim(),
      username: draft.username,
      database: draft.database,
      db_type: draft.db_type,
      ssl_mode: draft.ssl_mode,
      read_only: draft.read_only,
      timeout_secs: draft.timeout_secs,
      env: draft.env,
      description: draft.description,
      ssl_root_cert: draft.ssl_root_cert.trim(),
      ssl_cert: draft.ssl_cert.trim(),
      ssl_key: draft.ssl_key.trim(),
      use_default_certs: draft.use_default_certs,
      target_session_attrs: draft.target_session_attrs,
    };
    try {
      const report = await testConnection(connection, draft.password);
      setTest({ running: false, report, error: null });
      onTested?.(draft, report, null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setTest({ running: false, report: null, error: message });
      onTested?.(draft, null, message);
    }
  };

  return (
    <Modal className="connection-modal" onClose={onClose} title={isEditing ? "Edit Connection" : "New Connection"}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!error)
            onSave({ ...draft, host: draft.host.trim(), port: draft.port.trim(), ssl_root_cert: draft.ssl_root_cert.trim(), ssl_cert: draft.ssl_cert.trim(), ssl_key: draft.ssl_key.trim() });
        }}
      >
        <div className="form-group">
          <label id="db-type-label">Database Type</label>
          <div aria-labelledby="db-type-label" className={`db-type-switch ${draft.db_type === "clickhouse" ? "clickhouse" : ""}`} role="group">
            <button aria-pressed={draft.db_type === "postgres"} className={draft.db_type === "postgres" ? "active" : ""} onClick={() => changeDbType("postgres")} type="button">
              Postgres
            </button>
            <button aria-pressed={draft.db_type === "clickhouse"} className={draft.db_type === "clickhouse" ? "active" : ""} onClick={() => changeDbType("clickhouse")} type="button">
              ClickHouse
            </button>
          </div>
        </div>

        <div className={`url-paste ${urlState}`}>
          <LinkIcon size={15} />
          <input
            aria-label="Connection URL"
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="Paste a connection URL to fill the form (optional)"
            ref={urlRef}
            spellCheck={false}
            type="text"
            value={urlText}
          />
          <span className="url-state">{urlState === "ok" ? "✓ filled in" : urlState === "bad" ? "not a valid URL yet" : ""}</span>
        </div>

        <div className="form-group">
          <label htmlFor="connection-name">Connection Name</label>
          <input autoCorrect="off" id="connection-name" onChange={(event) => patch({ name: event.target.value })} placeholder="e.g. orders-prod" type="text" value={draft.name} />
        </div>
        <div className="form-group">
          <label id="env-label">Environment</label>
          <div aria-labelledby="env-label" className="env-picker" role="group">
            {ENV_CHOICES.map((env) => (
              <button aria-pressed={draft.env === env} className={`env-${env} ${draft.env === env ? "active" : ""}`} key={env} onClick={() => patch({ env: draft.env === env ? "" : env })} title={draft.env === env ? "Click again to clear" : undefined} type="button">
                <i />
                {ENV_LABEL[env]}
              </button>
            ))}
          </div>
          <p className="field-hint">Production connections get a red marker and ask for confirmation before writes.</p>
        </div>
        <div className="form-group">
          <label htmlFor="connection-description">
            Description <span className="optional">(optional)</span>
          </label>
          <textarea
            id="connection-description"
            onChange={(event) => patch({ description: event.target.value })}
            placeholder="e.g. Staging replica of the orders service. Safe to query, data is refreshed nightly."
            rows={3}
            value={draft.description}
          />
          <p className="field-hint">Shown to AI agents that list your connections over MCP, so they know which one to use.</p>
        </div>
        <div className={`form-group host-list ${rows.length > 1 ? "multi" : ""}`}>
          <div className="host-row host-row-head">
            <label htmlFor="host">{rows.length > 1 ? "Hosts" : "Host"}</label>
            <label htmlFor="port">Port</label>
          </div>
          {rows.map((row, index) => (
            <div className="host-row" key={row.key}>
              <input
                aria-label={rows.length > 1 ? `Host ${index + 1}` : undefined}
                autoCorrect="off"
                id={index === 0 ? "host" : undefined}
                onChange={(event) => changeHost(index, event.target.value)}
                placeholder={index === 0 ? "db.example.internal" : "another node of the cluster"}
                ref={(element) => {
                  if (element) hostRefs.current.set(row.key, element);
                  else hostRefs.current.delete(row.key);
                }}
                spellCheck={false}
                type="text"
                value={row.host}
              />
              <input
                aria-label={rows.length > 1 ? `Port of host ${index + 1}` : undefined}
                autoCorrect="off"
                id={index === 0 ? "port" : undefined}
                inputMode="numeric"
                onChange={(event) => updateRows(rows.map((r, i) => (i === index ? { ...r, port: event.target.value } : r)))}
                placeholder={defaultPort(draft.db_type)}
                type="text"
                value={row.port}
              />
              {rows.length > 1 ? (
                <button aria-label={`Remove host ${index + 1}`} className="host-remove" onClick={() => removeRow(index)} title="Remove this host" type="button">
                  <CloseIcon />
                </button>
              ) : null}
            </div>
          ))}
          {draft.db_type === "postgres" ? (
            <button className="host-add" onClick={addRow} type="button">
              <PlusIcon size={13} />
              {rows.length > 1 ? "Add host" : "Add host (replica or another cluster node)"}
            </button>
          ) : null}
          {draft.db_type === "postgres" && rows.length > 1 ? <p className="field-hint">Tried from top to bottom. Target session decides which one is kept.</p> : null}
        </div>
        {draft.db_type === "postgres" ? (
          <div className="form-group">
            <label htmlFor="target-session">Target session</label>
            <select id="target-session" onChange={(event) => patch({ target_session_attrs: event.target.value as TargetSessionAttrs })} value={draft.target_session_attrs}>
              {TARGET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="field-hint">{TARGET_OPTIONS.find((option) => option.value === draft.target_session_attrs)?.hint}</p>
          </div>
        ) : null}
        <div className="host-port-group">
          <div className="form-group">
            <label htmlFor="database">Database</label>
            <input autoCorrect="off" id="database" onChange={(event) => patch({ database: event.target.value })} placeholder={draft.db_type === "postgres" ? "postgres" : "default"} type="text" value={draft.database} />
          </div>
          <div className="form-group">
            <label htmlFor="username">User</label>
            <input autoCorrect="off" id="username" onChange={(event) => patch({ username: event.target.value })} placeholder="readonly" type="text" value={draft.username} />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="password">Password</label>
          <div className="password-input-container">
            <input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              id="password"
              onChange={(event) => patch({ password: event.target.value })}
              placeholder={isEditing && hasSavedPassword ? "Saved - click the eye to show it" : "Stored securely on this computer"}
              type={showPassword ? "text" : "password"}
              value={draft.password}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="password-toggle"
              onClick={async () => {
                // Editing with an untouched empty field: reveal means "show me the saved password".
                if (!showPassword && isEditing && hasSavedPassword && draft.password === "") {
                  try {
                    const saved = await loadSavedPassword();
                    if (saved) patch({ password: saved });
                    setPasswordError(null);
                  } catch (e) {
                    setPasswordError(e instanceof Error ? e.message : String(e));
                  }
                }
                setShowPassword((value) => !value);
              }}
              title={showPassword ? "Hide password" : "Show password"}
              type="button"
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>
        {passwordError ? (
          <p className="form-error" role="alert">
            {passwordError}
          </p>
        ) : null}
        <div className="form-group">
          <label htmlFor="ssl-mode">Encryption (TLS)</label>
          <select id="ssl-mode" onChange={(event) => patch({ ssl_mode: event.target.value as SslMode })} value={draft.ssl_mode}>
            {SSL_OPTIONS[draft.db_type].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="field-hint">{SSL_HINT[draft.ssl_mode]}</p>
        </div>

        {draft.db_type === "postgres" ? (
          <details className="cert-files" onToggle={(event) => setCertsOpen(event.currentTarget.open)} open={certsOpen}>
            <summary>
              Certificates <span className="optional">(optional)</span>
            </summary>
            <p className="field-hint">
              For databases that log you in by client certificate instead of a password (e.g. STG Postgres with keex certificates: port 6433, Verify CA, password empty). The files are read on every
              connect, so after re-issuing the certificate just overwrite them.
            </p>
            <label className="safe-card" htmlFor="use-default-certs">
              <input checked={draft.use_default_certs} className="toggle-input" id="use-default-certs" onChange={(event) => patch({ use_default_certs: event.target.checked })} type="checkbox" />
              <span aria-hidden="true" className="toggle-track" />
              <span>
                <b>Use the default certificates</b>
                <small>The ones set in Settings → Connections, shared by every connection that uses them.</small>
              </span>
            </label>
            {draft.use_default_certs ? (
              <ul className="cert-defaults">
                {CERT_FIELDS.map(({ field, label }) => (
                  <li key={field}>
                    <span>{label}</span>
                    <code>{defaultCerts[field] || "not set"}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {draft.use_default_certs ? null : CERT_FIELDS.map(({ field, label, placeholder }) => (
              <div className="form-group" key={field}>
                <label htmlFor={field}>{label}</label>
                <div className="password-input-container">
                  <input autoCapitalize="none" autoCorrect="off" id={field} onChange={(event) => patch({ [field]: event.target.value })} placeholder={placeholder} spellCheck={false} type="text" value={draft[field]} />
                  <button aria-label={`Choose the ${label.toLowerCase()} file`} className="password-toggle" onClick={() => void browse(field)} title="Choose file" type="button">
                    <FileIcon />
                  </button>
                </div>
              </div>
            ))}
          </details>
        ) : null}

        <div className="safe-grid">
          <label className="safe-card" htmlFor="read-only">
            <input checked={draft.read_only} className="toggle-input" id="read-only" onChange={(event) => patch({ read_only: event.target.checked })} type="checkbox" />
            <span aria-hidden="true" className="toggle-track" />
            <span>
              <b>Read-only</b>
              <small>The database itself rejects writes. Recommended.</small>
            </span>
          </label>
          <div className="safe-card">
            <span>
              <b>Query timeout</b>
              <small>Stops runaway queries on the server.</small>
            </span>
            <select aria-label="Query timeout" onChange={(event) => patch({ timeout_secs: Number(event.target.value) })} value={draft.timeout_secs}>
              {(TIMEOUTS.includes(draft.timeout_secs) ? TIMEOUTS : [draft.timeout_secs, ...TIMEOUTS]).map((secs) => (
                <option key={secs} value={secs}>
                  {timeoutLabel(secs)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!draft.read_only ? (
          <p className="field-hint warn">
            <WarningIcon className="inline-icon" /> Writes are allowed on this connection{draft.env === "prod" ? ", and you will be asked to confirm each one." : "."}
          </p>
        ) : null}

        {test.running || test.report || test.error ? (
          <div className="test-steps" aria-live="polite">
            {test.running ? (
              <div className="step run">
                <span className="mini-spinner" />
                Testing the connection…
              </div>
            ) : null}
            {test.report?.steps.map((step, index) => (
              <div className={`step ${step.ok ? "ok" : "fail"}`} key={index}>
                <span className="s-ic">{step.ok ? <CheckIcon /> : <WarningIcon />}</span>
                {step.name}
                <span className="d">{step.detail}{step.ms > 0 ? ` · ${step.ms} ms` : ""}</span>
              </div>
            ))}
            {test.report?.ok ? (
              <div className="step result">
                <CheckIcon />
                Connected{test.report.server_version ? ` to ${test.report.server_version}` : ""}. Ready to save.
              </div>
            ) : null}
            {test.error ? <div className="step fail">{test.error}</div> : null}
          </div>
        ) : null}

        {submitted && error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-buttons connection-buttons">
          <button className="button cancel-button" disabled={test.running} onClick={runTest} type="button">
            Test connection
          </button>
          <span className="sp" />
          <button className="button cancel-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="button save-button" type="submit">
            {isEditing ? "Save" : "Save & connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
