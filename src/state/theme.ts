import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  applyTokens,
  DARK_PRESETS,
  deriveCustomPreset,
  getPreset,
  LIGHT_PRESETS,
  type DarkPresetId,
  type LightPresetId,
  type Preset,
  type ThemeMode,
} from "@/lib/theme/presets";

export type ThemeToggle = "system" | "light" | "dark";

interface ThemeState {
  /** User's choice — "system" honors prefers-color-scheme. */
  toggle: ThemeToggle;
  /** Which preset to use in dark mode. */
  darkPreset: DarkPresetId;
  /** Which preset to use in light mode. */
  lightPreset: LightPresetId;
  /** Base color (#rrggbb) for the "custom-*" presets. */
  customDarkBg: string;
  customLightBg: string;

  /** Effective mode — "system" resolved at runtime. */
  effectiveMode: () => ThemeMode;
  /** Effective preset accounting for mode + ids + custom bases. */
  effectivePreset: () => Preset;

  setToggle: (t: ThemeToggle) => void;
  setDarkPreset: (id: DarkPresetId) => void;
  setLightPreset: (id: LightPresetId) => void;
  setCustomDarkBg: (hex: string) => void;
  setCustomLightBg: (hex: string) => void;
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      toggle: "system",
      darkPreset: "slate",
      lightPreset: "clean",
      customDarkBg: "#1a1a1a",
      customLightBg: "#f7f7f7",

      effectiveMode() {
        const t = get().toggle;
        if (t === "system") return systemPrefersDark() ? "dark" : "light";
        return t;
      },

      effectivePreset() {
        const s = get();
        const mode = s.toggle === "system" ? (systemPrefersDark() ? "dark" : "light") : s.toggle;
        if (mode === "dark") {
          if (s.darkPreset === "custom-dark") {
            return deriveCustomPreset("custom-dark", s.customDarkBg);
          }
          return getPreset(s.darkPreset);
        }
        if (s.lightPreset === "custom-light") {
          return deriveCustomPreset("custom-light", s.customLightBg);
        }
        return getPreset(s.lightPreset);
      },

      setToggle(t) { set({ toggle: t }); },
      setDarkPreset(id) { set({ darkPreset: id }); },
      setLightPreset(id) { set({ lightPreset: id }); },
      setCustomDarkBg(hex) { set({ customDarkBg: hex }); },
      setCustomLightBg(hex) { set({ customLightBg: hex }); },
    }),
    { name: "basemaster.theme" },
  ),
);

/** Global subscriber: applies tokens to :root whenever the selection changes,
 *  and listens for prefers-color-scheme changes when toggle=system. */
export function installThemeEffect() {
  const apply = () => {
    const preset = useTheme.getState().effectivePreset();
    const root = document.documentElement;
    root.classList.toggle("dark", preset.mode === "dark");
    root.style.colorScheme = preset.mode;
    applyTokens(preset.tokens);
  };

  apply();
  const unsub = useTheme.subscribe(apply);

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (useTheme.getState().toggle === "system") apply();
  };
  mql.addEventListener("change", onChange);

  return () => {
    unsub();
    mql.removeEventListener("change", onChange);
  };
}

// Re-export presets so the settings view can list options.
export { DARK_PRESETS, LIGHT_PRESETS };
export type { DarkPresetId, LightPresetId, ThemeMode };
