/**
 * Themes, MonkeyType-style: a wall of presets plus one custom slot.
 *
 * The app's palette is CSS variables (`--color-*`, see globals.css), so a
 * theme is just var overrides on `:root` — no reload, no class swapping,
 * and every component picks it up instantly. Each preset is four seeds
 * (background, surface, text, accent); the full 21-var palette is derived
 * with `color-mix` so presets stay harmonious by construction. Anything a
 * seed recipe gets wrong for a specific theme lands in `overrides`.
 *
 * Kept free of Node-only APIs: Settings renders the wall, page.tsx applies.
 */

export interface ThemeDef {
  id: string;
  name: string;
  /** Page background. */
  bg: string;
  /** Cards, modals, elevated panels. */
  surface: string;
  /** Primary text. */
  text: string;
  /** The one accent: send button, active states, links. */
  accent: string;
  /** Full var names (`--color-danger`) for whatever the recipe misses. */
  overrides?: Record<string, string>;
}

export interface CustomThemeSeeds {
  bg: string;
  surface: string;
  text: string;
  accent: string;
}

/** Derive the full palette from four seeds. */
export function themeVars(
  seeds: Pick<ThemeDef, "bg" | "surface" | "text" | "accent">,
  overrides?: Record<string, string>
): Record<string, string> {
  const { bg, surface, text, accent } = seeds;
  const vars: Record<string, string> = {
    "--color-bg-primary": bg,
    "--color-bg-secondary": `color-mix(in oklab, ${bg} 90%, ${text})`,
    "--color-bg-tertiary": `color-mix(in oklab, ${bg} 78%, ${surface})`,
    "--color-bg-elevated": surface,
    "--color-bg-hover": `color-mix(in oklab, ${surface} 80%, ${text})`,
    "--color-border": `color-mix(in oklab, ${surface} 76%, ${text})`,
    "--color-border-light": `color-mix(in oklab, ${surface} 60%, ${text})`,
    "--color-text-primary": text,
    "--color-text-secondary": `color-mix(in oklab, ${text} 70%, ${bg})`,
    "--color-text-muted": `color-mix(in oklab, ${text} 46%, ${bg})`,
    "--color-accent": accent,
    "--color-accent-light": `color-mix(in oklab, ${accent} 78%, ${text})`,
    "--color-accent-glow": `color-mix(in oklab, ${accent} 14%, transparent)`,
    "--color-success": "#7ba478",
    "--color-warning": "#cfa25a",
    "--color-danger": "#cf6a5f",
    "--color-info": "#6f98bd",
    "--color-search": "#6ba3a0",
    "--color-search-glow": "rgba(107, 163, 160, 0.12)",
    "--color-thinking": "#cfa25a",
    "--color-thinking-glow": "rgba(207, 162, 90, 0.12)",
  };
  if (overrides) Object.assign(vars, overrides);
  return vars;
}

/**
 * The stock look, as full overrides — pixel-identical to the stylesheet's
 * own values, so selecting it is provably a no-op.
 */
const APIM_VARS: Record<string, string> = {
  "--color-bg-primary": "#191715",
  "--color-bg-secondary": "#141210",
  "--color-bg-tertiary": "#201e1b",
  "--color-bg-elevated": "#2a2723",
  "--color-bg-hover": "#33302a",
  "--color-border": "#2c2924",
  "--color-border-light": "#403c34",
  "--color-text-primary": "#ede9e2",
  "--color-text-secondary": "#a29d92",
  "--color-text-muted": "#6d685d",
  "--color-accent": "#c96442",
  "--color-accent-light": "#d97f5d",
  "--color-accent-glow": "rgba(201, 100, 66, 0.14)",
  "--color-success": "#7ba478",
  "--color-warning": "#cfa25a",
  "--color-danger": "#cf6a5f",
  "--color-info": "#6f98bd",
  "--color-search": "#6ba3a0",
  "--color-search-glow": "rgba(107, 163, 160, 0.12)",
  "--color-thinking": "#cfa25a",
  "--color-thinking-glow": "rgba(207, 162, 90, 0.12)",
};

export const DEFAULT_THEME_ID = "apim";

export const THEMES: ThemeDef[] = [
  {
    id: "apim",
    name: "apiM",
    bg: "#191715",
    surface: "#2a2723",
    text: "#ede9e2",
    accent: "#c96442",
    overrides: APIM_VARS,
  },
  {
    id: "serika",
    name: "Serika Dark",
    bg: "#323437",
    surface: "#3d3f43",
    text: "#d1d0c5",
    accent: "#e2b714",
  },
  {
    id: "nord",
    name: "Nord",
    bg: "#2e3440",
    surface: "#3b4252",
    text: "#eceff4",
    accent: "#88c0d0",
    overrides: {
      "--color-success": "#a3be8c",
      "--color-warning": "#ebcb8b",
      "--color-danger": "#bf616a",
      "--color-thinking": "#ebcb8b",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    bg: "#282a36",
    surface: "#343746",
    text: "#f8f8f2",
    accent: "#bd93f9",
    overrides: {
      "--color-success": "#50fa7b",
      "--color-warning": "#f1fa8c",
      "--color-danger": "#ff5555",
      "--color-search": "#8be9fd",
      "--color-thinking": "#ffb86c",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    bg: "#282828",
    surface: "#3c3836",
    text: "#ebdbb2",
    accent: "#fabd2f",
    overrides: {
      "--color-success": "#b8bb26",
      "--color-warning": "#fabd2f",
      "--color-danger": "#fb4934",
      "--color-search": "#8ec07c",
      "--color-thinking": "#fe8019",
    },
  },
  {
    id: "tokyo",
    name: "Tokyo Night",
    bg: "#1a1b26",
    surface: "#24283b",
    text: "#c0caf5",
    accent: "#7aa2f7",
    overrides: {
      "--color-success": "#9ece6a",
      "--color-warning": "#e0af68",
      "--color-danger": "#f7768e",
      "--color-search": "#7dcfff",
      "--color-thinking": "#bb9af7",
    },
  },
  {
    id: "mocha",
    name: "Catppuccin",
    bg: "#1e1e2e",
    surface: "#313244",
    text: "#cdd6f4",
    accent: "#cba6f7",
    overrides: {
      "--color-success": "#a6e3a1",
      "--color-warning": "#f9e2af",
      "--color-danger": "#f38ba8",
      "--color-search": "#89dceb",
      "--color-thinking": "#fab387",
    },
  },
  {
    id: "everforest",
    name: "Everforest",
    bg: "#2d353b",
    surface: "#3d484d",
    text: "#d3c6aa",
    accent: "#a7c080",
    overrides: {
      "--color-success": "#a7c080",
      "--color-warning": "#e69875",
      "--color-danger": "#e67e80",
      "--color-search": "#7fbbb3",
      "--color-thinking": "#e69875",
    },
  },
  {
    id: "rosepine",
    name: "Rosé Pine",
    bg: "#191724",
    surface: "#26233a",
    text: "#e0def4",
    accent: "#eb6f92",
    overrides: {
      "--color-success": "#9ccfd8",
      "--color-warning": "#f6c177",
      "--color-danger": "#eb6f92",
      "--color-search": "#9ccfd8",
      "--color-thinking": "#f6c177",
    },
  },
  {
    id: "solarized",
    name: "Solarized",
    bg: "#002b36",
    surface: "#073642",
    text: "#eee8d5",
    accent: "#268bd2",
    overrides: {
      "--color-success": "#859900",
      "--color-warning": "#b58900",
      "--color-danger": "#dc322f",
      "--color-search": "#2aa198",
      "--color-thinking": "#cb4b16",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    bg: "#272822",
    surface: "#3e3d32",
    text: "#f8f8f2",
    accent: "#a6e22e",
    overrides: {
      "--color-success": "#a6e22e",
      "--color-warning": "#e6db74",
      "--color-danger": "#f92672",
      "--color-search": "#66d9ef",
      "--color-thinking": "#fd971f",
    },
  },
  {
    id: "matrix",
    name: "Green Screen",
    bg: "#0a0f0a",
    surface: "#121a12",
    text: "#d6f5d6",
    accent: "#33dd55",
    overrides: {
      "--color-success": "#33dd55",
      "--color-warning": "#d8e64e",
      "--color-danger": "#ff5555",
      "--color-search": "#4ee6c3",
      "--color-thinking": "#d8e64e",
    },
  },
  {
    id: "paper",
    name: "Paper",
    bg: "#f2eee4",
    surface: "#e7e0d0",
    text: "#38332a",
    accent: "#b3541e",
    overrides: {
      "--color-success": "#4d7c43",
      "--color-warning": "#9a6b1f",
      "--color-danger": "#b3402e",
      "--color-info": "#3d6f9e",
      "--color-search": "#2f7f78",
      "--color-thinking": "#9a6b1f",
    },
  },
  {
    id: "frost",
    name: "Frost",
    bg: "#eceff4",
    surface: "#e0e6ef",
    text: "#2e3440",
    accent: "#5e81ac",
    overrides: {
      "--color-success": "#5a8a5a",
      "--color-warning": "#9a7b2d",
      "--color-danger": "#bf616a",
      "--color-info": "#5e81ac",
      "--color-search": "#4d7f8a",
      "--color-thinking": "#9a7b2d",
    },
  },
];

/** The id stored for the custom slot. */
export const CUSTOM_THEME_ID = "custom";

export function getTheme(id: string | null | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validate stored/typed seeds — a bad value falls back per-field. */
export function sanitizeSeeds(input: unknown): CustomThemeSeeds {
  const fallback: CustomThemeSeeds = {
    bg: "#191715",
    surface: "#2a2723",
    text: "#ede9e2",
    accent: "#c96442",
  };
  if (!input || typeof input !== "object") return fallback;
  const raw = input as Record<string, unknown>;
  const pick = (v: unknown, d: string) =>
    typeof v === "string" && HEX.test(v.trim()) ? v.trim() : d;
  return {
    bg: pick(raw.bg, fallback.bg),
    surface: pick(raw.surface, fallback.surface),
    text: pick(raw.text, fallback.text),
    accent: pick(raw.accent, fallback.accent),
  };
}

/** Apply vars to `:root`. Everything subscribes via var(), so it is instant. */
export function applyThemeVars(vars: Record<string, string>): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

export function applyThemeById(
  id: string | null | undefined,
  custom?: CustomThemeSeeds | null
): void {
  if (id === CUSTOM_THEME_ID && custom) {
    applyThemeVars(themeVars(custom));
    return;
  }
  const theme = getTheme(id);
  applyThemeVars(themeVars(theme, theme.overrides));
}
