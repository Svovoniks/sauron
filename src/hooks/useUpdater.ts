import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, installUpdate, restartApp, sameVersion, type UpdateInfo } from "../lib/updater";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; fraction: number | null }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "ready"; info: UpdateInfo }
  | { kind: "error"; message: string; info?: UpdateInfo };

/** How long after start the automatic check runs (so it never competes with the first paint / data load). */
const AUTO_CHECK_DELAY_MS = 8_000;

interface Options {
  /** Settings are loaded. */
  ready: boolean;
  autoUpdate: boolean;
  skippedVersion: string;
  /** Show the dialog for a found update (automatic checks only offer versions that are not skipped). */
  onOffer: () => void;
}

/** Update flow: check -> offer -> download + install -> restart. Automatic check once per launch, manual check any time. */
export function useUpdater({ ready, autoUpdate, skippedVersion, onOffer }: Options) {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const busy = useRef(false);
  const optionsRef = useRef({ skippedVersion, onOffer });
  optionsRef.current = { skippedVersion, onOffer };

  const check = useCallback(async (manual: boolean) => {
    if (busy.current) return;
    busy.current = true;
    if (manual) setState({ kind: "checking" });
    try {
      const info = await checkForUpdate();
      if (!info) {
        setState(manual ? { kind: "uptodate" } : { kind: "idle" });
      } else if (!manual && sameVersion(info.version, optionsRef.current.skippedVersion)) {
        setState({ kind: "available", info }); // known, but not pushed on the user
      } else {
        setState({ kind: "available", info });
        optionsRef.current.onOffer();
      }
    } catch (error) {
      // An automatic check that fails (offline, ...) stays quiet.
      setState(manual ? { kind: "error", message: error instanceof Error ? error.message : String(error) } : { kind: "idle" });
    } finally {
      busy.current = false;
    }
  }, []);

  const autoChecked = useRef(false);
  useEffect(() => {
    if (!ready || !autoUpdate || autoChecked.current || import.meta.env.DEV) return;
    autoChecked.current = true;
    const id = window.setTimeout(() => void check(false), AUTO_CHECK_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [ready, autoUpdate, check]);

  const install = useCallback(async () => {
    if (state.kind !== "available" && state.kind !== "error") return;
    const info = state.info;
    if (!info) return;
    setState({ kind: "downloading", info, fraction: 0 });
    try {
      await installUpdate(
        (fraction) => setState({ kind: "downloading", info, fraction }),
        () => setState({ kind: "installing", info }),
      );
      setState({ kind: "ready", info });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error), info });
    }
  }, [state]);

  const restart = useCallback(() => void restartApp(), []);
  const dismiss = useCallback(() => setState((current) => (current.kind === "available" || current.kind === "error" || current.kind === "uptodate" ? { kind: "idle" } : current)), []);

  return { state, check, install, restart, dismiss };
}
