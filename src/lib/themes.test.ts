import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME, effectiveAppearance, hexToRgb, inkFor, monacoTheme, paletteOf, THEMES, themeById, themeVars, type Appearance } from "./themes";

const MODES: Appearance[] = ["dark", "light"];
const luminance = (hex: string) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("themes", () => {
  test("ids are unique and the default exists", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(themeById(DEFAULT_THEME).id).toBe(DEFAULT_THEME);
    expect(themeById("nope").id).toBe(THEMES[0].id);
  });

  test("every theme defines the same set of variables in every appearance", () => {
    const keys = Object.keys(themeVars("midnight", "dark", null)).sort();
    for (const theme of THEMES) {
      for (const mode of MODES) {
        expect(Object.keys(themeVars(theme.id, mode, null)).sort()).toEqual(keys);
      }
    }
  });

  test("palette colors are valid hex and text is readable on every surface", () => {
    for (const theme of THEMES) {
      for (const mode of MODES) {
        const palette = theme.palettes[mode];
        if (!palette) continue;
        for (const [name, value] of Object.entries(palette)) expect(value, `${theme.id}/${mode}/${name}`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrast(palette.text, palette.bg), `${theme.id}/${mode} text on bg`).toBeGreaterThan(7);
        expect(contrast(palette.text, palette.panel), `${theme.id}/${mode} text on panel`).toBeGreaterThan(7);
        expect(contrast(palette.dim, palette.panel), `${theme.id}/${mode} dim on panel`).toBeGreaterThan(3);
        expect(contrast(palette.ink, palette.accent), `${theme.id}/${mode} ink on accent`).toBeGreaterThan(3.5);
      }
    }
  });

  test("a theme without the requested appearance falls back to the one it has", () => {
    expect(effectiveAppearance(themeById("midnight"), "light")).toBe("dark");
    expect(effectiveAppearance(themeById("forest"), "light")).toBe("light");
    expect(paletteOf(themeById("midnight"), "light").appearance).toBe("dark");
  });

  test("accent override replaces accent variables and picks a readable ink", () => {
    const v = themeVars("forest", "dark", "#f59e0b");
    expect(v["--accent"]).toBe("#f59e0b");
    expect(v["--accent-rgb"]).toBe("245, 158, 11");
    expect(v["--accent-ink"]).toBe("#111111");
    expect(inkFor("#1c6b43")).toBe("#ffffff");
    const own = themeVars("forest", "dark", null);
    expect(own["--accent"]).toBe("#2f9461");
    const strong = own["--accent-strong-rgb"].split(", ").map(Number);
    expect(strong.every((c, i) => c < hexToRgb("#2f9461")[i])).toBe(true);
  });

  test("midnight keeps the original gradients; flat themes use solid surfaces", () => {
    expect(themeVars("midnight", "dark", null)["--bg-app"]).toContain("linear-gradient");
    expect(themeVars("midnight", "dark", null)["--accent"]).toBe("#3b82f6");
    expect(themeVars("graphite", "dark", null)["--bg-app"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(themeVars("graphite", "dark", null)["--accent-glow"]).toBe("none");
  });

  test("flat dark themes layer surfaces: window < panel < raised, inputs sunk below the panel", () => {
    for (const theme of THEMES.filter((t) => t.style === "flat")) {
      const { palette: p, appearance } = paletteOf(theme, "dark");
      if (appearance !== "dark") continue;
      expect(luminance(p.bg), theme.id).toBeLessThan(luminance(p.panel));
      expect(luminance(p.panel), theme.id).toBeLessThan(luminance(p.panel2));
      expect(luminance(p.code), theme.id).toBeLessThan(luminance(p.panel));
    }
  });

  test("monaco themes: valid names, hex colors only", () => {
    for (const theme of THEMES) {
      for (const mode of MODES) {
        const m = monacoTheme(theme.id, mode, null);
        expect(m.name).toMatch(/^sauron-[a-z]+-(dark|light)$/);
        for (const value of Object.values(m.colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
        for (const rule of m.rules) expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/i);
      }
    }
  });
});
