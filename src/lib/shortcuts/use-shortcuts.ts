import { useEffect } from "react";

import { actionById } from "./registry";
import { eventToBinding } from "./match";
import { useShortcuts } from "@/state/shortcuts";

type Handler = (e: KeyboardEvent) => void;

/** Registry em memória de handlers por actionId. Handlers recentes têm
 *  prioridade (stack LIFO) — permite que componentes mais específicos
 *  sobrescrevam comportamento global quando montados. */
const handlers: Record<string, Handler[]> = {};

function push(actionId: string, h: Handler) {
  (handlers[actionId] ??= []).push(h);
}
function remove(actionId: string, h: Handler) {
  const arr = handlers[actionId];
  if (!arr) return;
  const i = arr.lastIndexOf(h);
  if (i >= 0) arr.splice(i, 1);
}

/** Registra handler pra um action enquanto o componente tá montado. */
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
  // CodeMirror monta divs contentEditable; checamos ancestrais também.
  if (target.closest(".cm-editor")) return true;
  return false;
}

/** Retorna bindings alternativos pro mesmo evento — ex: `Mod+Shift++`
 *  também casa com `Mod+=` pra zoom-in (+ vem de Shift+= na maioria dos
 *  teclados). */
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

/** Instala o listener global. Chamar uma vez no App root. */
export function installGlobalShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const binding = eventToBinding(e);
    if (!binding) return;

    const index = useShortcuts.getState().indexByBinding();
    let ids = index.get(binding);
    // Fallback pra variantes com Shift (teclados que exigem Shift pra =).
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
      // Editor/Grid-scoped actions não disparam via listener global —
      // cada editor tem seu próprio keymap.
      if (action.scope !== "global") continue;
      if (editable && !action.allowInInputs) continue;

      const arr = handlers[id];
      if (!arr || arr.length === 0) continue;
      e.preventDefault();
      e.stopPropagation();
      // LIFO: mais recente leva.
      arr[arr.length - 1](e);
      return;
    }
  };
  document.addEventListener("keydown", onKey, true);
  return () => document.removeEventListener("keydown", onKey, true);
}
