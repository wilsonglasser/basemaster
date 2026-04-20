/** Normaliza uma string de binding: minúsculas nos modificadores,
 *  última parte com primeira letra maiúscula. Ex: "ctrl+shift+f" → "Ctrl+Shift+F". */
export function normalizeBinding(s: string): string {
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map(capitalize);
  // Ordena modificadores canonicamente: Mod, Ctrl, Alt, Shift, Meta.
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

/** Converte um KeyboardEvent para a string canônica ("Mod+Shift+F").
 *  Usa "Mod" quando Ctrl (win/linux) ou Meta (mac) é o modificador primário. */
export function eventToBinding(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key || key === "Unidentified") return null;

  // Ignora quando só modificador foi pressionado.
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
  // Ctrl sem Meta no mac ainda conta como Ctrl explícito.
  if (IS_MAC && e.ctrlKey && !e.metaKey) mods.push("Ctrl");
  if (!IS_MAC && e.metaKey) mods.push("Meta");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const last =
    key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
  const out = [...mods, last].join("+");
  return normalizeBinding(out);
}

/** Converte "Mod+Shift+F" em labels humanos dependendo da plataforma:
 *  - mac: "⌘⇧F"
 *  - outros: "Ctrl+Shift+F" */
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
