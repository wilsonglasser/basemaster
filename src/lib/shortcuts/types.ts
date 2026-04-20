/** Scope controla onde o atalho dispara:
 *  - "global": em qualquer lugar (exceto inputs, a não ser que haja Mod)
 *  - "editor": somente dentro do CodeMirror (wire via keymap local)
 *  - "grid": somente dentro da grid (foco no canvas da grid) */
export type ShortcutScope = "global" | "editor" | "grid";

export interface ShortcutAction {
  id: string;
  category: string;
  label: string;
  description?: string;
  /** Binding canônico default ("Mod+Shift+F", "F5", etc.). null = sem default. */
  defaultBinding: string | null;
  scope: ShortcutScope;
  /** Se true, dispara mesmo quando foco em input/textarea (útil p/ Ctrl+K). */
  allowInInputs?: boolean;
}
