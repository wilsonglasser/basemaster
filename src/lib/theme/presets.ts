import type { Extension } from "@codemirror/state";
import { darcula } from "@uiw/codemirror-theme-darcula";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { solarizedLight } from "@uiw/codemirror-theme-solarized";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { oneDark } from "@codemirror/theme-one-dark";

export type ThemeMode = "light" | "dark";

export type DarkPresetId =
  | "slate"
  | "darcula"
  | "one-dark"
  | "tokyo-night"
  | "dimmed"
  | "custom-dark";

export type LightPresetId =
  | "clean"
  | "intellij-light"
  | "github-light"
  | "solarized-light"
  | "custom-light";

export type PresetId = DarkPresetId | LightPresetId;

/** All tokens applied as CSS vars on :root. Each preset provides
 *  a complete set — no merge / fallback. Values in oklch(...). */
export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  chrome: string;
  chromeForeground: string;
  connAccent: string;
  connAccentDefault: string;
  connAccentForeground: string;
}

export interface Preset {
  id: PresetId;
  name: string;
  mode: ThemeMode;
  tokens: ThemeTokens;
  cmTheme: Extension;
}

// ---------------- DARK PRESETS ----------------

const slateDark: ThemeTokens = {
  background: "oklch(0.145 0 0)",
  foreground: "oklch(0.985 0 0)",
  card: "oklch(0.18 0 0)",
  cardForeground: "oklch(0.985 0 0)",
  popover: "oklch(0.18 0 0)",
  popoverForeground: "oklch(0.985 0 0)",
  primary: "oklch(0.62 0.19 254)",
  primaryForeground: "oklch(0.145 0 0)",
  secondary: "oklch(0.24 0 0)",
  secondaryForeground: "oklch(0.985 0 0)",
  muted: "oklch(0.24 0 0)",
  mutedForeground: "oklch(0.708 0 0)",
  accent: "oklch(0.24 0 0)",
  accentForeground: "oklch(0.985 0 0)",
  destructive: "oklch(0.65 0.22 27)",
  destructiveForeground: "oklch(0.985 0 0)",
  border: "oklch(0.27 0 0)",
  input: "oklch(0.27 0 0)",
  ring: "oklch(0.5 0 0)",
  sidebar: "oklch(0.17 0 0)",
  sidebarForeground: "oklch(0.985 0 0)",
  chrome: "oklch(0.16 0 0)",
  chromeForeground: "oklch(0.985 0 0)",
  connAccent: "oklch(0.62 0.19 254)",
  connAccentDefault: "oklch(0.62 0.19 254)",
  connAccentForeground: "oklch(0.145 0 0)",
};

// Darcula — classic JetBrains. Base #2B2B2B, fg #A9B7C6, orange accent.
const darculaTokens: ThemeTokens = {
  background: "oklch(0.27 0.002 90)",
  foreground: "oklch(0.77 0.025 240)",
  card: "oklch(0.30 0.002 90)",
  cardForeground: "oklch(0.77 0.025 240)",
  popover: "oklch(0.30 0.002 90)",
  popoverForeground: "oklch(0.77 0.025 240)",
  primary: "oklch(0.72 0.15 55)",
  primaryForeground: "oklch(0.15 0 0)",
  secondary: "oklch(0.32 0.004 90)",
  secondaryForeground: "oklch(0.88 0.02 240)",
  muted: "oklch(0.32 0.004 90)",
  mutedForeground: "oklch(0.62 0.02 240)",
  accent: "oklch(0.35 0.008 240)",
  accentForeground: "oklch(0.88 0.02 240)",
  destructive: "oklch(0.64 0.2 25)",
  destructiveForeground: "oklch(0.98 0 0)",
  border: "oklch(0.36 0.004 90)",
  input: "oklch(0.32 0.004 90)",
  ring: "oklch(0.55 0.12 55)",
  sidebar: "oklch(0.29 0.002 90)",
  sidebarForeground: "oklch(0.77 0.025 240)",
  chrome: "oklch(0.28 0.002 90)",
  chromeForeground: "oklch(0.77 0.025 240)",
  connAccent: "oklch(0.72 0.15 55)",
  connAccentDefault: "oklch(0.72 0.15 55)",
  connAccentForeground: "oklch(0.15 0 0)",
};

// One Dark — Atom/VS Code. Base #282C34, fg #ABB2BF.
const oneDarkTokens: ThemeTokens = {
  background: "oklch(0.28 0.015 260)",
  foreground: "oklch(0.78 0.02 260)",
  card: "oklch(0.31 0.014 260)",
  cardForeground: "oklch(0.78 0.02 260)",
  popover: "oklch(0.31 0.014 260)",
  popoverForeground: "oklch(0.78 0.02 260)",
  primary: "oklch(0.68 0.15 235)",
  primaryForeground: "oklch(0.15 0 0)",
  secondary: "oklch(0.33 0.015 260)",
  secondaryForeground: "oklch(0.9 0.015 260)",
  muted: "oklch(0.33 0.015 260)",
  mutedForeground: "oklch(0.65 0.02 260)",
  accent: "oklch(0.36 0.02 260)",
  accentForeground: "oklch(0.9 0.015 260)",
  destructive: "oklch(0.66 0.2 25)",
  destructiveForeground: "oklch(0.98 0 0)",
  border: "oklch(0.37 0.015 260)",
  input: "oklch(0.33 0.015 260)",
  ring: "oklch(0.58 0.12 235)",
  sidebar: "oklch(0.3 0.015 260)",
  sidebarForeground: "oklch(0.78 0.02 260)",
  chrome: "oklch(0.29 0.015 260)",
  chromeForeground: "oklch(0.78 0.02 260)",
  connAccent: "oklch(0.68 0.15 235)",
  connAccentDefault: "oklch(0.68 0.15 235)",
  connAccentForeground: "oklch(0.15 0 0)",
};

// Tokyo Night. Base #1A1B26, fg #A9B1D6, purple accent.
const tokyoNightTokens: ThemeTokens = {
  background: "oklch(0.19 0.02 280)",
  foreground: "oklch(0.75 0.04 270)",
  card: "oklch(0.22 0.02 280)",
  cardForeground: "oklch(0.75 0.04 270)",
  popover: "oklch(0.22 0.02 280)",
  popoverForeground: "oklch(0.75 0.04 270)",
  primary: "oklch(0.7 0.14 290)",
  primaryForeground: "oklch(0.15 0 0)",
  secondary: "oklch(0.24 0.02 280)",
  secondaryForeground: "oklch(0.9 0.03 270)",
  muted: "oklch(0.24 0.02 280)",
  mutedForeground: "oklch(0.6 0.03 270)",
  accent: "oklch(0.27 0.025 280)",
  accentForeground: "oklch(0.9 0.03 270)",
  destructive: "oklch(0.66 0.2 25)",
  destructiveForeground: "oklch(0.98 0 0)",
  border: "oklch(0.28 0.025 280)",
  input: "oklch(0.24 0.02 280)",
  ring: "oklch(0.58 0.12 290)",
  sidebar: "oklch(0.21 0.02 280)",
  sidebarForeground: "oklch(0.75 0.04 270)",
  chrome: "oklch(0.2 0.02 280)",
  chromeForeground: "oklch(0.75 0.04 270)",
  connAccent: "oklch(0.7 0.14 290)",
  connAccentDefault: "oklch(0.7 0.14 290)",
  connAccentForeground: "oklch(0.15 0 0)",
};

// GitHub Dark Dimmed. Base #22272E, fg #ADBAC7.
const dimmedTokens: ThemeTokens = {
  background: "oklch(0.28 0.012 250)",
  foreground: "oklch(0.77 0.015 250)",
  card: "oklch(0.31 0.012 250)",
  cardForeground: "oklch(0.77 0.015 250)",
  popover: "oklch(0.31 0.012 250)",
  popoverForeground: "oklch(0.77 0.015 250)",
  primary: "oklch(0.68 0.15 250)",
  primaryForeground: "oklch(0.15 0 0)",
  secondary: "oklch(0.33 0.012 250)",
  secondaryForeground: "oklch(0.9 0.012 250)",
  muted: "oklch(0.33 0.012 250)",
  mutedForeground: "oklch(0.65 0.015 250)",
  accent: "oklch(0.36 0.015 250)",
  accentForeground: "oklch(0.9 0.012 250)",
  destructive: "oklch(0.66 0.2 25)",
  destructiveForeground: "oklch(0.98 0 0)",
  border: "oklch(0.37 0.012 250)",
  input: "oklch(0.33 0.012 250)",
  ring: "oklch(0.58 0.12 250)",
  sidebar: "oklch(0.3 0.012 250)",
  sidebarForeground: "oklch(0.77 0.015 250)",
  chrome: "oklch(0.29 0.012 250)",
  chromeForeground: "oklch(0.77 0.015 250)",
  connAccent: "oklch(0.68 0.15 250)",
  connAccentDefault: "oklch(0.68 0.15 250)",
  connAccentForeground: "oklch(0.15 0 0)",
};

// ---------------- LIGHT PRESETS ----------------

const cleanLight: ThemeTokens = {
  background: "oklch(0.995 0.002 250)",
  foreground: "oklch(0.13 0.015 250)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.13 0.015 250)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.13 0.015 250)",
  primary: "oklch(0.55 0.18 254)",
  primaryForeground: "oklch(0.985 0 0)",
  secondary: "oklch(0.965 0.004 250)",
  secondaryForeground: "oklch(0.22 0.012 250)",
  muted: "oklch(0.965 0.004 250)",
  mutedForeground: "oklch(0.36 0.02 250)",
  accent: "oklch(0.95 0.008 250)",
  accentForeground: "oklch(0.22 0.012 250)",
  destructive: "oklch(0.577 0.245 27.325)",
  destructiveForeground: "oklch(0.985 0 0)",
  border: "oklch(0.9 0.006 250)",
  input: "oklch(0.9 0.006 250)",
  ring: "oklch(0.708 0.01 250)",
  sidebar: "oklch(0.97 0.005 250)",
  sidebarForeground: "oklch(0.13 0.015 250)",
  chrome: "oklch(0.975 0.005 250)",
  chromeForeground: "oklch(0.13 0.015 250)",
  connAccent: "oklch(0.55 0.18 254)",
  connAccentDefault: "oklch(0.55 0.18 254)",
  connAccentForeground: "oklch(0.985 0 0)",
};

// IntelliJ Light — JetBrains. Background #FFFFFF, editor #FFFFFF, blue accent #4A8CC7.
const intellijLightTokens: ThemeTokens = {
  background: "oklch(0.99 0 0)",
  foreground: "oklch(0.15 0.005 240)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.15 0.005 240)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.15 0.005 240)",
  primary: "oklch(0.55 0.13 240)",
  primaryForeground: "oklch(0.99 0 0)",
  secondary: "oklch(0.96 0.003 240)",
  secondaryForeground: "oklch(0.2 0.01 240)",
  muted: "oklch(0.96 0.003 240)",
  mutedForeground: "oklch(0.42 0.015 240)",
  accent: "oklch(0.93 0.01 240)",
  accentForeground: "oklch(0.2 0.01 240)",
  destructive: "oklch(0.55 0.22 25)",
  destructiveForeground: "oklch(0.99 0 0)",
  border: "oklch(0.88 0.006 240)",
  input: "oklch(0.88 0.006 240)",
  ring: "oklch(0.7 0.01 240)",
  sidebar: "oklch(0.97 0.003 240)",
  sidebarForeground: "oklch(0.15 0.005 240)",
  chrome: "oklch(0.97 0.003 240)",
  chromeForeground: "oklch(0.15 0.005 240)",
  connAccent: "oklch(0.55 0.13 240)",
  connAccentDefault: "oklch(0.55 0.13 240)",
  connAccentForeground: "oklch(0.99 0 0)",
};

// GitHub Light. Base #FFFFFF, fg #24292E, blue accent #0969DA.
const githubLightTokens: ThemeTokens = {
  background: "oklch(1 0 0)",
  foreground: "oklch(0.24 0.01 250)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.24 0.01 250)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.24 0.01 250)",
  primary: "oklch(0.52 0.17 250)",
  primaryForeground: "oklch(0.99 0 0)",
  secondary: "oklch(0.96 0.005 250)",
  secondaryForeground: "oklch(0.3 0.01 250)",
  muted: "oklch(0.96 0.005 250)",
  mutedForeground: "oklch(0.44 0.015 250)",
  accent: "oklch(0.93 0.01 250)",
  accentForeground: "oklch(0.3 0.01 250)",
  destructive: "oklch(0.55 0.22 25)",
  destructiveForeground: "oklch(0.99 0 0)",
  border: "oklch(0.88 0.008 250)",
  input: "oklch(0.88 0.008 250)",
  ring: "oklch(0.7 0.012 250)",
  sidebar: "oklch(0.975 0.005 250)",
  sidebarForeground: "oklch(0.24 0.01 250)",
  chrome: "oklch(0.97 0.005 250)",
  chromeForeground: "oklch(0.24 0.01 250)",
  connAccent: "oklch(0.52 0.17 250)",
  connAccentDefault: "oklch(0.52 0.17 250)",
  connAccentForeground: "oklch(0.99 0 0)",
};

// Solarized Light. Base #FDF6E3 (cream), fg #657B83, blue accent #268BD2.
const solarizedLightTokens: ThemeTokens = {
  background: "oklch(0.965 0.025 85)",
  foreground: "oklch(0.45 0.02 210)",
  card: "oklch(0.98 0.018 85)",
  cardForeground: "oklch(0.45 0.02 210)",
  popover: "oklch(0.98 0.018 85)",
  popoverForeground: "oklch(0.45 0.02 210)",
  primary: "oklch(0.6 0.13 230)",
  primaryForeground: "oklch(0.99 0 0)",
  secondary: "oklch(0.94 0.025 85)",
  secondaryForeground: "oklch(0.4 0.02 210)",
  muted: "oklch(0.94 0.025 85)",
  mutedForeground: "oklch(0.55 0.02 210)",
  accent: "oklch(0.91 0.03 85)",
  accentForeground: "oklch(0.4 0.02 210)",
  destructive: "oklch(0.55 0.2 25)",
  destructiveForeground: "oklch(0.99 0 0)",
  border: "oklch(0.88 0.03 85)",
  input: "oklch(0.9 0.025 85)",
  ring: "oklch(0.7 0.03 85)",
  sidebar: "oklch(0.94 0.025 85)",
  sidebarForeground: "oklch(0.45 0.02 210)",
  chrome: "oklch(0.94 0.025 85)",
  chromeForeground: "oklch(0.45 0.02 210)",
  connAccent: "oklch(0.6 0.13 230)",
  connAccentDefault: "oklch(0.6 0.13 230)",
  connAccentForeground: "oklch(0.99 0 0)",
};

// ---------------- LISTS ----------------

export type DarkPreset = Preset & { id: DarkPresetId };
export type LightPreset = Preset & { id: LightPresetId };

export const DARK_PRESETS: DarkPreset[] = [
  { id: "slate", name: "Slate (default)", mode: "dark", tokens: slateDark, cmTheme: oneDark },
  { id: "darcula", name: "Darcula (JetBrains)", mode: "dark", tokens: darculaTokens, cmTheme: darcula },
  { id: "one-dark", name: "One Dark", mode: "dark", tokens: oneDarkTokens, cmTheme: oneDark },
  { id: "tokyo-night", name: "Tokyo Night", mode: "dark", tokens: tokyoNightTokens, cmTheme: tokyoNight },
  { id: "dimmed", name: "GitHub Dark Dimmed", mode: "dark", tokens: dimmedTokens, cmTheme: githubDark },
];

export const LIGHT_PRESETS: LightPreset[] = [
  { id: "clean", name: "Clean (default)", mode: "light", tokens: cleanLight, cmTheme: githubLight },
  { id: "intellij-light", name: "IntelliJ Light", mode: "light", tokens: intellijLightTokens, cmTheme: githubLight },
  { id: "github-light", name: "GitHub Light", mode: "light", tokens: githubLightTokens, cmTheme: githubLight },
  { id: "solarized-light", name: "Solarized Light", mode: "light", tokens: solarizedLightTokens, cmTheme: solarizedLight },
];

// ---------------- CUSTOM ----------------

/** Derive a custom preset from a base hex color (#rrggbb).
 *  Strategy: convert hex→oklch to find L/C/H, and generate derived
 *  tokens from the base lightness + hue. Custom-dark assumes
 *  L ≤ 0.35; custom-light assumes L ≥ 0.85. */
export function deriveCustomPreset(
  id: "custom-dark" | "custom-light",
  baseHex: string,
  name?: string,
): Preset {
  const { l, c, h } = hexToOklch(baseHex);
  const mode: ThemeMode = id === "custom-dark" ? "dark" : "light";
  const cmTheme = id === "custom-dark" ? oneDark : githubLight;

  const tokens: ThemeTokens =
    mode === "dark"
      ? deriveDarkTokens(l, c, h)
      : deriveLightTokens(l, c, h);

  return { id, name: name ?? (mode === "dark" ? "Custom dark" : "Custom light"), mode, tokens, cmTheme };
}

function deriveDarkTokens(bgL: number, bgC: number, bgH: number): ThemeTokens {
  const L = Math.max(0.08, Math.min(0.35, bgL));
  const C = Math.max(0, Math.min(0.04, bgC));
  const H = bgH;
  const fg = `oklch(${(0.92 - L * 0.2).toFixed(3)} ${(C * 0.8).toFixed(3)} ${H})`;
  const muted = `oklch(${(L + 0.08).toFixed(3)} ${C.toFixed(3)} ${H})`;
  const border = `oklch(${(L + 0.12).toFixed(3)} ${C.toFixed(3)} ${H})`;
  const accent = `oklch(${(L + 0.1).toFixed(3)} ${(C + 0.004).toFixed(3)} ${H})`;
  const primary = `oklch(${(0.66).toFixed(3)} 0.14 ${H})`;
  return {
    background: `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H})`,
    foreground: fg,
    card: `oklch(${(L + 0.03).toFixed(3)} ${C.toFixed(3)} ${H})`,
    cardForeground: fg,
    popover: `oklch(${(L + 0.03).toFixed(3)} ${C.toFixed(3)} ${H})`,
    popoverForeground: fg,
    primary,
    primaryForeground: "oklch(0.15 0 0)",
    secondary: muted,
    secondaryForeground: fg,
    muted,
    mutedForeground: `oklch(${(0.65).toFixed(3)} ${C.toFixed(3)} ${H})`,
    accent,
    accentForeground: fg,
    destructive: "oklch(0.65 0.22 27)",
    destructiveForeground: "oklch(0.985 0 0)",
    border,
    input: muted,
    ring: `oklch(${(0.55).toFixed(3)} 0.12 ${H})`,
    sidebar: `oklch(${(L + 0.02).toFixed(3)} ${C.toFixed(3)} ${H})`,
    sidebarForeground: fg,
    chrome: `oklch(${(L + 0.015).toFixed(3)} ${C.toFixed(3)} ${H})`,
    chromeForeground: fg,
    connAccent: primary,
    connAccentDefault: primary,
    connAccentForeground: "oklch(0.15 0 0)",
  };
}

function deriveLightTokens(bgL: number, bgC: number, bgH: number): ThemeTokens {
  const L = Math.max(0.9, Math.min(0.99, bgL));
  const C = Math.max(0, Math.min(0.03, bgC));
  const H = bgH;
  const fg = `oklch(${(0.18).toFixed(3)} ${(C * 0.8).toFixed(3)} ${H})`;
  const muted = `oklch(${(L - 0.03).toFixed(3)} ${C.toFixed(3)} ${H})`;
  const border = `oklch(${(L - 0.08).toFixed(3)} ${(C + 0.002).toFixed(3)} ${H})`;
  const accent = `oklch(${(L - 0.05).toFixed(3)} ${(C + 0.004).toFixed(3)} ${H})`;
  const primary = `oklch(${(0.55).toFixed(3)} 0.17 ${H})`;
  return {
    background: `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H})`,
    foreground: fg,
    card: `oklch(${Math.min(1, L + 0.005).toFixed(3)} ${(C * 0.5).toFixed(3)} ${H})`,
    cardForeground: fg,
    popover: `oklch(${Math.min(1, L + 0.005).toFixed(3)} ${(C * 0.5).toFixed(3)} ${H})`,
    popoverForeground: fg,
    primary,
    primaryForeground: "oklch(0.99 0 0)",
    secondary: muted,
    secondaryForeground: fg,
    muted,
    mutedForeground: `oklch(${(0.4).toFixed(3)} ${C.toFixed(3)} ${H})`,
    accent,
    accentForeground: fg,
    destructive: "oklch(0.577 0.245 27.325)",
    destructiveForeground: "oklch(0.985 0 0)",
    border,
    input: border,
    ring: `oklch(${(0.7).toFixed(3)} 0.01 ${H})`,
    sidebar: `oklch(${(L - 0.02).toFixed(3)} ${C.toFixed(3)} ${H})`,
    sidebarForeground: fg,
    chrome: `oklch(${(L - 0.015).toFixed(3)} ${C.toFixed(3)} ${H})`,
    chromeForeground: fg,
    connAccent: primary,
    connAccentDefault: primary,
    connAccentForeground: "oklch(0.99 0 0)",
  };
}

// ---------------- UTILS ----------------

export function getPreset(id: PresetId, customBg?: string): Preset {
  if (id === "custom-dark") return deriveCustomPreset("custom-dark", customBg ?? "#1a1a1a");
  if (id === "custom-light") return deriveCustomPreset("custom-light", customBg ?? "#f7f7f7");
  const all = [...DARK_PRESETS, ...LIGHT_PRESETS];
  return all.find((p) => p.id === id) ?? DARK_PRESETS[0];
}

/** Inject the tokens as CSS custom properties on :root. */
export function applyTokens(tokens: ThemeTokens) {
  const root = document.documentElement;
  const map: Record<string, string> = {
    "--background": tokens.background,
    "--foreground": tokens.foreground,
    "--card": tokens.card,
    "--card-foreground": tokens.cardForeground,
    "--popover": tokens.popover,
    "--popover-foreground": tokens.popoverForeground,
    "--primary": tokens.primary,
    "--primary-foreground": tokens.primaryForeground,
    "--secondary": tokens.secondary,
    "--secondary-foreground": tokens.secondaryForeground,
    "--muted": tokens.muted,
    "--muted-foreground": tokens.mutedForeground,
    "--accent": tokens.accent,
    "--accent-foreground": tokens.accentForeground,
    "--destructive": tokens.destructive,
    "--destructive-foreground": tokens.destructiveForeground,
    "--border": tokens.border,
    "--input": tokens.input,
    "--ring": tokens.ring,
    "--sidebar": tokens.sidebar,
    "--sidebar-foreground": tokens.sidebarForeground,
    "--chrome": tokens.chrome,
    "--chrome-foreground": tokens.chromeForeground,
    "--conn-accent": tokens.connAccent,
    "--conn-accent-default": tokens.connAccentDefault,
    "--conn-accent-foreground": tokens.connAccentForeground,
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
}

// Mini hex → oklch parser via sRGB→Lab→OKLab. Sufficient for color-picker
// input (user picks a base color; <1% precision is irrelevant).
function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const s = hex.replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const R = lin(r), G = lin(g), B = lin(b);
  const l_ = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  const m_ = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  const s_ = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;
  const lc = Math.cbrt(l_), mc = Math.cbrt(m_), sc = Math.cbrt(s_);
  const L = 0.2104542553 * lc + 0.793617785 * mc - 0.0040720468 * sc;
  const A = 1.9779984951 * lc - 2.428592205 * mc + 0.4505937099 * sc;
  const Bk = 0.0259040371 * lc + 0.7827717662 * mc - 0.808675766 * sc;
  const C = Math.sqrt(A * A + Bk * Bk);
  let H = (Math.atan2(Bk, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
}
