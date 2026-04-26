import { useEffect, useMemo } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowLeftToLine } from "lucide-react";

import { AiApprovalDialog } from "@/components/ai-approval-dialog";
import { AppDialog } from "@/components/app-dialog";
import { DangerousQueryDialog } from "@/components/dangerous-query-dialog";
import { DestructiveConfirmDialog } from "@/components/destructive-confirm-dialog";
import { SshHostKeyDialog } from "@/components/ssh-host-key-dialog";
import { UpdateDialog } from "@/components/update-dialog";
import { AiSidebar } from "@/components/layout/ai-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { ShortcutBindings } from "@/components/shortcut-bindings";
import { ShortcutsCheatsheet } from "@/components/shortcuts-cheatsheet";
import { ConnForm } from "@/components/conn-form";
import { Sidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { TabBar } from "@/components/layout/tab-bar";
import { QueryTab } from "@/components/query/query-tab";
import { TableView } from "@/components/table/table-view";
import { TabErrorBoundary } from "@/components/tab-error-boundary";
import { DataTransferWizard } from "@/components/data-transfer-wizard";
import { CreateTableDialog } from "@/components/create-table-dialog";
import { DataImportView } from "@/components/data-import-view";
import { NewTableView } from "@/components/new-table-view";
import { DockerDiscoverDialog } from "@/components/docker-discover-dialog";
import { GlobalExportDialog } from "@/components/global-export-dialog";
import { ProcessListView } from "@/components/process-list-view";
import { UsersView } from "@/components/users-view";
import { QueryHistoryView } from "@/components/query-history-view";
import { SavedQueriesListView } from "@/components/saved-queries-list-view";
import { SettingsView } from "@/components/settings-view";
import { SqlDumpView } from "@/components/sql-dump-view";
import { SqlImportView } from "@/components/sql-import-view";
import { TablesListView } from "@/components/tables-list-view";
import { Welcome } from "@/components/welcome";
import { installBrowserDefaultPrevention } from "@/lib/browser-defaults";
import { ipc } from "@/lib/ipc";
import { installGlobalShortcuts } from "@/lib/shortcuts/use-shortcuts";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useTabState } from "@/state/tab-state";
import { useTabs, type Tab } from "@/state/tabs";
import { installThemeEffect } from "@/state/theme";
import { useUpdater } from "@/state/updater";

const REATTACH_EVENT = "basemaster://reattach-tab";

export type DetachedPayload =
  | {
      kind: "table";
      connectionId: string;
      schema: string;
      table: string;
      accentColor: string | null;
      label: string;
      /** Readable tab name when returned (e.g. "users"). */
      displayLabel: string;
    }
  | {
      kind: "query";
      connectionId: string;
      schema?: string;
      initialSql: string;
      accentColor: string | null;
      label: string;
      displayLabel: string;
    };

function readDetachedPayload(): DetachedPayload | null {
  try {
    const label = getCurrentWebviewWindow().label;
    if (!label.startsWith("detached-")) return null;
    const raw = window.localStorage.getItem(`${label}:payload`);
    if (!raw) return null;
    return JSON.parse(raw) as DetachedPayload;
  } catch {
    return null;
  }
}

export default function App() {
  const detached = useMemo(readDetachedPayload, []);
  if (detached) return <DetachedApp payload={detached} />;
  return <MainApp />;
}

function MainApp() {
  const refresh = useConnections((s) => s.refresh);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const openTab = useTabs((s) => s.open);

  useEffect(() => {
    const disposeA = installGlobalShortcuts();
    const disposeB = installBrowserDefaultPrevention();
    const disposeC = installThemeEffect();
    return () => {
      disposeA();
      disposeB();
      disposeC();
    };
  }, []);

  // Update check on boot: silent=true respects versions in the
  // "ignore this version" list. Short delay to avoid fighting the initial paint.
  // In dev the endpoint isn't available and the check always fails, so
  // gate by DEV to avoid polluting logs/UI.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const t = setTimeout(() => {
      void useUpdater.getState().checkNow({ silent: true });
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
      // Auto-reopen connections referenced by restored tabs.
      // Fire-and-forget in parallel — each TableView/QueryTab has its
      // own loading/retry once the connection becomes active.
      const { connections, active, open } = useConnections.getState();
      const existingIds = new Set(connections.map((c) => c.id));
      const needed = new Set<string>();
      for (const tab of useTabs.getState().tabs) {
        const k = tab.kind;
        if (
          (k.kind === "table" || k.kind === "query") &&
          k.connectionId &&
          existingIds.has(k.connectionId) &&
          !active.has(k.connectionId)
        ) {
          needed.add(k.connectionId);
        }
      }
      for (const id of needed) {
        open(id).catch((e) => console.warn("auto-open conn failed:", id, e));
      }
    })();
  }, [refresh]);

  // Listens for reattach request from a detached window: rehydrates
  // the tab-state (to see the detached window's writes in localStorage),
  // reserves a new id, transfers state label → new id (BEFORE
  // render), and only then creates the tab. That way QueryTab/TableView
  // already read correct state on the initial useState.
  const reserveId = useTabs((s) => s.reserveId);
  useEffect(() => {
    const unlistenPromise = listen<DetachedPayload>(REATTACH_EVENT, async (e) => {
      const p = e.payload;
      if (!p) return;
      try {
        await useTabState.persist.rehydrate();
      } catch (err) {
        console.error("tab-state rehydrate:", err);
      }
      const newTabId = reserveId();
      useTabState.getState().move(p.label, newTabId, true);
      if (p.kind === "table") {
        openTab(
          {
            label: p.displayLabel,
            kind: {
              kind: "table",
              connectionId: p.connectionId,
              schema: p.schema,
              table: p.table,
            },
            accentColor: p.accentColor ?? null,
          },
          newTabId,
        );
      } else if (p.kind === "query") {
        openTab(
          {
            label: p.displayLabel,
            kind: {
              kind: "query",
              connectionId: p.connectionId,
              schema: p.schema,
              initialSql: p.initialSql,
            },
            accentColor: p.accentColor ?? null,
          },
          newTabId,
        );
      }
      void getCurrentWebviewWindow().setFocus();
    });
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [openTab, reserveId]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  return (
    <div
      className="flex h-screen w-screen overflow-hidden"
      style={
        active?.accentColor
          ? ({ "--conn-accent": active.accentColor } as React.CSSProperties)
          : undefined
      }
    >
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <main className="min-h-0 flex-1 overflow-hidden bg-background">
          {active ? (
            <TabErrorBoundary key={active.id}>
              <TabContent tab={active} />
            </TabErrorBoundary>
          ) : (
            <EmptyMain />
          )}
        </main>
        <StatusBar />
      </div>
      <AiSidebar />
      <GlobalExportDialog />
      <CreateTableDialog />
      <DockerDiscoverDialog />
      <AiApprovalDialog />
      <AppDialog />
      <DestructiveConfirmDialog />
      <SshHostKeyDialog />
      <DangerousQueryDialog />
      <ShortcutBindings />
      <ShortcutsCheatsheet />
      <CommandPalette />
      <UpdateDialog />
    </div>
  );
}

/** Version without sidebar / tab bar — used in detached windows.
 *  Thin header with "Return" that emits the payload back to the main
 *  window and closes via Rust command (avoids JS-side permissions). */
function DetachedApp({ payload }: { payload: DetachedPayload }) {
  const refresh = useConnections((s) => s.refresh);
  const t = useT();
  useEffect(() => {
    refresh();
  }, [refresh]);

  const reattach = async () => {
    try {
      // Rebuild the payload with current state — for query, use the
      // latest SQL and schema from the editor (tab-state). Also
      // ensures the tab-state was flushed to localStorage before
      // the main window rehydrates.
      const live = useTabState.getState().queryOf(payload.label);
      const fresh: DetachedPayload =
        payload.kind === "query"
          ? {
              ...payload,
              initialSql: live?.sql ?? payload.initialSql,
              schema: live?.schema ?? payload.schema,
            }
          : payload;
      await emit(REATTACH_EVENT, fresh);
      // Small delay for main to process the event before closing.
      window.setTimeout(() => {
        void ipc.window.close(payload.label).catch(console.error);
      }, 80);
    } catch (e) {
      console.error("reattach:", e);
      alert(t("app.returnTabFailed", { error: String(e) }));
    }
  };

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={
        payload.accentColor
          ? ({ "--conn-accent": payload.accentColor } as React.CSSProperties)
          : undefined
      }
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card/40 px-2 text-[11px]">
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-conn-accent"
          aria-hidden
        />
        <span className="truncate font-medium text-muted-foreground">
          {payload.displayLabel}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={reattach}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("tabs.returnToMainHint")}
          >
            <ArrowLeftToLine className="h-3 w-3" />
            {t("tabs.returnToMain")}
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden bg-background">
        <TabErrorBoundary key={payload.label}>
          {payload.kind === "table" ? (
            <TableView
              tabId={payload.label}
              connectionId={payload.connectionId}
              schema={payload.schema}
              table={payload.table}
            />
          ) : (
            <QueryTab
              tabId={payload.label}
              connectionId={payload.connectionId}
              initialSchema={payload.schema}
              initialSql={payload.initialSql}
            />
          )}
        </TabErrorBoundary>
      </main>
    </div>
  );
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind.kind) {
    case "welcome":
      return <Welcome />;
    case "new-connection":
      return <ConnForm tabId={tab.id} />;
    case "edit-connection":
      return <ConnForm tabId={tab.id} editingId={tab.kind.connectionId} />;
    case "query":
      return (
        <QueryTab
          tabId={tab.id}
          connectionId={tab.kind.connectionId}
          initialSchema={tab.kind.schema}
          initialSql={tab.kind.initialSql}
          autoRun={tab.kind.autoRun}
          savedQueryId={tab.kind.savedQueryId}
          savedQueryName={tab.kind.savedQueryName}
        />
      );
    case "table":
      return (
        <TableView
          tabId={tab.id}
          connectionId={tab.kind.connectionId}
          schema={tab.kind.schema}
          table={tab.kind.table}
          initialView={tab.kind.initialView}
          initialEdit={tab.kind.initialEdit}
        />
      );
    case "settings":
      return <SettingsView />;
    case "tables-list":
      return (
        <TablesListView
          tabId={tab.id}
          connectionId={tab.kind.connectionId}
          schema={tab.kind.schema}
          category={tab.kind.category}
        />
      );
    case "saved-queries-list":
      return (
        <SavedQueriesListView
          connectionId={tab.kind.connectionId}
          schema={tab.kind.schema}
        />
      );
    case "query-history":
      return <QueryHistoryView connectionId={tab.kind.connectionId} />;
    case "processes":
      return <ProcessListView connectionId={tab.kind.connectionId} />;
    case "users":
      return <UsersView connectionId={tab.kind.connectionId} />;
    case "data-import":
      return (
        <DataImportView
          initialConnectionId={tab.kind.connectionId}
          initialSchema={tab.kind.schema}
          initialTable={tab.kind.table}
        />
      );
    case "new-table":
      return (
        <NewTableView
          tabId={tab.id}
          connectionId={tab.kind.connectionId}
          schema={tab.kind.schema}
        />
      );
    case "sql-dump":
      return (
        <SqlDumpView
          tabId={tab.id}
          sourceConnectionId={tab.kind.sourceConnectionId}
          scopes={tab.kind.scopes}
        />
      );
    case "sql-import":
      return (
        <SqlImportView
          tabId={tab.id}
          targetConnectionId={tab.kind.targetConnectionId}
          schema={tab.kind.schema}
        />
      );
    case "data-transfer":
      return (
        <DataTransferWizard
          tabId={tab.id}
          initialSourceConnectionId={tab.kind.sourceConnectionId}
          initialSourceSchema={tab.kind.sourceSchema}
          initialTargetConnectionId={tab.kind.targetConnectionId}
          initialTargetSchema={tab.kind.targetSchema}
          initialTables={tab.kind.tables}
          initialAutoAdvance={tab.kind.autoAdvance}
        />
      );
  }
}

function EmptyMain() {
  const t = useT();
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      {t("tabs.noTabs")}
    </div>
  );
}
