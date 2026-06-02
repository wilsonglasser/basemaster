/** Scope controls where the shortcut fires:
 *  - "global": anywhere (except inputs, unless Mod is present)
 *  - "editor": only inside CodeMirror (wired via local keymap)
 *  - "grid": only inside the grid (focus on grid canvas) */
export type ShortcutScope = "global" | "editor" | "grid";

export interface ShortcutAction {
  id: string;
  category: string;
  label: string;
  description?: string;
  /** Canonical default binding ("Mod+Shift+F", "F5", etc.). null = no default. */
  defaultBinding: string | null;
  scope: ShortcutScope;
  /** If true, fires even when focus is in input/textarea (useful for Ctrl+K). */
  allowInInputs?: boolean;
  /** If true, the action only fires while the user is interacting with the
   *  sidebar : when focus/pointer is in the main panel the key is left alone
   *  so the grid/editor can handle it (e.g. Delete on a grid row). */
  sidebarOnly?: boolean;
}
