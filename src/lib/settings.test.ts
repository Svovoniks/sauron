import { describe, expect, test } from "bun:test";
import { accentOverride, comboLabels, DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, normalizeSettings, parseCombo } from "./settings";

describe("normalizeSettings", () => {
  test("not an object -> defaults (and not the shared default object)", () => {
    const a = normalizeSettings(null);
    expect(a).toEqual(DEFAULT_SETTINGS);
    a.shortcuts.execute = "Mod+X";
    expect(DEFAULT_SETTINGS.shortcuts.execute).toBe(DEFAULT_SHORTCUTS.execute);
    expect(normalizeSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS);
  });
  test("valid values are kept, invalid ones fall back one by one", () => {
    const s = normalizeSettings({ accent: "Violet", rowLimit: 500, density: "huge", editorFontSize: 99, wordWrap: "yes", psqlPath: "  /usr/bin/psql ", historyKeep: "7", execScope: "statement" });
    expect(s.accent).toBe("Violet");
    expect(s.rowLimit).toBe(500);
    expect(s.density).toBe(DEFAULT_SETTINGS.density);
    expect(s.editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize);
    expect(s.wordWrap).toBe(DEFAULT_SETTINGS.wordWrap);
    expect(s.psqlPath).toBe("/usr/bin/psql");
    expect(s.historyKeep).toBe("7");
    expect(s.execScope).toBe("statement");
  });
  test("row limit must be a positive integer within the backend maximum", () => {
    expect(normalizeSettings({ rowLimit: 0 }).rowLimit).toBe(DEFAULT_SETTINGS.rowLimit);
    expect(normalizeSettings({ rowLimit: 1_000_001 }).rowLimit).toBe(DEFAULT_SETTINGS.rowLimit);
    expect(normalizeSettings({ rowLimit: 2.5 }).rowLimit).toBe(DEFAULT_SETTINGS.rowLimit);
    expect(normalizeSettings({ rowLimit: 1_000_000 }).rowLimit).toBe(1_000_000);
  });
  test("shortcuts: malformed or modifier-less combos are rejected", () => {
    const s = normalizeSettings({ shortcuts: { execute: "Mod+Shift+R", palette: "K", save: "Ctrl+S", find: 5 } });
    expect(s.shortcuts.execute).toBe("Mod+Shift+R");
    expect(s.shortcuts.palette).toBe(DEFAULT_SHORTCUTS.palette); // a bare key would break typing
    expect(s.shortcuts.save).toBe(DEFAULT_SHORTCUTS.save); // unknown modifier name
    expect(s.shortcuts.find).toBe(DEFAULT_SHORTCUTS.find);
  });
});

describe("combos", () => {
  test("parseCombo", () => {
    expect(parseCombo("Mod+Enter")).toEqual({ mod: true, shift: false, alt: false, key: "Enter" });
    expect(parseCombo("Mod+Shift+Alt+P")).toEqual({ mod: true, shift: true, alt: true, key: "P" });
    expect(parseCombo("Mod+,")).toEqual({ mod: true, shift: false, alt: false, key: "," });
    expect(parseCombo("Mod++")).toEqual({ mod: true, shift: false, alt: false, key: "+" });
    expect(parseCombo("Enter")).toBeNull();
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("Mod+")).toBeNull();
  });
  test("labels have a modifier part and a key part", () => {
    const labels = comboLabels("Mod+Shift+Enter");
    expect(labels.length).toBe(3);
    expect(labels.some((l) => l === "↵" || l === "Enter")).toBe(true);
  });
});

describe("loading animation setting", () => {
  test("defaults to the eye and ignores unknown values", () => {
    expect(DEFAULT_SETTINGS.loadingAnimation).toBe("eye");
    expect(normalizeSettings({}).loadingAnimation).toBe("eye");
    expect(normalizeSettings({ loadingAnimation: "spinner" }).loadingAnimation).toBe("eye");
    expect(normalizeSettings({ loadingAnimation: "tower" }).loadingAnimation).toBe("tower");
  });
});

describe("theme settings", () => {
  test("theme and appearance fall back to defaults when unknown", () => {
    const s = normalizeSettings({ theme: "nope", appearance: "sepia" });
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.appearance).toBe(DEFAULT_SETTINGS.appearance);
    expect(normalizeSettings({ theme: "forest", appearance: "light" })).toMatchObject({ theme: "forest", appearance: "light" });
  });
  test("an old settings file's default Blue does not override a theme accent", () => {
    expect(normalizeSettings({ accent: "Blue" }).accent).toBe("Auto");
    expect(normalizeSettings({ accent: "Violet" }).accent).toBe("Violet");
    expect(normalizeSettings({ theme: "forest", accent: "Blue" }).accent).toBe("Blue");
  });
  test("accentOverride", () => {
    expect(accentOverride("Auto")).toBeNull();
    expect(accentOverride("Blue")).toBe("#3b82f6");
  });
});
