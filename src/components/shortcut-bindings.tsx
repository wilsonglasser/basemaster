import { useCallback, useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { useShortcut } from "@/lib/shortcuts/use-shortcuts";
import { useAiAgent } from "@/state/ai-agent";
import { useConnections } from "@/state/connections";
import { useSidebarSelection } from "@/state/sidebar-selection";
import { useTableViewBridge } from "@/state/table-view-bridge";
import { useTabs } from "@/state/tabs";
import { useUiZoom } from "@/state/ui-zoom";

/** Registra handlers globais dos atalhos. Nada renderiza — só hooks. */
export function ShortcutBindings() {
  // --- Ctrl+D — abrir/focar estrutura da tabela ---
  useShortcut(
    "table.openStructure",
    useCallback(() => {
      const tabsSt = useTabs.getState();
      const active = tabsSt.tabs.find((t) => t.id === tabsSt.activeId);

      // Caso 1: aba ativa é TableView → alterna pra Estrutura + edit.
      if (active && active.kind.kind === "table") {
        const bridge = useTableViewBridge.getState();
        const ok = bridge.setViewOf(active.id, "structure");
        if (ok) {
          // Espera o StructurePane montar antes de pedir edit.
          setTimeout(() => bridge.startEditOf(active.id), 50);
          return;
        }
      }

      // Caso 2: seleção na sidebar é uma tabela → abre TableView em Estrutura.
      const sel = useSidebarSelection.getState().selected;
      if (sel && sel.kind === "table") {
        const accent =
          useConnections
            .getState()
            .connections.find((c) => c.id === sel.connectionId)?.color ?? null;
        tabsSt.openOrFocus(
          (t) =>
            t.kind.kind === "table" &&
            t.kind.connectionId === sel.connectionId &&
            t.kind.schema === sel.schema &&
            t.kind.table === sel.table,
          () => ({
            label: sel.table,
            kind: {
              kind: "table",
              connectionId: sel.connectionId,
              schema: sel.schema,
              table: sel.table,
              initialView: "structure",
              initialEdit: true,
            },
            accentColor: accent,
          }),
        );
        return;
      }
    }, []),
  );

  // --- Ctrl+T — nova query (na conexão focada, se houver) ---
  useShortcut(
    "tab.newQuery",
    useCallback(() => {
      const sel = useSidebarSelection.getState().selected;
      const connId = sel?.connectionId ?? null;
      const schema =
        sel && "schema" in sel && sel.schema ? sel.schema : undefined;
      const conn = connId
        ? useConnections.getState().connections.find((c) => c.id === connId)
        : null;
      if (!conn) return;
      useTabs.getState().open({
        label: "Query",
        kind: {
          kind: "query",
          connectionId: conn.id,
          schema,
        },
        accentColor: conn.color ?? null,
      });
    }, []),
  );

  // --- Ctrl+W — fechar aba ativa ---
  useShortcut(
    "tab.close",
    useCallback(() => {
      const tabsSt = useTabs.getState();
      if (tabsSt.activeId) tabsSt.close(tabsSt.activeId);
    }, []),
  );

  // --- Ctrl+Tab / Ctrl+Shift+Tab — navegação ---
  useShortcut(
    "tab.next",
    useCallback(() => {
      const { tabs, activeId, setActive } = useTabs.getState();
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const next = tabs[(idx + 1) % tabs.length];
      setActive(next.id);
    }, []),
  );
  useShortcut(
    "tab.prev",
    useCallback(() => {
      const { tabs, activeId, setActive } = useTabs.getState();
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      setActive(prev.id);
    }, []),
  );

  // --- Ctrl+J — toggle sidebar IA ---
  useShortcut(
    "layout.toggleAi",
    useCallback(() => {
      useAiAgent.getState().togglePanel();
    }, []),
  );

  // --- F2 — rename da seleção atual (sidebar) ---
  useShortcut(
    "rename.selected",
    useCallback(async () => {
      const sel = useSidebarSelection.getState().selected;
      if (!sel) return;
      const { ipc } = await import("@/lib/ipc");
      try {
        if (sel.kind === "table") {
          const next = window.prompt(
            `Renomear tabela "${sel.table}":`,
            sel.table,
          );
          if (!next || !next.trim() || next === sel.table) return;
          await ipc.db.renameTable(
            sel.connectionId,
            sel.schema,
            sel.table,
            next.trim(),
          );
          const { useSchemaCache } = await import("@/state/schema-cache");
          useSchemaCache
            .getState()
            .invalidateSchema(sel.connectionId, sel.schema);
          await useSchemaCache
            .getState()
            .ensureSnapshot(sel.connectionId, sel.schema);
        } else if (sel.kind === "schema") {
          const next = window.prompt(
            `Renomear schema "${sel.schema}":`,
            sel.schema,
          );
          if (!next || !next.trim() || next === sel.schema) return;
          await ipc.db.renameSchema(sel.connectionId, sel.schema, next.trim());
        } else if (sel.kind === "connection") {
          // Abre tab de edit da conexão.
          useTabs.getState().openOrFocus(
            (t) =>
              t.kind.kind === "edit-connection" &&
              t.kind.connectionId === sel.connectionId,
            () => ({
              label: "Editar conexão",
              kind: {
                kind: "edit-connection",
                connectionId: sel.connectionId,
              },
            }),
          );
        } else if (sel.kind === "saved_query") {
          const { useSavedQueries } = await import("@/state/saved-queries");
          const cache = useSavedQueries.getState().cache[sel.connectionId];
          const q = cache?.find((x) => x.id === sel.savedQueryId);
          if (!q) return;
          const next = window.prompt(`Renomear query "${q.name}":`, q.name);
          if (!next || !next.trim() || next === q.name) return;
          await useSavedQueries
            .getState()
            .update(q.id, { name: next.trim(), sql: q.sql, schema: q.schema });
        }
      } catch (e) {
        alert(`Falha ao renomear: ${e}`);
      }
    }, []),
  );

  // --- Ctrl+, — abrir Settings ---
  useShortcut(
    "global.settings",
    useCallback(() => {
      useTabs.getState().openOrFocus(
        (t) => t.kind.kind === "settings",
        () => ({ label: "Configurações", kind: { kind: "settings" } }),
      );
    }, []),
  );

  // --- Zoom ---
  // Listener dedicado em CAPTURE phase, antes do sistema de shortcuts.
  // Cobre todas variações de `=` / `+` / `-` / `_` independente de layout
  // de teclado (Ctrl+= em US, Ctrl+Shift+= pra gerar +, Ctrl+NumpadAdd,
  // etc). O sistema de shortcuts geral falha em alguns combos por causa
  // de shift/layout; isso aqui é o bruteforce que sempre funciona.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ignora se foco tá num input/editor (composer da IA, etc).
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
        if (t.closest?.(".cm-editor")) return;
      }
      // Ctrl + = / + / Add → zoom in
      if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd" || e.code === "Equal") {
        e.preventDefault();
        e.stopPropagation();
        useUiZoom.getState().zoomIn();
        return;
      }
      // Ctrl + - / _ / Subtract → zoom out
      if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract" || e.code === "Minus") {
        e.preventDefault();
        e.stopPropagation();
        useUiZoom.getState().zoomOut();
        return;
      }
      // Ctrl + 0 / Numpad0 → reset
      if (e.key === "0" || e.code === "Numpad0" || e.code === "Digit0") {
        e.preventDefault();
        e.stopPropagation();
        useUiZoom.getState().zoomReset();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // --- Fullscreen (F11) ---
  useShortcut(
    "view.fullscreen",
    useCallback(async () => {
      const win = getCurrentWebviewWindow();
      const isFs = await win.isFullscreen();
      await win.setFullscreen(!isFs);
      useUiZoom.getState().setFullscreen(!isFs);
    }, []),
  );

  // Aplica o zoom sempre que muda — tenta via API nativa do webview
  // primeiro; se falhar (ex: permission não concedida porque não
  // reiniciou), cai no CSS zoom como fallback.
  const zoom = useUiZoom((s) => s.zoom);
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    void win
      .setZoom(zoom)
      .then(() => {
        // Limpa fallback CSS se estava em uso.
        document.documentElement.style.zoom = "";
      })
      .catch((e) => {
        console.warn("webview.setZoom falhou — usando CSS fallback:", e);
        document.documentElement.style.zoom = zoom === 1 ? "" : String(zoom);
      });
  }, [zoom]);

  return null;
}
