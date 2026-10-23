/**
 * Color themes. A theme is a palette per appearance (dark / light) turned into CSS custom properties that the
 * stylesheets use everywhere (see styles/base.css for the token list). `midnight` is the original glassy look
 * (gradients, big radii, glow); every other theme is "flat": solid surfaces, hairline borders, small radii, no glow.
 */
export type Appearance = "dark" | "light";
export type AppearanceSetting = Appearance | "system";
export type ThemeStyle = "glass" | "flat";

export interface Palette {
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  /** Text on top of the accent color. */
  ink: string;
  /** Editor and input background. */
  code: string;
  btn: string;
  btnBorder: string;
  ok: string;
  warn: string;
  err: string;
  /** Syntax: keyword, string, number, comment, function. */
  k: string;
  s: string;
  n: string;
  c: string;
  fn: string;
  /** Search hit background. */
  hl: string;
}

export interface ThemeDef {
  id: string;
  name: string;
  blurb: string;
  style: ThemeStyle;
  /** Radius scale, applied to every rounded corner except panels (see --rs). */
  radius: number;
  panelRadius: number;
  palettes: { dark?: Palette; light?: Palette };
}

const OK_DARK = "#6cc08c";
const WARN_DARK = "#d6ab4a";
const ERR_DARK = "#e07a6b";
const OK_LIGHT = "#2e8a55";
const WARN_LIGHT = "#9a7410";
const ERR_LIGHT = "#bd4a39";
const HL_DARK = "#5b4b00";
const HL_LIGHT = "#fff1a8";

/** The greens share status colors and a skeleton; only neutrals, accent and syntax differ. */
const green = (
  mode: Appearance,
  p: Pick<Palette, "bg" | "panel" | "panel2" | "line" | "text" | "dim" | "faint" | "accent" | "ink" | "code" | "btn" | "btnBorder" | "k" | "s" | "n" | "c" | "fn">,
): Palette =>
  mode === "dark"
    ? { ...p, ok: OK_DARK, warn: WARN_DARK, err: ERR_DARK, hl: HL_DARK }
    : { ...p, ok: OK_LIGHT, warn: WARN_LIGHT, err: ERR_LIGHT, hl: HL_LIGHT };

export const THEMES: ThemeDef[] = [
  {
    id: "midnight",
    name: "Midnight",
    blurb: "The original: navy gradients, floating rounded panels, soft glow.",
    style: "glass",
    radius: 1,
    panelRadius: 16,
    palettes: {
      dark: {
        bg: "#0f0f23", panel: "#1a1a2e", panel2: "#16213e", line: "#2b3552", text: "#e2e8f0", dim: "#94a3b8", faint: "#64748b",
        accent: "#3b82f6", ink: "#ffffff", code: "#0f0f23", btn: "#334155", btnBorder: "#475569",
        ok: "#4ade80", warn: "#fbbf24", err: "#f87171",
        k: "#569cd6", s: "#ce9178", n: "#b5cea8", c: "#6a9955", fn: "#dcdcaa", hl: "#7c3d12",
      },
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    blurb: "Warm neutral grays with one amber accent. Flat, hairline borders.",
    style: "flat",
    radius: 0.8,
    panelRadius: 14,
    palettes: {
      dark: {
        bg: "#141414", panel: "#1a1a19", panel2: "#201f1e", line: "#2b2a28", text: "#e7e3da", dim: "#8c877c", faint: "#5f5b53",
        accent: "#e8a33d", ink: "#1b1206", code: "#171716", btn: "#242321", btnBorder: "#34332f",
        ok: "#8bb174", warn: "#e8a33d", err: "#e07a67",
        k: "#e8a33d", s: "#9cc08a", n: "#d8a7c9", c: "#6a665c", fn: "#8fb4c9", hl: HL_DARK,
      },
      light: {
        bg: "#f3f2ee", panel: "#fbfaf7", panel2: "#f1efe9", line: "#dfdcd2", text: "#201f1b", dim: "#7b776c", faint: "#aaa597",
        accent: "#b8690a", ink: "#ffffff", code: "#fdfcfa", btn: "#ffffff", btnBorder: "#d7d3c7",
        ok: "#4f7d3a", warn: "#b8690a", err: "#bf4b36",
        k: "#b8690a", s: "#4f7d3a", n: "#92407a", c: "#a8a395", fn: "#2f6788", hl: HL_LIGHT,
      },
    },
  },
  {
    id: "slate",
    name: "Slate",
    blurb: "Cool, low-saturation grays with a muted teal. Calm and clinical.",
    style: "flat",
    radius: 0.8,
    panelRadius: 14,
    palettes: {
      dark: {
        bg: "#101316", panel: "#15191d", panel2: "#1a1f24", line: "#262d34", text: "#d9dfe5", dim: "#7a8794", faint: "#515c67",
        accent: "#3fbfae", ink: "#04201c", code: "#12161a", btn: "#1d2329", btnBorder: "#2d353d",
        ok: "#5cc08a", warn: "#d9b44a", err: "#e5726a",
        k: "#3fbfae", s: "#a3c97d", n: "#e0a370", c: "#556270", fn: "#7fb2e0", hl: HL_DARK,
      },
      light: {
        bg: "#edf0f2", panel: "#f8f9fa", panel2: "#eceff2", line: "#d6dce1", text: "#1b242b", dim: "#68757f", faint: "#9aa5ae",
        accent: "#0f766e", ink: "#ffffff", code: "#fcfdfd", btn: "#ffffff", btnBorder: "#cdd4da",
        ok: "#2f8a57", warn: "#a07a12", err: "#c2453d",
        k: "#0f766e", s: "#4d7d22", n: "#a65b1f", c: "#9aa5ae", fn: "#2a6aa8", hl: HL_LIGHT,
      },
    },
  },
  {
    id: "paper",
    name: "Paper",
    blurb: "Ink on warm white, no hue in the chrome. Color only for status and data.",
    style: "flat",
    radius: 0.6,
    panelRadius: 10,
    palettes: {
      light: {
        bg: "#fafaf8", panel: "#ffffff", panel2: "#f6f5f1", line: "#e5e3dc", text: "#191919", dim: "#78766f", faint: "#b0aea5",
        accent: "#191919", ink: "#ffffff", code: "#ffffff", btn: "#ffffff", btnBorder: "#d6d4cc",
        ok: "#3f7d4e", warn: "#9a6b00", err: "#b53a2d",
        k: "#191919", s: "#3f7d4e", n: "#9a6b00", c: "#a3a198", fn: "#3b5b8c", hl: HL_LIGHT,
      },
      dark: {
        bg: "#101010", panel: "#161616", panel2: "#1c1c1c", line: "#292929", text: "#ececec", dim: "#8b8b8b", faint: "#5a5a5a",
        accent: "#ececec", ink: "#101010", code: "#141414", btn: "#1f1f1f", btnBorder: "#333333",
        ok: "#7fb48c", warn: "#d6ab4a", err: "#e0786b",
        k: "#ececec", s: "#7fb48c", n: "#d6ab4a", c: "#5f5f5f", fn: "#8fa9d6", hl: HL_DARK,
      },
    },
  },
  {
    id: "forest",
    name: "Forest",
    blurb: "Deep green on a green-tinted near-black. Classic, a bit terminal-like.",
    style: "flat",
    radius: 0.8,
    panelRadius: 14,
    palettes: {
      dark: green("dark", { bg: "#0c110f", panel: "#111815", panel2: "#161f1b", line: "#202e27", text: "#d5dfd9", dim: "#7a8f84", faint: "#506258", accent: "#2f9461", ink: "#f0fff6", code: "#0f1512", btn: "#19231f", btnBorder: "#27372f", k: "#4fb584", s: "#c9b672", n: "#d69e6a", c: "#566e62", fn: "#7fb3c9" }),
      light: green("light", { bg: "#edf2ee", panel: "#f8faf8", panel2: "#e9efeb", line: "#d2ddd6", text: "#16221b", dim: "#62766a", faint: "#98a89f", accent: "#1c6b43", ink: "#ffffff", code: "#fcfdfc", btn: "#ffffff", btnBorder: "#c8d5cc", k: "#1c6b43", s: "#8a6d12", n: "#a65b1f", c: "#9aaca1", fn: "#2a6a8e" }),
    },
  },
  {
    id: "emerald",
    name: "Emerald",
    blurb: "Bluer, more saturated jade. Brighter, still calm.",
    style: "flat",
    radius: 0.8,
    panelRadius: 14,
    palettes: {
      dark: green("dark", { bg: "#0a1210", panel: "#0f1a17", panel2: "#14211d", line: "#1d322b", text: "#d3e4dd", dim: "#759089", faint: "#4d665d", accent: "#1eab7b", ink: "#03140d", code: "#0c1512", btn: "#16261f", btnBorder: "#244037", k: "#35c595", s: "#d2c27c", n: "#e0a070", c: "#4f6c61", fn: "#78b7d4" }),
      light: green("light", { bg: "#ecf4f1", panel: "#f7fbf9", panel2: "#e5f0ec", line: "#cde0d8", text: "#12231d", dim: "#5c7a70", faint: "#92aaa1", accent: "#0d8a61", ink: "#ffffff", code: "#fbfefd", btn: "#ffffff", btnBorder: "#c3dacf", k: "#0d8a61", s: "#8a6d12", n: "#a65b1f", c: "#9ab3a9", fn: "#2a6a8e" }),
    },
  },
  {
    id: "moss",
    name: "Moss",
    blurb: "Yellow-leaning olive. Earthy and warm, the least “tech” of the greens.",
    style: "flat",
    radius: 0.8,
    panelRadius: 14,
    palettes: {
      dark: green("dark", { bg: "#10120d", panel: "#161911", panel2: "#1c2016", line: "#2a2f1f", text: "#dcdfcd", dim: "#8a9074", faint: "#5d6350", accent: "#8aa63a", ink: "#10150a", code: "#12150e", btn: "#20241a", btnBorder: "#333a26", k: "#a6c04e", s: "#d8bb78", n: "#d99a68", c: "#5f664d", fn: "#86b0c4" }),
      light: green("light", { bg: "#f1f2ea", panel: "#fafaf5", panel2: "#eceee2", line: "#d9dcc8", text: "#1d2015", dim: "#6d7457", faint: "#a1a68c", accent: "#5f7a1c", ink: "#ffffff", code: "#fdfdf9", btn: "#ffffff", btnBorder: "#d0d4bb", k: "#5f7a1c", s: "#8a6d12", n: "#a65b1f", c: "#a3a88f", fn: "#2a6a8e" }),
    },
  },
  {
    id: "mint",
    name: "Mint",
    blurb: "Neutral charcoal with a light mint accent. The lightest, most modern green.",
    style: "flat",
    radius: 0.8,
    panelRadius: 14,
    palettes: {
      dark: green("dark", { bg: "#121413", panel: "#181b19", panel2: "#1d211f", line: "#2a2f2c", text: "#e0e6e2", dim: "#86918a", faint: "#58625c", accent: "#6fd3a4", ink: "#08150e", code: "#141715", btn: "#222725", btnBorder: "#333a36", k: "#6fd3a4", s: "#d9c27d", n: "#e3a374", c: "#5d6962", fn: "#86b6d6" }),
      light: green("light", { bg: "#f1f4f2", panel: "#fafbfa", panel2: "#ebefec", line: "#d8dfda", text: "#181f1b", dim: "#66736b", faint: "#9aa6a0", accent: "#1a8a5c", ink: "#ffffff", code: "#ffffff", btn: "#ffffff", btnBorder: "#cdd6d0", k: "#1a8a5c", s: "#8a6d12", n: "#a65b1f", c: "#a0aca5", fn: "#2a6a8e" }),
    },
  },
  {
    id: "sage",
    name: "Sage",
    blurb: "Desaturated gray-green. Green is a hint, not a color.",
    style: "flat",
    radius: 0.8,
    panelRadius: 14,
    palettes: {
      dark: green("dark", { bg: "#141715", panel: "#1a1e1b", panel2: "#1f2421", line: "#2b312d", text: "#dde3de", dim: "#8a968e", faint: "#5c675f", accent: "#94b5a0", ink: "#0f1612", code: "#161a17", btn: "#232925", btnBorder: "#343c37", k: "#94b5a0", s: "#cdbb8a", n: "#d4a584", c: "#5e6b63", fn: "#8db0c7" }),
      light: green("light", { bg: "#f0f3f0", panel: "#f9faf9", panel2: "#eaeeea", line: "#d6ddd7", text: "#1a201c", dim: "#67746b", faint: "#9aa59e", accent: "#52735e", ink: "#ffffff", code: "#fdfdfd", btn: "#ffffff", btnBorder: "#cbd4cd", k: "#52735e", s: "#8a6d12", n: "#a65b1f", c: "#a0aca5", fn: "#2a6a8e" }),
    },
  },
];

export type ThemeId = string;
export const DEFAULT_THEME: ThemeId = "midnight";
export const THEME_IDS = THEMES.map((t) => t.id);

export const themeById = (id: string): ThemeDef => THEMES.find((t) => t.id === id) ?? THEMES[0];

/** The appearance a theme actually renders in: the requested one if it has it, otherwise the one it does have. */
export function effectiveAppearance(theme: ThemeDef, wanted: Appearance): Appearance {
  if (theme.palettes[wanted]) return wanted;
  return theme.palettes.dark ? "dark" : "light";
}

export const hasAppearance = (theme: ThemeDef, mode: Appearance) => Boolean(theme.palettes[mode]);

/**
 * Flat themes have no outlines to separate neighbouring surfaces, so the layers are pushed apart in lightness:
 * window < panels < raised things (buttons, menus), with inputs and the editor sunk below the panel.
 */
function layered(p: Palette, appearance: Appearance): Palette {
  const rgb = hexToRgb(p.panel);
  if (appearance === "dark") {
    return {
      ...p,
      bg: toHex(mixToward(hexToRgb(p.bg), 0, 0.6)),
      panel: toHex(mixToward(rgb, 255, 0.07)),
      panel2: toHex(mixToward(rgb, 255, 0.17)),
      code: toHex(mixToward(rgb, 0, 0.55)),
      btn: toHex(mixToward(rgb, 255, 0.15)),
    };
  }
  return {
    ...p,
    bg: toHex(mixToward(hexToRgb(p.bg), 0, 0.05)),
    panel2: toHex(mixToward(rgb, 0, 0.04)),
    code: toHex(mixToward(rgb, 0, 0.035)),
  };
}

export function paletteOf(theme: ThemeDef, wanted: Appearance): { palette: Palette; appearance: Appearance } {
  const appearance = effectiveAppearance(theme, wanted);
  const raw = (theme.palettes[appearance] ?? theme.palettes.dark ?? theme.palettes.light)!;
  return { palette: theme.style === "flat" ? layered(raw, appearance) : raw, appearance };
}

// --- color helpers ------------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
/** Mix toward a gray level (0 = black, 255 = white). */
const mixToward = (rgb: number[], level: number, amount: number) => rgb.map((v) => v + (level - v) * amount);

const luminance = ([r, g, b]: number[]) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** Readable text color for a given background: dark ink on light colors, white on dark ones. */
export const inkFor = (hex: string) => (luminance(hexToRgb(hex)) > 0.4 ? "#111111" : "#ffffff");

/** `#rrggbb` + alpha (0..1) -> `#rrggbbaa` (Monaco does not understand color-mix or rgba()). */
export const withAlpha = (hex: string, alpha: number) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;

const mix = (a: string, b: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
const soft = (color: string, pct: number) => mix(color, "transparent", pct);

// --- CSS variables ------------------------------------------------------------------------------

/** Accent-derived variables. `override` is a user-picked color; null uses the theme's own accent. */
function accentVars(theme: ThemeDef, palette: Palette, appearance: Appearance, override: string | null): Record<string, string> {
  const hex = override ?? palette.accent;
  const base = hexToRgb(hex);
  const strong = mixToward(base, 0, 0.35);
  // Accent used as text color: lifted on dark backgrounds, deepened on light ones.
  const text = override || theme.style === "glass" ? toHex(mixToward(base, appearance === "dark" ? 255 : 0, appearance === "dark" ? 0.3 : 0.15)) : hex;
  const ink = override ? inkFor(hex) : palette.ink;
  const glass = theme.style === "glass";
  return {
    "--accent": hex,
    "--accent-strong": toHex(strong),
    "--accent-soft": text,
    "--accent-rgb": base.join(", "),
    "--accent-strong-rgb": strong.join(", "),
    "--accent-ink": ink,
    "--accent-fill": glass ? "linear-gradient(135deg, var(--accent), var(--accent-strong))" : "var(--accent)",
    "--accent-glow": glass ? "0 4px 16px rgba(var(--accent-rgb), 0.3)" : "none",
    "--accent-glow-hover": glass ? "0 8px 25px rgba(var(--accent-rgb), 0.4)" : "none",
  };
}

const GLASS_VARS: Record<string, string> = {
  "--bg-app": "linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%)",
  "--panel-bg": "linear-gradient(135deg, rgba(26, 26, 46, 0.9), rgba(22, 33, 62, 0.9))",
  "--popover-bg": "linear-gradient(135deg, rgba(26, 26, 46, 0.95), rgba(22, 33, 62, 0.95))",
  "--modal-bg": "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
  "--menu-bg": "rgba(15, 23, 42, 0.96)",
  "--field-bg": "rgba(15, 15, 35, 0.8)",
  "--field-bg-solid": "rgba(15, 15, 35, 1)",
  "--editor-bg": "rgba(15, 15, 35, 0.9)",
  "--sunk-bg": "rgba(15, 23, 42, 0.6)",
  "--fill-soft": "rgba(51, 65, 85, 0.3)",
  "--fill": "rgba(51, 65, 85, 0.6)",
  "--fill-hover": "rgba(71, 85, 105, 0.8)",
  "--btn-bg": "linear-gradient(135deg, rgba(51, 65, 85, 0.8), rgba(71, 85, 105, 0.8))",
  "--line": "rgba(148, 163, 184, 0.2)",
  "--line-strong": "rgba(148, 163, 184, 0.3)",
  "--line-faint": "rgba(148, 163, 184, 0.1)",
  "--edge-w": "1px",
  "--edge-mix": "40",
  "--panel-line": "rgba(148, 163, 184, 0.2)",
  "--edge": "rgba(148, 163, 184, 0.3)",
  "--divider": "rgba(148, 163, 184, 0.2)",
  "--hover": "rgba(148, 163, 184, 0.12)",
  "--hover-strong": "rgba(148, 163, 184, 0.2)",
  "--text-strong": "#f1f5f9",
  "--text": "#e2e8f0",
  "--dim": "#94a3b8",
  "--faint": "#64748b",
  "--ok": "#4ade80",
  "--warn": "#fbbf24",
  "--err": "#f87171",
  "--err-text": "#fca5a5",
  "--info": "#67e8f9",
  "--violet": "#c084fc",
  "--sel-bg": "linear-gradient(135deg, rgba(6, 182, 212, 0.3), rgba(8, 145, 178, 0.3))",
  "--sel-bar": "#06b6d4",
  "--sel-fg": "#67e8f9",
  "--hit-bg": "rgba(249, 115, 22, 0.35)",
  "--hit-fg": "#fed7aa",
  "--j-key": "#67e8f9",
  "--j-str": "#9ccc65",
  "--j-num": "#f78c6c",
  "--j-bool": "#fbbf24",
  "--j-null": "#64748b",
  "--save-fill": "linear-gradient(135deg, #10b981, #059669)",
  "--save-glow": "0 4px 16px rgba(16, 185, 129, 0.3)",
  "--save-glow-hover": "0 8px 25px rgba(16, 185, 129, 0.4)",
  "--save-fill-hover": "linear-gradient(135deg, #10b981, #059669)",
  "--save-ink": "#ffffff",
  "--save-border": "transparent",
  "--float-bg": "linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.94)), rgba(2, 6, 23, 0.9)",
  "--float-border": "rgba(56, 189, 248, 0.22)",
  "--float-glow": "0 0 19px 10px #10b981",
  "--halo": "block",
  "--icon-bg": "linear-gradient(135deg, rgba(8, 145, 178, 0.22), rgba(14, 116, 144, 0.08))",
  "--tray-bg": "#232a47",
  "--ring-gap": "#16213e",
  "--glow": "1",
  "--danger-fill": "linear-gradient(135deg, #ef4444, #b91c1c)",
  "--danger-glow": "0 4px 16px rgba(239, 68, 68, 0.3)",
  "--shadow-pop": "0 8px 24px rgba(0, 0, 0, 0.4)",
  "--shadow-modal": "0 20px 60px rgba(0, 0, 0, 0.5)",
  "--rs": "1",
  "--r-panel": "16px",
  "--lift": "-2px",
  "--caps": "uppercase",
  "--track": "1",
  "--font-ui": '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--layout-gap": "10px",
  "--app-inline-padding": "10px",
  "--app-bottom-padding": "10px",
  "--handle-bg": "#64748b",
  "--handle-border": "rgba(148, 163, 184, 0.75)",
  "--handle-hover": "#94a3b8",
};

function flatVars(theme: ThemeDef, p: Palette, appearance: Appearance): Record<string, string> {
  const dark = appearance === "dark";
  return {
    "--bg-app": p.bg,
    "--panel-bg": p.panel,
    "--popover-bg": p.panel2,
    "--modal-bg": p.panel,
    "--menu-bg": p.panel2,
    "--field-bg": p.code,
    "--field-bg-solid": p.code,
    "--editor-bg": p.code,
    "--sunk-bg": p.code,
    "--fill-soft": p.panel2,
    "--fill": p.btn,
    "--fill-hover": mix(p.btn, p.text, 90),
    "--btn-bg": p.btn,
    "--line": p.line,
    "--line-strong": p.btnBorder,
    "--line-faint": soft(p.line, 60),
    // Fewer outlines: on dark themes panels and controls are told apart by their fill alone; light themes keep a soft edge.
    // Status cards (errors, warnings, callouts) are the one place outlines stay, so they get a heavier one.
    "--edge-w": "2px",
    "--edge-mix": "55",
    "--panel-line": dark ? "transparent" : p.line,
    "--edge": dark ? "transparent" : p.line,
    "--divider": soft(p.line, 55),
    "--hover": soft(p.text, 6),
    "--hover-strong": soft(p.text, 11),
    "--text-strong": p.text,
    "--text": p.text,
    "--dim": p.dim,
    "--faint": p.faint,
    "--ok": p.ok,
    "--warn": p.warn,
    "--err": p.err,
    "--err-text": p.err,
    "--info": p.fn,
    "--violet": p.k,
    "--sel-bg": "color-mix(in srgb, var(--accent) 16%, transparent)",
    "--sel-bar": "var(--accent)",
    "--sel-fg": "var(--text)",
    "--hit-bg": p.hl,
    "--hit-fg": p.text,
    "--j-key": p.fn,
    "--j-str": p.s,
    "--j-num": p.n,
    "--j-bool": p.k,
    "--j-null": p.faint,
    "--save-fill": p.btn,
    // Used inside a multi-value box-shadow, where a bare `none` would invalidate the whole declaration.
    "--save-glow": "0 0 0 0 transparent",
    "--save-glow-hover": "0 0 0 0 transparent",
    "--save-fill-hover": "var(--fill-hover)",
    "--save-ink": p.text,
    "--save-border": dark ? "transparent" : p.line,
    "--float-bg": p.panel2,
    "--float-border": p.btnBorder,
    "--float-glow": dark ? "0 8px 24px rgba(0, 0, 0, 0.5)" : "0 8px 24px rgba(20, 20, 10, 0.18)",
    "--halo": "none",
    "--icon-bg": soft(p.accent, 14),
    "--tray-bg": p.panel2,
    "--ring-gap": p.panel,
    "--glow": "0",
    "--danger-fill": p.err,
    "--danger-glow": "none",
    "--shadow-pop": dark ? "0 6px 18px rgba(0, 0, 0, 0.45)" : "0 6px 18px rgba(20, 20, 10, 0.14)",
    "--shadow-modal": dark ? "0 16px 40px rgba(0, 0, 0, 0.55)" : "0 16px 40px rgba(20, 20, 10, 0.2)",
    "--rs": String(theme.radius),
    "--r-panel": `${theme.panelRadius}px`,
    "--lift": "0px",
    "--caps": "none",
    "--track": "0",
    "--font-ui": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    "--layout-gap": "8px",
    "--app-inline-padding": "8px",
    "--app-bottom-padding": "8px",
    "--handle-bg": p.faint,
    "--handle-border": p.dim,
    "--handle-hover": p.dim,
  };
}

/** Every custom property a theme sets. `accent` is a user-picked color (hex) or null for the theme's own. */
export function themeVars(themeId: string, wanted: Appearance, accent: string | null): Record<string, string> {
  const theme = themeById(themeId);
  const { palette, appearance } = paletteOf(theme, wanted);
  const base = theme.style === "glass" ? GLASS_VARS : flatVars(theme, palette, appearance);
  return { ...base, ...accentVars(theme, palette, appearance, accent), "color-scheme": appearance };
}

// --- Monaco -------------------------------------------------------------------------------------

export interface MonacoThemeData {
  name: string;
  base: "vs" | "vs-dark";
  rules: { token: string; foreground: string }[];
  colors: Record<string, string>;
}

const noHash = (hex: string) => hex.replace("#", "");

export function monacoTheme(themeId: string, wanted: Appearance, accent: string | null): MonacoThemeData {
  const theme = themeById(themeId);
  const { palette: p, appearance } = paletteOf(theme, wanted);
  const base = appearance === "dark" ? "vs-dark" : "vs";
  const name = `sauron-${theme.id}-${appearance}`;
  if (theme.style === "glass") {
    // Exactly the editor look from before themes existed: VS Code "Dark+" tokens, default surface.
    return {
      name,
      base,
      rules: [
        { token: "comment", foreground: "6a9955" },
        { token: "keyword", foreground: "569cd6" },
        { token: "number", foreground: "b5cea8" },
        { token: "string", foreground: "ce9178" },
        { token: "predefined", foreground: "dcdcaa" },
        { token: "type", foreground: "4ec9b0" },
        { token: "identifier", foreground: "9cdcfe" },
        { token: "operator", foreground: "d4d4d4" },
      ],
      colors: {},
    };
  }
  const accentHex = accent ?? p.accent;
  return {
    name,
    base,
    rules: [
      { token: "comment", foreground: noHash(p.c) },
      { token: "keyword", foreground: noHash(p.k) },
      { token: "number", foreground: noHash(p.n) },
      { token: "string", foreground: noHash(p.s) },
      { token: "predefined", foreground: noHash(p.fn) },
      { token: "type", foreground: noHash(p.fn) },
      { token: "identifier", foreground: noHash(p.text) },
      { token: "operator", foreground: noHash(p.dim) },
    ],
    colors: {
      "editor.background": p.code,
      "editor.foreground": p.text,
      "editorCursor.foreground": accentHex,
      "editor.selectionBackground": withAlpha(accentHex, 0.32),
      "editor.inactiveSelectionBackground": withAlpha(accentHex, 0.18),
      "editor.selectionHighlightBackground": withAlpha(accentHex, 0.16),
      "editor.findMatchHighlightBackground": withAlpha(p.hl.length === 7 ? p.hl : "#808000", 0.8),
      "editorLineNumber.foreground": p.faint,
      "editorLineNumber.activeForeground": p.dim,
      "editorWhitespace.foreground": p.line,
      "editorIndentGuide.background1": p.line,
      "editorSuggestWidget.background": p.panel2,
      "editorSuggestWidget.border": p.line,
      "editorSuggestWidget.foreground": p.text,
      "editorSuggestWidget.selectedBackground": withAlpha(accentHex, 0.22),
      "editorSuggestWidget.highlightForeground": accentHex,
      "editorWidget.background": p.panel2,
      "editorWidget.border": p.line,
      "editorHoverWidget.background": p.panel2,
      "editorHoverWidget.border": p.line,
      "scrollbarSlider.background": withAlpha(p.faint, 0.3),
      "scrollbarSlider.hoverBackground": withAlpha(p.faint, 0.5),
    },
  };
}
