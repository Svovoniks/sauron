import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonFile, writeFileText } from "../lib/fileStore";
import { newEntry, normalizeHistory, pruneHistory, type HistoryEntry } from "../lib/history";
import type { HistoryKeep } from "../lib/settings";

const SAVE_DELAY_MS = 600;

/** Query history, newest first. Loaded once; saved (debounced) after every change. */
export function useHistory(keep: HistoryKeep, settingsLoaded: boolean, onError: (message: string) => void) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(entries);
  latest.current = entries;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    readJsonFile("history")
      .then((raw) => {
        if (cancelled) return;
        setEntries(normalizeHistory(raw));
        setLoaded(true);
      })
      .catch((error) => onErrorRef.current(`Could not load query history: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply the retention setting once settings are known, and whenever it changes.
  useEffect(() => {
    if (loaded && settingsLoaded) setEntries((current) => pruneHistory(current, keep));
  }, [loaded, settingsLoaded, keep]);

  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      writeFileText("history", JSON.stringify({ version: 1, entries: latest.current })).catch((error) =>
        onErrorRef.current(`Could not save query history: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, SAVE_DELAY_MS);
  }, [entries, loaded]);

  const add = useCallback(
    (entry: Omit<HistoryEntry, "id">) => {
      if (keep === "off" || !entry.sql.trim()) return;
      setEntries((current) => pruneHistory([newEntry(entry), ...current], keep));
    },
    [keep],
  );
  const clear = useCallback(() => setEntries([]), []);
  const remove = useCallback((id: string) => setEntries((current) => current.filter((entry) => entry.id !== id)), []);

  return { entries, add, clear, remove, loaded };
}
