import { useCallback, useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { useShortcut } from "@/lib/shortcuts/use-shortcuts";
import { useAiAgent } from "@/state/ai-agent";
import { appPrompt } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useI18n } from "@/state/i18n";
import { useSidebarSelection } from "@/state/sidebar-selection";
import { useTableViewBridge } from "@/state/table-view-bridge";
import { useTabs } from "@/state/tabs";
import { useUiZoom } from "@/state/ui-zoom";

/** Registers global handlers for the shortcuts. Nothing rendered — hooks only. */
export function ShortcutBindings() {
  // --- Ctrl+D — abrir/focar estrutura da tabela ---
  useShortcut(
    "table.openStructure",
    useCallback(() => {
      const tabsSt = useTabs.getState();
      const active = tabsSt.tabs.find((t) => t.id === tabsSt.activeId);

      // Case 1: active tab is TableView → toggle to Structure + edit.
      if (active && active.kind.kind === "table") {
        const bridge = useTableViewBridge.getState();
        const ok = bridge.setViewOf(active.id, "structure");
        if (ok) {
          // Espera o StructurePane montar antes de pedir edit.
          setTimeout(() => bridge.startEditOf(active.id), 50);
          return;
        }
      }

      // Case 2: sidebar selection is a table → open TableView in Structure.
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

  // --- Ctrl+T — new query (on the focused connection, if any) ---
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
        label: useI18n.getState().t("shortcuts.queryLabel"),
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

  // --- Ctrl+Tab / Ctrl+Shift+Tab — navigation ---
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

  // --- F2 — rename the current selection (sidebar) ---
  useShortcut(
    "rename.selected",
    useCallback(async () => {
      const sel = useSidebarSelection.getState().selected;
      if (!sel) return;
      const t = useI18n.getState().t;
      const { ipc } = await import("@/lib/ipc");
      try {
        if (sel.kind === "table") {
          const next = await appPrompt(
            t("shortcuts.renameTablePrompt", { name: sel.table }),
            { defaultValue: sel.table },
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
          const next = await appPrompt(
            t("shortcuts.renameSchemaPrompt", { name: sel.schema }),
            { defaultValue: sel.schema },
          );
          if (!next || !next.trim() || next === sel.schema) return;
          await ipc.db.renameSchema(sel.connectionId, sel.schema, next.trim());
        } else if (sel.kind === "connection") {
          // Open the connection's edit tab.
          useTabs.getState().openOrFocus(
            (tab) =>
              tab.kind.kind === "edit-connection" &&
              tab.kind.connectionId === sel.connectionId,
            () => ({
              label: t("shortcuts.editConnectionLabel"),
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
          const next = await appPrompt(
            t("shortcuts.renameSavedQueryPrompt", { name: q.name }),
            { defaultValue: q.name },
          );
          if (!next || !next.trim() || next === q.name) return;
          await useSavedQueries
            .getState()
            .update(q.id, { name: next.trim(), sql: q.sql, schema: q.schema });
        }
      } catch (e) {
        alert(t("shortcuts.renameFailed", { error: String(e) }));
      }
    }, []),
  );

  // --- Ctrl+, — abrir Settings ---
  useShortcut(
    "global.settings",
    useCallback(() => {
      useTabs.getState().openOrFocus(
        (tab) => tab.kind.kind === "settings",
        () => ({
          label: useI18n.getState().t("shortcuts.settingsLabel"),
          kind: { kind: "settings" },
        }),
      );
    }, []),
  );

  // --- Zoom ---
  // Listener dedicado em CAPTURE phase, antes do sistema de shortcuts.
  // Covers all variations of `=` / `+` / `-` / `_` regardless of layout
  // de teclado (Ctrl+= em US, Ctrl+Shift+= pra gerar +, Ctrl+NumpadAdd,
  // etc). O sistema de shortcuts geral falha em alguns combos por causa
  // of shift/layout; this is the bruteforce that always works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ignore if focus is in an input/editor (AI composer, etc.).
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
  // first; if it fails (e.g., permission not granted because the user
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
