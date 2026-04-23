/** Normalize a binding string: lowercase modifiers,
 *  last part with first letter capitalized. Ex: "ctrl+shift+f" → "Ctrl+Shift+F". */
export function normalizeBinding(s: string): string {
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map(capitalize);
  // Canonical modifier order: Mod, Ctrl, Alt, Shift, Meta.
  const ORDER = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];
  mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const last = key.length === 1 ? key.toUpperCase() : capitalize(key);
  return [...mods, last].join("+");
}

function capitalize(s: string): string {
  if (!s) return s;
  const low = s.toLowerCase();
  const TOKENS: Record<string, string> = {
    mod: "Mod",
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    meta: "Meta",
    cmd: "Meta",
    command: "Meta",
    tab: "Tab",
    enter: "Enter",
    escape: "Escape",
    esc: "Escape",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  if (TOKENS[low]) return TOKENS[low];
  if (/^f\d{1,2}$/.test(low)) return low.toUpperCase();
  return s[0].toUpperCase() + s.slice(1);
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/** Convert a KeyboardEvent to the canonical string ("Mod+Shift+F").
 *  Uses "Mod" when Ctrl (win/linux) or Meta (mac) is the primary modifier. */
export function eventToBinding(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key || key === "Unidentified") return null;

  // Ignore when only a modifier was pressed.
  if (
    key === "Control" ||
    key === "Shift" ||
    key === "Alt" ||
    key === "Meta"
  ) {
    return null;
  }

  const mods: string[] = [];
  const primary = IS_MAC ? e.metaKey : e.ctrlKey;
  if (primary) mods.push("Mod");
  // Ctrl without Meta on mac still counts as explicit Ctrl.
  if (IS_MAC && e.ctrlKey && !e.metaKey) mods.push("Ctrl");
  if (!IS_MAC && e.metaKey) mods.push("Meta");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const last =
    key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
  const out = [...mods, last].join("+");
  return normalizeBinding(out);
}

/** Convert "Mod+Shift+F" into human labels per platform:
 *  - mac: "⌘⇧F"
 *  - others: "Ctrl+Shift+F" */
export function displayBinding(binding: string | null): string {
  if (!binding) return "—";
  const parts = binding.split("+");
  if (IS_MAC) {
    const map: Record<string, string> = {
      Mod: "⌘",
      Meta: "⌘",
      Ctrl: "⌃",
      Alt: "⌥",
      Shift: "⇧",
    };
    return parts.map((p) => map[p] ?? p).join("");
  }
  return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
}
