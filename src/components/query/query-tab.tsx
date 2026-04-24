import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Gauge,
  Inbox,
  Loader2,
  Play,
  Save,
  Search,
  Square,
  Wand2,
} from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  type PanelImperativeHandle,
} from "react-resizable-panels";

import type { SQLNamespace } from "@codemirror/lang-sql";

import { useTheme } from "@/state/theme";
import { ipc } from "@/lib/ipc";
import { ExportDialog } from "@/components/export-dialog";
import { writeInMemory } from "@/lib/export";
import { formatSqlText } from "@/lib/sql-format";
import type { QueryRunBatch, QueryRunResult, Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { appPrompt } from "@/state/app-dialog";
import { useActiveInfo } from "@/state/active-info";
import { useTabState } from "@/state/tab-state";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useQueryTabBridge } from "@/state/query-tab-bridge";
import { useSavedQueries } from "@/state/saved-queries";
import { useSchemaCache } from "@/state/schema-cache";
import { useTabs } from "@/state/tabs";

import { SearchBar, type SearchState } from "@/components/grid/search-bar";
import { useGridSearch } from "@/lib/use-grid-search";

import { QueryEditor } from "./query-editor";
import { ResultGrid, type ResultGridHandle } from "./result-grid";
import { ExplainView } from "./explain-view";

interface QueryTabProps {
  tabId: string;
  connectionId: Uuid;
  initialSchema?: string;
  initialSql?: string;
  autoRun?: boolean;
  /** Se setado, Ctrl+S atualiza essa saved_query em vez de criar uma nova. */
  savedQueryId?: Uuid;
  savedQueryName?: string;
}

type ResultView = number | "messages" | "summary";

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "results"; batch: QueryRunBatch; view: ResultView }
  | {
      kind: "explain";
      driver: string;
      raw: unknown;
      rawText: string;
      /** Columns + rows of classic EXPLAIN (MySQL). PG: undefined. */
      classicColumns?: string[];
      classicRows?: import("@/lib/types").Value[][];
      sql: string;
      elapsedMs: number;
      schema: string | null;
      connectionName: string;
      timestamp: number;
    }
  | { kind: "error"; message: string };

export function QueryTab({
  tabId,
  connectionId,
  initialSchema,
  initialSql,
  autoRun,
  savedQueryId,
  savedQueryName,
}: QueryTabProps) {
  const t = useT();
  const theme = useTheme((s) => s.effectiveMode());
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );
  const isActive = useConnections((s) => s.active.has(connectionId));
  const openConn = useConnections((s) => s.open);
  const cache = useSchemaCache((s) => s.caches[connectionId]);

  // Auto-connect: when the tab mounts (or becomes active after app restart)
  // and the connection isn't open yet, open it in the background. Avoids
  // the "connection not open" error on the first run.
  useEffect(() => {
    if (!conn || isActive) return;
    void openConn(connectionId).catch((e) =>
      console.warn("[query-tab] auto-open failed:", e),
    );
  }, [conn, isActive, connectionId, openConn]);
  const ensureSchemas = useSchemaCache((s) => s.ensureSchemas);
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const patchTab = useTabs((s) => s.patch);
  const setLive = useActiveInfo((s) => s.patch);
  const clearLive = useActiveInfo((s) => s.clear);
  const patchQueryState = useTabState((s) => s.patchQuery);
  const createSaved = useSavedQueries((s) => s.create);
  const updateSaved = useSavedQueries((s) => s.update);
  // Current name of the linked saved query (lives in local state because
  // the tab may have just created one — before refresh via tab kind).
  const [currentSavedId, setCurrentSavedId] = useState<Uuid | null>(
    savedQueryId ?? null,
  );
  const [currentSavedName, setCurrentSavedName] = useState<string | null>(
    savedQueryName ?? null,
  );
  /** "Clean" SQL we compare against to detect dirty state. Initialized
   *  with the SQL at mount (restored snap, initialSql, or default) and
   *  only advances when the user saves. CRITICAL: use lazy init — the
   *  snap changes on every keystroke (patchQueryState persists sql to
   *  tab-state), so we CAN'T recompute this on render. */
  const [savedSqlBaseline, setSavedSqlBaseline] = useState<string>(
    () =>
      useTabState.getState().queryOf(tabId)?.sql ??
      initialSql ??
      "SELECT 1;",
  );

  // Read the persisted snapshot from tab-state — survives detach/reattach
  // and (later) app restart. `getState()` without subscribing — only used
  // for initial seeding.
  const snap = useTabState.getState().queryOf(tabId);
  const [sql, setSql] = useState(
    () => snap?.sql ?? initialSql ?? "SELECT 1;",
  );
  const [schema, setSchema] = useState<string | null>(
    snap?.schema ?? initialSchema ?? conn?.default_database ?? null,
  );
  // Simple dirty check: current sql differs from the baseline (stable —
  // only changes on save). Works for both ad-hoc and linked saved_query.
  const dirty = sql !== savedSqlBaseline;
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState<SearchState>({
    value: "",
    mode: "dado",
    caseSensitive: false,
    regex: false,
  });
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const editorPanelRef = useRef<PanelImperativeHandle | null>(null);
  const gridRef = useRef<ResultGridHandle | null>(null);

  // Expose setSql to the AI agent (via bridge) while this tab is
  // mounted. Unregisters on unmount.
  useEffect(() => {
    useQueryTabBridge.getState().register(tabId, setSql);
    return () => {
      useQueryTabBridge.getState().unregister(tabId);
    };
  }, [tabId]);

  const sqlRef = useRef(sql);
  const schemaRef = useRef(schema);
  useEffect(() => {
    sqlRef.current = sql;
  }, [sql]);
  useEffect(() => {
    schemaRef.current = schema;
  }, [schema]);

  // Publish editor content for the tear-off to read + persist in tab-state
  // (localStorage) to survive detach/reattach and restart.
  useEffect(() => {
    setLive(tabId, { editorSql: sql, editorSchema: schema ?? undefined });
    patchQueryState(tabId, { sql, schema: schema ?? undefined });
  }, [tabId, sql, schema, setLive, patchQueryState]);

  const handleFormat = () => {
    const formatted = formatSqlText(sql, conn?.driver);
    if (formatted !== sql) setSql(formatted);
  };

  /** Incremental token to invalidate old runs when the user clicks Stop
   *  or triggers a new Run. The backend keeps executing (sqlx can't cancel
   *  easily), but we ignore the late result. */
  const runTokenRef = useRef(0);

  const runSql = async (sqlNow: string, schemaNow: string | null) => {
    const token = ++runTokenRef.current;
    setRun({ kind: "running" });
    const started = performance.now();
    try {
      // Fallback: ensure the connection is open before running. The
      // useEffect above already tries to open on mount, but running the
      // query may arrive first if the user is fast.
      if (!useConnections.getState().active.has(connectionId)) {
        await openConn(connectionId);
      }
      if (runTokenRef.current !== token) return;
      const batch = await ipc.db.runQuery(connectionId, sqlNow, schemaNow);
      if (runTokenRef.current !== token) return; // abortado
      const elapsed = Math.round(performance.now() - started);
      const initialView: ResultView = batch.results.length > 0 ? 0 : "summary";
      setRun({ kind: "results", batch, view: initialView });
      const rowsAffected = batch.results.reduce(
        (a, r) => a + (r.kind === "modify" ? r.rows_affected : 0),
        0,
      );
      ipc.queryHistory
        .insert(connectionId, {
          sql: sqlNow,
          schema: schemaNow,
          elapsed_ms: elapsed,
          rows_affected: rowsAffected > 0 ? rowsAffected : null,
          success: true,
        })
        .catch((err) => console.warn("query_history insert:", err));
    } catch (e) {
      if (runTokenRef.current !== token) return;
      const elapsed = Math.round(performance.now() - started);
      setRun({ kind: "error", message: String(e) });
      ipc.queryHistory
        .insert(connectionId, {
          sql: sqlNow,
          schema: schemaNow,
          elapsed_ms: elapsed,
          success: false,
          error_msg: String(e),
        })
        .catch((err) => console.warn("query_history insert:", err));
    }
  };

  const handleRun = () => runSql(sqlRef.current, schemaRef.current);

  const handleStop = () => {
    // Invalidate the in-flight run — backend keeps going until it finishes, but we ignore it.
    runTokenRef.current++;
    setRun({ kind: "error", message: t("query.cancelledByUser") });
  };

  const extractExplainJsonText = (batch: QueryRunBatch): string | null => {
    // Both drivers return the JSON in a single column of the first row
    // of the first SELECT. PG may come as jsonb (type=json) or string;
    // MySQL always comes as a string. If split across multiple rows, joins them.
    for (const r of batch.results) {
      if (r.kind !== "select") continue;
      const pieces: string[] = [];
      for (const row of r.rows) {
        const cell = row[0];
        if (!cell) continue;
        if (cell.type === "json") {
          return JSON.stringify(cell.value);
        }
        if (cell.type === "string") {
          pieces.push(cell.value);
        }
      }
      if (pieces.length > 0) return pieces.join("\n");
    }
    return null;
  };

  const handleExplain = async () => {
    const sqlNow = sqlRef.current.trim().replace(/;\s*$/, "");
    if (!sqlNow) return;
    const isPg = conn?.driver === "postgres";
    const prefixJson = isPg
      ? "EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS)"
      : "EXPLAIN FORMAT=JSON";
    const token = ++runTokenRef.current;
    setRun({ kind: "running" });
    const started = performance.now();
    try {
      if (!useConnections.getState().active.has(connectionId)) {
        await useConnections.getState().open(connectionId);
      }
      if (runTokenRef.current !== token) return;

      // Run in parallel: JSON (for tree/stats/flame) and classic (for the Grid).
      const jsonP = ipc.db.runQuery(
        connectionId,
        `${prefixJson} ${sqlNow}`,
        schemaRef.current,
      );
      const classicP = isPg
        ? Promise.resolve(null)
        : ipc.db
            .runQuery(connectionId, `EXPLAIN ${sqlNow}`, schemaRef.current)
            .catch(() => null);
      const [jsonBatch, classicBatch] = await Promise.all([jsonP, classicP]);
      if (runTokenRef.current !== token) return;

      const rawText = extractExplainJsonText(jsonBatch);
      if (!rawText) {
        setRun({
          kind: "error",
          message:
            "EXPLAIN não retornou JSON — driver pode não suportar FORMAT JSON.",
        });
        return;
      }
      let parsed: unknown = rawText;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        /* already parsed */
      }

      let classicColumns: string[] | undefined;
      let classicRows: import("@/lib/types").Value[][] | undefined;
      if (classicBatch) {
        const firstSelect = classicBatch.results.find(
          (r) => r.kind === "select",
        );
        if (firstSelect && firstSelect.kind === "select") {
          classicColumns = firstSelect.columns;
          classicRows = firstSelect.rows;
        }
      }

      setRun({
        kind: "explain",
        driver: conn?.driver ?? "unknown",
        raw: parsed,
        rawText,
        classicColumns,
        classicRows,
        sql: sqlNow,
        elapsedMs: Math.round(performance.now() - started),
        schema: schemaRef.current,
        connectionName: conn?.name ?? "—",
        timestamp: Date.now(),
      });
    } catch (e) {
      if (runTokenRef.current !== token) return;
      setRun({ kind: "error", message: String(e) });
    }
  };

  const handleRunRef = useRef(handleRun);
  useEffect(() => {
    handleRunRef.current = handleRun;
  });

  /** Saves the query (creates new or updates the linked one). Prompts for
   *  a name only when there's no saved query associated with this tab. */
  const handleSave = async () => {
    const sqlNow = sqlRef.current;
    const schemaNow = schemaRef.current;
    if (!sqlNow.trim()) {
      alert(t("query.nothingToSaveEmpty"));
      return;
    }
    try {
      if (currentSavedId) {
        const saved = await updateSaved(currentSavedId, {
          name: currentSavedName ?? t("query.savedQueryFallbackName"),
          sql: sqlNow,
          schema: schemaNow,
        });
        setCurrentSavedName(saved.name);
        setSavedSqlBaseline(saved.sql);
        // Atualiza o Tab kind pra persistir em restart/detach.
        patchTab(tabId, {
          label: saved.name,
          kind: {
            kind: "query",
            connectionId,
            schema: schemaNow ?? undefined,
            initialSql: saved.sql,
            savedQueryId: saved.id,
            savedQueryName: saved.name,
          },
        });
      } else {
        const name = await appPrompt(t("query.savedQueryNamePrompt"), {
          defaultValue: t("query.savedQueryDefaultName"),
        });
        if (!name || !name.trim()) return;
        const saved = await createSaved(connectionId, {
          name: name.trim(),
          sql: sqlNow,
          schema: schemaNow,
        });
        setCurrentSavedId(saved.id);
        setCurrentSavedName(saved.name);
        setSavedSqlBaseline(saved.sql);
        patchTab(tabId, {
          label: saved.name,
          kind: {
            kind: "query",
            connectionId,
            schema: schemaNow ?? undefined,
            initialSql: saved.sql,
            savedQueryId: saved.id,
            savedQueryName: saved.name,
          },
        });
      }
    } catch (e) {
      alert(t("query.saveFailed", { error: String(e) }));
    }
  };

  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  });

  useEffect(() => {
    ensureSchemas(connectionId)
      .then((schemas) => {
        if (schema || schemas.length === 0) return;
        const preferred = conn?.default_database
          ? schemas.find((s) => s.name === conn.default_database)
          : undefined;
        setSchema(preferred?.name ?? schemas[0].name);
      })
      .catch((e) => console.error("ensureSchemas:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  useEffect(() => {
    if (!schema) return;
    ensureSnapshot(connectionId, schema).catch((e) =>
      console.error("ensureSnapshot:", e),
    );
  }, [connectionId, schema, ensureSnapshot]);

  useEffect(() => {
    const base = currentSavedName
      ? currentSavedName
      : schema
        ? t("tree.queryLabel", { name: schema })
        : t("shortcuts.queryLabel");
    const label = dirty ? `* ${base}` : base;
    patchTab(tabId, {
      label,
      accentColor: conn?.color,
      dirty,
    });
  }, [schema, tabId, conn?.color, patchTab, currentSavedName, dirty, t]);

  // Auto-run quando vem de double-click etc.
  useEffect(() => {
    if (autoRun && initialSql) handleRunRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global shortcuts (capture phase) — only fire while the tab is mounted (key=active.id).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditor = target?.closest(".cm-editor");
      // If focus is in an input/textarea/contenteditable OUTSIDE the
      // query editor, don't swallow shortcuts — prevents the agent input's
      // Ctrl+Enter from running the query, for example.
      const inOtherEditable =
        target &&
        !inEditor &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inOtherEditable) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleRunRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (inEditor) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  // Search no resultado focado.
  const focusedResult =
    run.kind === "results" && typeof run.view === "number"
      ? run.batch.results[run.view]
      : null;
  const focusedColumns =
    focusedResult?.kind === "select" ? focusedResult.columns : [];
  const focusedRows =
    focusedResult?.kind === "select" ? focusedResult.rows : [];
  const { matches, index: matchIndex, prev: matchPrev, next: matchNext } =
    useGridSearch(search, focusedColumns, focusedRows);

  const focused = matches.length > 0 ? matches[matchIndex] : null;
  const focusedCell =
    searchOpen && focused && search.mode === "dado" ? focused : null;
  const focusedColumn =
    searchOpen && focused && search.mode === "campo" ? focused[0] : null;

  useEffect(() => {
    if (!focused) return;
    const [col, row] = focused;
    if (search.mode === "campo") {
      gridRef.current?.scrollToColumn(col);
    } else {
      gridRef.current?.scrollToCell(col, row);
    }
  }, [focused, search.mode]);

  // Syncs "live" tab information to the status bar.
  useEffect(() => {
    if (run.kind !== "results") {
      clearLive(tabId);
      return;
    }
    if (typeof run.view === "number") {
      const r = run.batch.results[run.view];
      if (!r) return;
      setLive(tabId, {
        currentSql: r.sql,
        totalRows: r.kind === "select" ? r.rows.length : undefined,
        elapsedMs: r.elapsed_ms,
        cellCol: undefined,
        cellRow: undefined,
      });
    } else {
      setLive(tabId, {
        currentSql: undefined,
        totalRows: undefined,
        elapsedMs: undefined,
        cellCol: undefined,
        cellRow: undefined,
      });
    }
  }, [run, tabId, setLive, clearLive]);

  // Cleanup ao desmontar a aba.
  useEffect(() => {
    return () => clearLive(tabId);
  }, [tabId, clearLive]);

  const sqlSchema: SQLNamespace = useMemo(() => {
    if (!cache || !schema) return {};
    const tables = cache.tables[schema] ?? [];
    const cols = cache.columns[schema] ?? {};
    const tablesNs: Record<string, string[]> = {};
    for (const t of tables) {
      tablesNs[t.name] = (cols[t.name] ?? []).map((c) => c.name);
    }
    return { [schema]: tablesNs } as SQLNamespace;
  }, [cache, schema]);

  const toggleEditor = () => {
    const panel = editorPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        schemas={cache?.schemas?.map((s) => s.name) ?? []}
        schema={schema}
        onSchema={setSchema}
        running={run.kind === "running"}
        onRun={handleRun}
        onStop={handleStop}
        onExplain={handleExplain}
        onFormat={handleFormat}
        editorCollapsed={editorCollapsed}
        onToggleEditor={toggleEditor}
        onOpenSearch={() => setSearchOpen(true)}
        onSave={handleSave}
        dirty={dirty}
        isLinkedSavedQuery={!!currentSavedId}
        onExport={
          focusedResult?.kind === "select" ? () => setExportOpen(true) : undefined
        }
      />
      {focusedResult?.kind === "select" && (
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          columns={focusedResult.columns}
          rowCount={focusedResult.rows.length}
          defaultName={currentSavedName ?? t("query.defaultResultName")}
          onExport={async ({ format, columns, path }) => {
            if (focusedResult.kind !== "select") return;
            // Fatia colunas + rows no cliente.
            const keep: number[] = [];
            for (let i = 0; i < focusedResult.columns.length; i++) {
              if (columns.includes(focusedResult.columns[i])) keep.push(i);
            }
            const sliced = focusedResult.rows.map((r) =>
              keep.map((i) => r[i]),
            );
            await writeInMemory(path, format, columns, sliced);
          }}
        />
      )}

      <div className="min-h-0 flex-1">
        <Group orientation="vertical">
          <Panel
            panelRef={editorPanelRef}
            defaultSize={45}
            minSize={10}
            collapsible
            collapsedSize={0}
            onResize={(size) =>
              setEditorCollapsed(size.asPercentage === 0)
            }
          >
            <div className="h-full bg-card/20">
              <QueryEditor
                value={sql}
                onChange={setSql}
                onRun={handleRun}
                onFormat={handleFormat}
                schema={sqlSchema}
                defaultSchema={schema ?? undefined}
              />
            </div>
          </Panel>
          <Separator
            className={cn(
              "h-1 cursor-row-resize bg-border transition-colors",
              "hover:bg-conn-accent data-[active]:bg-conn-accent",
            )}
          />
          <Panel defaultSize={55} minSize={10}>
            <div className="flex h-full flex-col bg-background">
              <SearchBar
                open={searchOpen}
                onClose={() => setSearchOpen(false)}
                onChange={setSearch}
                matchCount={matches.length}
                matchIndex={matchIndex}
                onPrev={matchPrev}
                onNext={matchNext}
              />
              <div className="min-h-0 flex-1">
                <ResultArea
                  state={run}
                  theme={theme}
                  searchValue={search.mode === "dado" ? search.value : ""}
                  searchResults={search.mode === "dado" ? matches : undefined}
                  focusedCell={focusedCell}
                  focusedColumn={focusedColumn}
                  accentColor={conn?.color ?? null}
                  gridRef={gridRef}
                  onSelectView={(view) =>
                    setRun((s) => (s.kind === "results" ? { ...s, view } : s))
                  }
                  onCellSelect={(cell) =>
                    setLive(tabId, {
                      cellCol: cell?.[0],
                      cellRow: cell?.[1],
                    })
                  }
                />
              </div>
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  );
}

function Toolbar({
  schemas,
  schema,
  onSchema,
  running,
  onRun,
  onStop,
  onExplain,
  onFormat,
  editorCollapsed,
  onToggleEditor,
  onOpenSearch,
  onSave,
  dirty,
  isLinkedSavedQuery,
  onExport,
}: {
  schemas: string[];
  schema: string | null;
  onSchema: (s: string | null) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
  onExplain: () => void;
  onFormat: () => void;
  editorCollapsed: boolean;
  onToggleEditor: () => void;
  onOpenSearch: () => void;
  onSave: () => void;
  dirty: boolean;
  isLinkedSavedQuery: boolean;
  /** Triggers the export flow — undefined = no exportable result-set. */
  onExport?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-10 items-center gap-3 border-b border-border bg-card/30 px-3">
      <button
        type="button"
        onClick={onToggleEditor}
        className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={editorCollapsed ? t("query.toolbarExpand") : t("query.toolbarCollapse")}
      >
        {editorCollapsed ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" />
        )}
      </button>

      <select
        value={schema ?? ""}
        onChange={(e) => onSchema(e.target.value || null)}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring/30"
      >
        <option value="">{t("query.noSchema")}</option>
        {schemas.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={onFormat}
        className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t("query.toolbarFormat")}
      >
        <Wand2 className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={onSave}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
          dirty
            ? "bg-amber-500/20 text-amber-500 hover:bg-amber-500/30"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        title={
          isLinkedSavedQuery
            ? dirty
              ? t("query.toolbarSaveLinkedDirty")
              : t("query.toolbarSaveLinkedClean")
            : t("query.toolbarSaveNew")
        }
      >
        <Save className="h-3.5 w-3.5" />
        {isLinkedSavedQuery
          ? dirty
            ? t("query.toolbarSaveDirty")
            : t("query.toolbarSaveClean")
          : t("query.toolbarSave")}
      </button>

      {onExport && (
        <button
          type="button"
          onClick={onExport}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("query.toolbarExport")}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onOpenSearch}
        className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t("query.toolbarSearch")}
      >
        <Search className="h-3.5 w-3.5" />
      </button>

      {running ? (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground shadow-sm transition-opacity hover:opacity-90"
          title={t("query.toolbarStopTitle")}
        >
          <Square className="h-3 w-3 fill-current" />
          {t("query.toolbarStop")}
        </button>
      ) : (
        <div className="inline-flex rounded-md bg-conn-accent text-conn-accent-foreground shadow-sm">
          <button
            type="button"
            onClick={onRun}
            className="inline-flex items-center gap-1.5 rounded-l-md px-3 py-1 text-xs font-medium transition-opacity hover:opacity-90"
          >
            <Play className="h-3 w-3 fill-current" />
            {t("query.toolbarRun")}
            <kbd className="ml-1 rounded bg-black/20 px-1 py-px text-[9px] font-mono tracking-wider">
              Ctrl ↵
            </kbd>
          </button>
          <div className="w-px bg-black/20" />
          <button
            type="button"
            onClick={onExplain}
            className="inline-flex items-center gap-1 rounded-r-md px-2 py-1 text-xs font-medium transition-opacity hover:opacity-90"
            title={t("query.toolbarExplainTitle")}
          >
            <Gauge className="h-3 w-3" />
            {t("query.toolbarExplain")}
          </button>
        </div>
      )}
    </div>
  );
}

function ResultArea({
  state,
  theme,
  searchValue,
  searchResults,
  focusedCell,
  focusedColumn,
  accentColor,
  gridRef,
  onSelectView,
  onCellSelect,
}: {
  state: RunState;
  theme: "dark" | "light";
  searchValue: string;
  searchResults?: ReadonlyArray<readonly [number, number]>;
  focusedCell?: readonly [number, number] | null;
  focusedColumn?: number | null;
  accentColor?: string | null;
  gridRef: React.RefObject<ResultGridHandle | null>;
  onSelectView: (view: ResultView) => void;
  onCellSelect: (cell: readonly [number, number] | undefined) => void;
}) {
  const t = useT();
  if (state.kind === "idle") {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">
          {t("query.idleHint", { kbd: "Ctrl + Enter" })}
        </p>
      </Centered>
    );
  }
  if (state.kind === "running") {
    return (
      <Centered>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">{t("query.runningLabel")}</span>
      </Centered>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="h-full overflow-auto p-4">
        <pre
          className={cn(
            "rounded-md border border-destructive/30 bg-destructive/5 p-4",
            "font-mono text-xs leading-relaxed text-destructive whitespace-pre-wrap break-words",
          )}
        >
          {state.message}
        </pre>
      </div>
    );
  }
  if (state.kind === "explain") {
    return (
      <ExplainView
        driver={state.driver}
        raw={state.raw}
        rawText={state.rawText}
        classicColumns={state.classicColumns}
        classicRows={state.classicRows}
        sql={state.sql}
        elapsedMs={state.elapsedMs}
        schema={state.schema}
        connectionName={state.connectionName}
        timestamp={state.timestamp}
      />
    );
  }

  const { batch, view } = state;
  return (
    <div className="flex h-full flex-col">
      <ResultTabs
        batch={batch}
        view={view}
        onSelect={onSelectView}
      />
      <div className="min-h-0 flex-1">
        {typeof view === "number" ? (
          <ResultPane
            result={batch.results[view]}
            theme={theme}
            searchValue={searchValue}
            searchResults={searchResults}
            focusedCell={focusedCell}
            focusedColumn={focusedColumn}
            accentColor={accentColor}
            gridRef={gridRef}
            onCellSelect={onCellSelect}
          />
        ) : view === "messages" ? (
          <MessagesPane batch={batch} />
        ) : (
          <SummaryPane batch={batch} onJumpTo={onSelectView} />
        )}
      </div>
    </div>
  );
}

function ResultTabs({
  batch,
  view,
  onSelect,
}: {
  batch: QueryRunBatch;
  view: ResultView;
  onSelect: (view: ResultView) => void;
}) {
  const t = useT();
  return (
    <div className="flex h-7 shrink-0 items-stretch overflow-x-auto border-b border-border bg-card/30">
      {batch.results.map((r, i) => {
        const active = view === i;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSelect(i)}
            className={cn(
              "flex items-center gap-1.5 border-r border-border px-3 text-[11px] tabular-nums transition-colors",
              active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
            title={r.sql}
          >
            <ResultBadge result={r} index={i} />
          </button>
        );
      })}

      <FixedTab
        active={view === "messages"}
        onClick={() => onSelect("messages")}
        icon={<FileText className="h-3 w-3" />}
        label={t("query.messagesTab")}
      />
      <FixedTab
        active={view === "summary"}
        onClick={() => onSelect("summary")}
        icon={<Inbox className="h-3 w-3" />}
        label={t("query.summaryTab")}
      />
    </div>
  );
}

function FixedTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border-r border-border px-3 text-[11px] transition-colors",
        active
          ? "bg-background text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ResultBadge({
  result,
  index,
}: {
  result: QueryRunResult;
  index: number;
}) {
  const t = useT();
  if (result.kind === "select") {
    return (
      <>
        <span className="font-medium">#{index + 1}</span>
        <span className="opacity-70">{t("query.rowsBadge", { n: result.rows.length })}</span>
      </>
    );
  }
  if (result.kind === "modify") {
    return (
      <>
        <span className="font-medium">#{index + 1}</span>
        <span className="opacity-70">{t("query.affectedBadge", { n: result.rows_affected })}</span>
      </>
    );
  }
  return (
    <>
      <AlertCircle className="h-3 w-3 text-destructive" />
      <span className="font-medium">#{index + 1}</span>
      <span className="text-destructive opacity-90">{t("query.errorBadge")}</span>
    </>
  );
}

function ResultPane({
  result,
  theme,
  searchValue,
  searchResults,
  focusedCell,
  focusedColumn,
  accentColor,
  gridRef,
  onCellSelect,
}: {
  result: QueryRunResult;
  theme: "dark" | "light";
  searchValue: string;
  searchResults?: ReadonlyArray<readonly [number, number]>;
  focusedCell?: readonly [number, number] | null;
  focusedColumn?: number | null;
  accentColor?: string | null;
  gridRef: React.RefObject<ResultGridHandle | null>;
  onCellSelect: (cell: readonly [number, number] | undefined) => void;
}) {
  const t = useT();
  if (result.kind === "error") {
    return (
      <div className="h-full overflow-auto p-4">
        <pre
          className={cn(
            "rounded-md border border-destructive/30 bg-destructive/5 p-4",
            "font-mono text-xs leading-relaxed text-destructive whitespace-pre-wrap break-words",
          )}
        >
          {result.message}
        </pre>
      </div>
    );
  }
  if (result.kind === "modify") {
    const n = result.rows_affected;
    const text = t("query.rowsAffected", { n, s: n === 1 ? "" : "s" });
    return (
      <Centered>
        <span className="text-sm text-foreground">
          {text}
          {result.last_insert_id
            ? ` · last_insert_id ${result.last_insert_id}`
            : ""}{" "}
          · {result.elapsed_ms} ms
        </span>
      </Centered>
    );
  }
  if (result.rows.length === 0) {
    return (
      <Centered>
        <span className="text-sm text-muted-foreground">
          {t("query.noRows")}
        </span>
      </Centered>
    );
  }
  return (
    <ResultGrid
      ref={gridRef}
      columns={result.columns}
      rows={result.rows}
      theme={theme}
      searchValue={searchValue}
      searchResults={searchResults}
      focusedCell={focusedCell}
      focusedColumn={focusedColumn}
      accentColor={accentColor}
      onCellSelect={onCellSelect}
    />
  );
}

function MessagesPane({ batch }: { batch: QueryRunBatch }) {
  const t = useT();
  if (batch.results.length === 0) {
    return (
      <Centered>
        <span className="text-sm text-muted-foreground">
          {t("query.noStatements")}
        </span>
      </Centered>
    );
  }
  return (
    <div className="h-full overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
      {batch.results.map((r, i) => (
        <div key={i} className={cn(i > 0 && "mt-4")}>
          <pre className="whitespace-pre text-foreground/90">{r.sql}</pre>
          <div
            className={cn(
              r.kind === "error" ? "text-destructive" : "text-emerald-500",
            )}
          >
            {r.kind === "error"
              ? t("query.errorMsg", { message: r.message })
              : t("query.okLabel")}
          </div>
          {r.kind === "select" && (
            <div className="text-muted-foreground">
              {t("query.rowsReturned", {
                n: r.rows.length,
                word:
                  r.rows.length === 1
                    ? t("query.lineSingular")
                    : t("query.linePlural"),
                s: r.rows.length === 1 ? "" : "s",
              })}
            </div>
          )}
          {r.kind === "modify" && (
            <div className="text-muted-foreground">
              {t("query.rowsAffectedMsg", {
                n: r.rows_affected,
                s: r.rows_affected === 1 ? "" : "s",
              })}
              {r.last_insert_id != null
                ? t("query.insertIdMsg", { id: r.last_insert_id })
                : ""}
            </div>
          )}
          <div className="text-muted-foreground">
            {t("query.queryTime", { t: formatSeconds(r.elapsed_ms) })}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3).replace(".", ",")}s`;
}

function SummaryPane({
  batch,
  onJumpTo,
}: {
  batch: QueryRunBatch;
  onJumpTo: (view: ResultView) => void;
}) {
  const t = useT();
  const total = batch.results.length;
  const errors = batch.results.filter((r) => r.kind === "error").length;
  const success = total - errors;
  const totalRows = batch.results.reduce(
    (acc, r) => acc + (r.kind === "select" ? r.rows.length : 0),
    0,
  );
  const totalAffected = batch.results.reduce(
    (acc, r) => acc + (r.kind === "modify" ? r.rows_affected : 0),
    0,
  );

  return (
    <div className="h-full overflow-auto p-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mb-5">
        <Stat label={t("query.statStatements")} value={String(total)} />
        <Stat label={t("query.statSuccess")} value={String(success)} tone="ok" />
        <Stat label={t("query.statErrors")} value={String(errors)} tone={errors > 0 ? "err" : "muted"} />
        <Stat label={t("query.statTotal")} value={`${batch.total_ms} ms`} />
      </div>

      <div className="mb-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {t("query.rangeStart", {
            start: formatStamp(batch.started_at_ms),
            end: formatStamp(batch.finished_at_ms),
          })}
        </span>
        {totalRows > 0 && <span>{t("query.totalRows", { n: totalRows })}</span>}
        {totalAffected > 0 && (
          <span>{t("query.totalAffected", { n: totalAffected })}</span>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-card/40 text-muted-foreground">
              <Th className="w-[50px]">{t("query.colNum")}</Th>
              <Th>{t("query.colSql")}</Th>
              <Th className="w-[100px]">{t("query.colStatus")}</Th>
              <Th className="w-[120px]">{t("query.colReturn")}</Th>
              <Th className="w-[80px] text-right">{t("query.colMs")}</Th>
            </tr>
          </thead>
          <tbody>
            {batch.results.map((r, i) => (
              <tr
                key={i}
                onClick={() => onJumpTo(i)}
                className="cursor-pointer border-t border-border hover:bg-accent/30"
              >
                <Td className="text-muted-foreground tabular-nums">{i + 1}</Td>
                <Td className="font-mono text-[11px]">
                  <code className="line-clamp-1 break-all">
                    {truncate(r.sql, 140)}
                  </code>
                </Td>
                <Td>
                  {r.kind === "error" ? (
                    <span className="inline-flex items-center gap-1 text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      {t("query.errorShort")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-500">
                      <CheckCircle2 className="h-3 w-3" />
                      {t("query.okShort")}
                    </span>
                  )}
                </Td>
                <Td className="tabular-nums text-muted-foreground">
                  {r.kind === "select" && t("query.rowsBadge", { n: r.rows.length })}
                  {r.kind === "modify" &&
                    `${t("query.affectedBadge", { n: r.rows_affected })}${r.last_insert_id ? t("query.insertId", { id: r.last_insert_id }) : ""}`}
                  {r.kind === "error" && (
                    <span
                      className="line-clamp-2 break-words font-mono text-[11px] text-destructive"
                      title={r.message}
                    >
                      {r.message}
                    </span>
                  )}
                </Td>
                <Td className="text-right tabular-nums text-muted-foreground">
                  {r.elapsed_ms}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "err" | "muted";
}) {
  return (
    <div className="rounded-md border border-border bg-card/40 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "ok" && "text-emerald-500",
          tone === "err" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-wider",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={cn("px-3 py-1.5 align-top", className)}>{children}</td>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("pt-BR", { hour12: false });
}
