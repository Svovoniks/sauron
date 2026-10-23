import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  accentOverride,
  DENSITY_PADDING,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type Settings,
} from "../lib/settings";
import { effectiveAppearance, themeById, themeVars, type Appearance } from "../lib/themes";

const SAVE_DELAY_MS = 300;
const LOOK_KEY = "sauron.look";

/** Theme choice cached in localStorage so the first paint already has the right colors (settings.json loads async). */
function cachedLook(): Partial<Settings> {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOK_KEY) ?? "null");
    const { theme, appearance, accent } = normalizeSettings(raw);
    return raw ? { theme, appearance, accent } : {};
  } catch {
    return {};
  }
}

const prefersDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
const wantedAppearance = (settings: Settings, systemDark: boolean): Appearance =>
  settings.appearance === "system" ? (systemDark ? "dark" : "light") : settings.appearance;

/** Settings are applied to the page as CSS variables / classes so no component needs to know. */
function applyToDocument(settings: Settings, systemDark: boolean) {
  const root = document.documentElement;
  const wanted = wantedAppearance(settings, systemDark);
  for (const [name, value] of Object.entries(themeVars(settings.theme, wanted, accentOverride(settings.accent)))) root.style.setProperty(name, value);
  root.dataset.theme = settings.theme;
  root.dataset.appearance = effectiveAppearance(themeById(settings.theme), wanted);
  root.style.setProperty("--cell-pad-y", `${DENSITY_PADDING[settings.density]}px`);
  root.style.setProperty("--editor-font-size", `${settings.editorFontSize}px`);
  root.classList.toggle("stripes", settings.stripes);
}

/**
 * Loads settings.json, applies them and writes every change back (debounced). Saving only starts
 * after a successful load so a failed read can never overwrite the file with defaults.
 */
export function useSettings(onError: (message: string) => void) {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...cachedLook() }));
  const [loaded, setLoaded] = useState(false);
  /** Loading finished, successfully or not: the app can start with defaults (saving stays off after a failure). */
  const [settled, setSettled] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(settings);
  latest.current = settings;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("storage_read", { name: "settings" })
      .then((text) => {
        if (cancelled) return;
        let raw: unknown = null;
        if (text !== null) {
          try {
            raw = JSON.parse(text);
          } catch {
            void invoke("storage_quarantine", { name: "settings" }).catch(() => undefined);
          }
        }
        setSettings(normalizeSettings(raw));
        setLoaded(true);
        setSettled(true);
      })
      .catch((error) => {
        setSettled(true);
        onErrorRef.current(`Could not load settings: ${error instanceof Error ? error.message : String(error)}. Using defaults; changes will not be saved.`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [systemDark, setSystemDark] = useState(prefersDark);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Before paint, so a theme change (or the first render) never flashes the wrong colors.
  useLayoutEffect(() => {
    applyToDocument(settings, systemDark);
    if (loaded) {
      try {
        localStorage.setItem(LOOK_KEY, JSON.stringify({ theme: settings.theme, appearance: settings.appearance, accent: settings.accent }));
      } catch {
        // storage unavailable: the cache is only an optimisation
      }
    }
  }, [settings, systemDark, loaded]);

  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      invoke("storage_write", { name: "settings", content: JSON.stringify(latest.current, null, 2) }).catch((error) =>
        onErrorRef.current(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, SAVE_DELAY_MS);
  }, [settings, loaded]);

  const update = useCallback((patch: Partial<Settings>) => setSettings((current) => ({ ...current, ...patch })), []);
  const reset = useCallback(() => setSettings(normalizeSettings(null)), []);

  /** The appearance that is actually shown (resolves "system" and themes that only have one). */
  const wanted = wantedAppearance(settings, systemDark);
  const appearance = effectiveAppearance(themeById(settings.theme), wanted);

  return { settings, update, reset, loaded, settled, appearance, wanted };
}
