import { useEffect, useMemo } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowLeftToLine } from "lucide-react";

import { AiApprovalDialog } from "@/components/ai-approval-dialog";
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

const REATTACH_EVENT = "basemaster://reattach-tab";

export type DetachedPayload =
  | {
      kind: "table";
      connectionId: string;
      schema: string;
      table: string;
      accentColor: string | null;
      label: string;
      /** Nome legível pra aba quando devolvida (p.ex. "users"). */
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
    return () => {
      disposeA();
      disposeB();
    };
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
      // Auto-reabre conexões referenciadas por abas restauradas.
      // Fire-and-forget em paralelo — cada TableView/QueryTab tem seu
      // próprio loading/retry quando a conexão ficar active.
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
        open(id).catch((e) => console.warn("auto-open conn falhou:", id, e));
      }
    })();
  }, [refresh]);

  // Escuta pedido de reattach vindo de uma janela destacada: rehydrata
  // o tab-state (pra ver as escritas da destacada no localStorage),
  // reserva um id novo, transfere state label → novo id (ANTES do
  // render), e só então cria a aba. Assim QueryTab/TableView já leem
  // state correto no initial useState.
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
      <ShortcutBindings />
      <ShortcutsCheatsheet />
      <CommandPalette />
    </div>
  );
}

/** Versão sem sidebar / sem tab bar — usada nas janelas destacadas.
 *  Header fino com "Devolver" que emite o payload de volta pra principal
 *  e fecha via command Rust (evita permissions JS-side). */
function DetachedApp({ payload }: { payload: DetachedPayload }) {
  const refresh = useConnections((s) => s.refresh);
  const t = useT();
  useEffect(() => {
    refresh();
  }, [refresh]);

  const reattach = async () => {
    try {
      // Rebuild do payload com o state atual — se for query, usa o
      // SQL e schema mais recentes do editor (tab-state). Também
      // garante que o tab-state foi flushed pro localStorage antes
      // do main rehidratar.
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
      // Pequena folga pra main processar o event antes de fechar.
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
