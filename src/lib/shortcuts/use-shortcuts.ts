import { useEffect } from "react";

import { actionById } from "./registry";
import { eventToBinding } from "./match";
import { useShortcuts } from "@/state/shortcuts";

type Handler = (e: KeyboardEvent) => void;

/** In-memory registry of handlers per actionId. Recent handlers have
 *  priority (LIFO stack) — lets more specific components override
 *  global behavior when mounted. */
const handlers: Record<string, Handler[]> = {};

/** Last pane the user pointed at. The grid canvas (Glide) frequently does
 *  not hold DOM focus, so `document.activeElement` can't tell us whether the
 *  user is working in the grid or the sidebar. We track pointerdown instead. */
let lastPane: "main" | "sidebar" | null = null;

/** True when the user is currently working in the main panel (grid, editor,
 *  table view) rather than the sidebar. Used to gate sidebar-scoped shortcuts
 *  (Delete, F2). Falls back to activeElement when no pointer interaction has
 *  happened yet. */
export function activePaneIsMain(): boolean {
  if (lastPane === "main") return true;
  if (lastPane === "sidebar") return false;
  const active = document.activeElement as HTMLElement | null;
  return !!(active && typeof active.closest === "function" && active.closest("main"));
}

function push(actionId: string, h: Handler) {
  (handlers[actionId] ??= []).push(h);
}
function remove(actionId: string, h: Handler) {
  const arr = handlers[actionId];
  if (!arr) return;
  const i = arr.lastIndexOf(h);
  if (i >= 0) arr.splice(i, 1);
}

/** Register a handler for an action while the component is mounted. */
export function useShortcut(actionId: string, handler: Handler) {
  useEffect(() => {
    const h: Handler = (e) => handler(e);
    push(actionId, h);
    return () => remove(actionId, h);
  }, [actionId, handler]);
}

function targetIsEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  // CodeMirror mounts contentEditable divs; check ancestors too.
  if (target.closest(".cm-editor")) return true;
  return false;
}

/** Return alternate bindings for the same event — e.g. `Mod+Shift++`
 *  also matches `Mod+=` for zoom-in (+ comes from Shift+= on most
 *  keyboards). */
function alternativeBindings(primary: string): string[] {
  const alts: string[] = [];
  // Zoom in: Mod+= / Mod++ / Mod+Shift+= / Mod+Shift++
  if (primary === "Mod+Shift+=" || primary === "Mod+Shift++") {
    alts.push("Mod+=");
  }
  if (primary === "Mod+Shift+-" || primary === "Mod+Shift+_") {
    alts.push("Mod+-");
  }
  return alts;
}

/** Install the global listener. Call once in the App root. */
export function installGlobalShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const binding = eventToBinding(e);
    if (!binding) return;

    const index = useShortcuts.getState().indexByBinding();
    let ids = index.get(binding);
    // Fallback for Shift variants (keyboards that require Shift for =).
    if (!ids || ids.length === 0) {
      for (const alt of alternativeBindings(binding)) {
        const found = index.get(alt);
        if (found && found.length > 0) {
          ids = found;
          break;
        }
      }
    }
    if (!ids || ids.length === 0) return;

    const editable = targetIsEditable(e.target);

    for (const id of ids) {
      const action = actionById(id);
      if (!action) continue;
      // Editor/Grid-scoped actions don't fire through the global listener —
      // each editor has its own keymap.
      if (action.scope !== "global") continue;
      if (editable && !action.allowInInputs) continue;
      // Sidebar-scoped actions (Delete, F2) must NOT swallow the key while the
      // user is working in the grid : skip without preventDefault so the event
      // reaches Glide (e.g. Delete = delete grid row / set NULL).
      if (action.sidebarOnly && activePaneIsMain()) continue;

      const arr = handlers[id];
      if (!arr || arr.length === 0) continue;
      e.preventDefault();
      e.stopPropagation();
      // LIFO: most recent wins.
      arr[arr.length - 1](e);
      return;
    }
  };
  const onPointer = (e: PointerEvent) => {
    const tgt = e.target as HTMLElement | null;
    if (!tgt || typeof tgt.closest !== "function") return;
    if (tgt.closest("main")) lastPane = "main";
    else if (tgt.closest("aside")) lastPane = "sidebar";
  };

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
  };
}
