import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Columns3,
  Copy,
  Download,
  Upload,
  Eraser,
  LayoutGrid,
  Rows3,
  EyeOff,
  FileCode2,
  Filter as FilterIcon,
  Loader2,
  XCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";

import {
  useContextMenu,
  type ContextEntry,
} from "@/hooks/use-context-menu";
import { useTheme } from "@/state/theme";
import { ExportDialog } from "@/components/export-dialog";
import { RecordFormView } from "@/components/table/record-form-view";
import { writeInMemory } from "@/lib/export";
import { formatValue, isNullish } from "@/lib/format-value";
import { ipc } from "@/lib/ipc";
import type {
  CellEdit,
  Column,
  FilterNode,
  OrderBy,
  PkEntry,
  QueryResult,
  SortDir,
  Uuid,
  Value,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useActiveInfo } from "@/state/active-info";
import { appConfirm } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useI18n, useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";
import { useTableViewBridge } from "@/state/table-view-bridge";
import { useTabState } from "@/state/tab-state";
import { useTabs } from "@/state/tabs";

import {
  ResultGrid,
  type ResultGridHandle,
} from "../query/result-grid";
import {
  FilterBar,
  countLeaves,
  emptyRoot,
  leavesToTree,
} from "./filter-bar";
import { SearchBar, type SearchState } from "../grid/search-bar";
import { useGridSearch } from "@/lib/use-grid-search";
import { StructurePane } from "./structure-pane";

interface TableViewProps {
  tabId: string;
  connectionId: Uuid;
  schema: string;
  table: string;
  /** View inicial — default "data". */
  initialView?: "data" | "structure";
  /** Se true + initialView=structure → entra em edit mode direto. */
  initialEdit?: boolean;
}

const LIMIT_OPTIONS: { label: string; value: number }[] = [
  { label: "100", value: 100 },
  { label: "200", value: 200 },
  { label: "500", value: 500 },
  { label: "1000", value: 1000 },
  { label: "", value: 0 },
];

type View = "data" | "structure";

const EMPTY_SEARCH: SearchState = {
  value: "",
  mode: "dado",
  caseSensitive: false,
  regex: false,
};

export function TableView({
  tabId,
  connectionId,
  schema,
  table,
  initialView = "data",
  initialEdit = false,
}: TableViewProps) {
  const theme = useTheme((s) => s.effectiveMode());
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );
  const connActive = useConnections((s) => s.active.has(connectionId));
  const openConn = useConnections((s) => s.open);
  const [connOpening, setConnOpening] = useState(false);
  const [connOpenError, setConnOpenError] = useState<string | null>(null);
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const patchTab = useTabs((s) => s.patch);
  const t = useT();
  const setLive = useActiveInfo((s) => s.patch);
  const clearLive = useActiveInfo((s) => s.clear);

  // Seed inicial a partir do tab-state persistido (sobrevive a
  // detach/reattach e futuramente restart do app).
  const initialTabState = useTabState.getState().tableOf(tabId);
  const patchTableState = useTabState((s) => s.patchTable);

  const [view, setView] = useState<View>(initialView);

  // Bridge pra Ctrl+D / AI poder alternar sub-tab de fora.
  useEffect(() => {
    useTableViewBridge.getState().register(tabId, setView);
    return () => {
      useTableViewBridge.getState().unregister(tabId);
    };
  }, [tabId]);
  // Modo visual dentro da aba "Dados": grid tradicional ou form record-by-record.
  const [dataView, setDataView] = useState<"grid" | "form">(() => {
    if (typeof window === "undefined") return "grid";
    return window.localStorage.getItem("basemaster.tableDataView") === "form"
      ? "form"
      : "grid";
  });
  useEffect(() => {
    window.localStorage.setItem("basemaster.tableDataView", dataView);
  }, [dataView]);
  const [page, setPage] = useState(initialTabState?.page ?? 0);
  const [limit, setLimit] = useState(initialTabState?.limit ?? 200);
  const [orderBy, setOrderBy] = useState<OrderBy | null>(
    initialTabState?.orderBy ?? null,
  );
  // V2: filters as a tree. Migrates the V1 flat format automatically.
  const [filterTree, setFilterTree] = useState<FilterNode>(
    initialTabState?.filterTree ??
      (initialTabState?.filters
        ? leavesToTree(initialTabState.filters)
        : emptyRoot()),
  );
  const filterCount = countLeaves(filterTree);
  const [filterBarOpen, setFilterBarOpen] = useState(filterCount > 0);
  const [count, setCount] = useState<number | null>(null);
  const [data, setData] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);

  // Edits pendentes — chave "row:col" → snapshot (linha original + texto novo).
  // Cleared when page/limit/sort/refresh changes.
  const [dirty, setDirty] = useState<Map<string, PendingEdit>>(new Map());
  // Rows marked for DELETE (row index on the current page).
  const [rowsToDelete, setRowsToDelete] = useState<Set<number>>(new Set());
  // Novas linhas pendentes de INSERT — array de maps (colName → texto).
  const [newRows, setNewRows] = useState<Array<Map<string, string>>>([]);
  // How many of them have at least 1 filled cell (= ready to INSERT).
  const filledNewRowsCount = useMemo(
    () => newRows.filter((m) => m.size > 0).length,
    [newRows],
  );
  const [hasSelection, setHasSelection] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Hidden columns (names) — visual filter. Doesn't affect SELECT or dirty.
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(
    new Set(initialTabState?.hiddenColumns ?? []),
  );
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false);

  const gridRef = useRef<ResultGridHandle | null>(null);

  // Detecta PKs da tabela atual via schema-cache.
  const cachedColumns = useSchemaCache(
    (s) => s.caches[connectionId]?.columns[schema]?.[table],
  );
  const pkColumns = useMemo(
    () =>
      (cachedColumns ?? [])
        .filter((c) => c.is_primary_key)
        .map((c) => c.name),
    [cachedColumns],
  );
  // No PK: editable, but the UPDATE/DELETE WHERE uses all "comparable"
  // columns (skip BLOB/JSON for safety). The backend's LIMIT 1 keeps
  // the scope to 1 row even with duplicates. The user gets an explicit
  // confirm on Apply to know they're operating without a PK.
  const editable = true;
  const noPk = pkColumns.length === 0;
  /** Columns usable in WHERE when there's no PK — avoids comparing BLOB/JSON. */
  const matchableColumns = useMemo(() => {
    if (!noPk || !cachedColumns) return null;
    return cachedColumns
      .filter((c) => {
        const k = c.column_type.kind;
        return k !== "blob" && k !== "json";
      })
      .map((c) => c.name);
  }, [noPk, cachedColumns]);

  useEffect(() => {
    patchTab(tabId, {
      label: table,
      accentColor: conn?.color,
    });
  }, [tabId, table, conn?.color, patchTab]);

  // Mark the tab as dirty whenever there are unapplied edits — triggers
  // confirm on close. Covers cell edits, deletions, and new rows.
  const hasPendingChanges =
    dirty.size > 0 || rowsToDelete.size > 0 || filledNewRowsCount > 0;
  useEffect(() => {
    patchTab(tabId, { dirty: hasPendingChanges });
  }, [tabId, hasPendingChanges, patchTab]);

  useEffect(() => {
    if (!connActive) return;
    ensureSnapshot(connectionId, schema).catch((e) =>
      console.error("ensureSnapshot:", e),
    );
  }, [connectionId, schema, ensureSnapshot, connActive]);

  // Auto-try to open the connection if this tab was restored but the
  // conn isn't active yet. Surface the error to the placeholder.
  const tryOpenConn = () => {
    if (connActive || connOpening || !conn) return;
    setConnOpening(true);
    setConnOpenError(null);
    openConn(connectionId)
      .catch((e) => {
        console.warn("open conn falhou:", e);
        setConnOpenError(String(e));
      })
      .finally(() => setConnOpening(false));
  };
  useEffect(() => {
    tryOpenConn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, connActive, conn]);

  const loadCount = async () => {
    try {
      const c = await ipc.db.tableCount(connectionId, schema, table);
      setCount(c);
    } catch (e) {
      console.error("tableCount:", e);
      setCount(null);
    }
  };
  useEffect(() => {
    if (!connActive) return;
    loadCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, table, connActive]);

  const reqIdRef = useRef(0);
  const loadPage = async () => {
    setLoading(true);
    setError(null);
    const myReq = ++reqIdRef.current;
    try {
      const r = await ipc.db.tablePage(connectionId, schema, table, {
        limit,
        offset: limit > 0 ? page * limit : 0,
        order_by: orderBy ?? undefined,
        filter_tree: filterCount > 0 ? filterTree : null,
      });
      if (myReq !== reqIdRef.current) return;
      setData(applySavedColumnOrder(r, useTabState.getState().tableOf(tabId)?.columnOrder));
      setDirty(new Map());
      setRowsToDelete(new Set());
      setNewRows([]);
      setApplyError(null);
      requestAnimationFrame(() => gridRef.current?.scrollToTop());
    } catch (e) {
      if (myReq !== reqIdRef.current) return;
      setError(String(e));
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  };

  const scrollAfterLayout = (
    col: number,
    row: number,
    align: "start" | "center" | "end" = "end",
  ) => {
    // setTimeout with enough delay for Glide's ResizeObserver to have
    // already reflected the new height (caused by the footer appearing).
    // Isolated RAFs were running before the resize and Glide was scrolling
    // using stale dimensions.
    window.setTimeout(() => {
      gridRef.current?.scrollToCell(col, row, align);
    }, 80);
  };

  const handleCellEdit = (col: number, row: number, newText: string) => {
    if (!data) return;
    const existingLen = data.rows.length;
    if (row >= existingLen) {
      const newIdx = row - existingLen;
      setNewRows((prev) => {
        if (newIdx >= prev.length) return prev;
        const next = prev.slice();
        const m = new Map(next[newIdx]);
        const colName = data.columns[col];
        if (newText === "") m.delete(colName);
        else m.set(colName, newText);
        next[newIdx] = m;
        return next;
      });
      scrollAfterLayout(col, row);
      return;
    }
    const original = data.rows[row]?.[col];
    const originalRow = data.rows[row];
    if (!originalRow) return;
    setDirty((d) => {
      const next = new Map(d);
      const key = `${row}:${col}`;
      const originalText = original ? formatValueForEdit(original) : "";
      if (newText === originalText) {
        next.delete(key);
      } else {
        next.set(key, { row, col, originalRow, newText, intent: "edit" });
      }
      return next;
    });
    scrollAfterLayout(col, row);
  };

  const handleAppendRow = (focusCol = 0) => {
    const newRowIdx = (data?.rows.length ?? 0) + newRows.length;
    setNewRows((prev) => [...prev, new Map()]);
    // Select the cell in the column the user was already on (arrow-down)
    // instead of jumping to col 0.
    window.setTimeout(() => {
      gridRef.current?.selectCell(focusCol, newRowIdx);
    }, 80);
  };

  /** Aplica edits batched (ex.: paste). Se o paste passou do fim, cria
   *  novas linhas automaticamente pra acomodar. */
  const handleBatchEdit = (
    edits: Array<{ col: number; row: number; text: string }>,
  ) => {
    if (!data || edits.length === 0) return;
    const existingLen = data.rows.length;

    const existingEdits: typeof edits = [];
    // Novas linhas por offset: offset → (colName → text)
    const newRowEdits = new Map<number, Map<string, string>>();

    for (const { col, row, text } of edits) {
      if (row < existingLen) {
        existingEdits.push({ col, row, text });
      } else {
        const offset = row - existingLen;
        if (!newRowEdits.has(offset)) newRowEdits.set(offset, new Map());
        newRowEdits.get(offset)!.set(data.columns[col], text);
      }
    }

    if (existingEdits.length > 0) {
      setDirty((d) => {
        const next = new Map(d);
        for (const { col, row, text } of existingEdits) {
          const originalRow = data.rows[row];
          const original = originalRow?.[col];
          if (!originalRow) continue;
          const key = `${row}:${col}`;
          const originalText = original ? formatValueForEdit(original) : "";
          if (text === originalText) {
            next.delete(key);
          } else {
            next.set(key, {
              row,
              col,
              originalRow,
              newText: text,
              intent: "edit",
            });
          }
        }
        return next;
      });
    }

    if (newRowEdits.size > 0) {
      const maxOffset = Math.max(...newRowEdits.keys());
      setNewRows((prev) => {
        const next = prev.slice();
        while (next.length <= maxOffset) next.push(new Map());
        for (const [offset, colMap] of newRowEdits) {
          const merged = new Map(next[offset]);
          for (const [colName, text] of colMap) {
            if (text === "") merged.delete(colName);
            else merged.set(colName, text);
          }
          next[offset] = merged;
        }
        return next;
      });
    }

    // Scroll to the last row touched.
    const lastRow = Math.max(...edits.map((e) => e.row));
    scrollAfterLayout(0, lastRow);
  };

  const handleDeleteCells = (
    cells: Array<readonly [number, number]>,
  ) => {
    if (!data) return;
    const existingLen = data.rows.length;
    setDirty((d) => {
      const next = new Map(d);
      for (const [col, row] of cells) {
        if (row >= existingLen) continue; // novas rows tratadas separado
        const originalRow = data.rows[row];
        if (!originalRow) continue;
        const original = originalRow[col];
        const isAlreadyNull = original ? original.type === "null" : true;
        const key = `${row}:${col}`;
        if (isAlreadyNull) {
          next.delete(key);
        } else {
          next.set(key, {
            row,
            col,
            originalRow,
            newText: "",
            intent: "null",
          });
        }
      }
      return next;
    });
    // Cells em linhas NOVAS: limpa o valor (volta pra placeholder).
    setNewRows((prev) => {
      const mutated = prev.map((m) => new Map(m));
      for (const [col, row] of cells) {
        if (row < existingLen) continue;
        const newIdx = row - existingLen;
        if (newIdx < mutated.length) {
          mutated[newIdx].delete(data.columns[col]);
        }
      }
      return mutated;
    });
  };

  const handleDeleteRows = (rowIdxs: number[]) => {
    if (!data) return;
    const existingLen = data.rows.length;
    const toMarkDelete = rowIdxs.filter((r) => r < existingLen);
    const newRowIdxsToRemove = rowIdxs
      .filter((r) => r >= existingLen)
      .map((r) => r - existingLen);

    if (toMarkDelete.length > 0) {
      setRowsToDelete((prev) => {
        const next = new Set(prev);
        for (const r of toMarkDelete) next.add(r);
        return next;
      });
      setDirty((d) => {
        const next = new Map(d);
        for (const k of Array.from(next.keys())) {
          const r = Number(k.split(":")[0]);
          if (toMarkDelete.includes(r)) next.delete(k);
        }
        return next;
      });
    }
    if (newRowIdxsToRemove.length > 0) {
      const toRemove = new Set(newRowIdxsToRemove);
      setNewRows((prev) => prev.filter((_, i) => !toRemove.has(i)));
    }
  };

  const handleDiscard = () => {
    setDirty(new Map());
    setRowsToDelete(new Set());
    setNewRows([]);
    setApplyError(null);
  };

  /** Physical reorder of columns (drag on the header). Reorganizes
   *  data.columns + each row in data.rows and remaps the dirty keys
   *  (row:colIdx). */
  const handleColumnMoved = (from: number, to: number) => {
    if (!data) return;
    if (from === to) return;
    const permutation = reorderPermutation(data.columns.length, from, to);
    // old→new: after the permutation, the column that was at old index i
    // ends up at permutation.indexOf(i).
    const oldToNew: number[] = new Array(data.columns.length);
    for (let newIdx = 0; newIdx < permutation.length; newIdx++) {
      oldToNew[permutation[newIdx]] = newIdx;
    }
    setData((prev) => {
      if (!prev) return prev;
      const newCols = permutation.map((i) => prev.columns[i]);
      const newRows = prev.rows.map((r) => permutation.map((i) => r[i]));
      return { ...prev, columns: newCols, rows: newRows };
    });
    setDirty((d) => {
      if (d.size === 0) return d;
      const next = new Map<string, PendingEdit>();
      for (const [key, edit] of d) {
        const [rowStr, colStr] = key.split(":");
        const row = Number(rowStr);
        const oldCol = Number(colStr);
        const newCol = oldToNew[oldCol];
        // originalRow na PendingEdit foi capturada em ordem antiga — reordena
        // pra bater com a nova ordem de columns.
        const newOriginalRow = permutation.map((i) => edit.originalRow[i]);
        next.set(`${row}:${newCol}`, {
          ...edit,
          col: newCol,
          originalRow: newOriginalRow,
        });
      }
      return next;
    });
  };

  /** Set literal empty string ("") — distinct from NULL. Only makes sense on
   *  linhas existentes (em novas, ausente = NULL). */
  const handleSetEmpty = (col: number, row: number) => {
    if (!data) return;
    if (row >= data.rows.length) return;
    const originalRow = data.rows[row];
    if (!originalRow) return;
    const original = originalRow[col];
    const isAlreadyEmpty =
      original?.type === "string" && original.value === "";
    setDirty((d) => {
      const next = new Map(d);
      const key = `${row}:${col}`;
      if (isAlreadyEmpty) next.delete(key);
      else {
        next.set(key, {
          row,
          col,
          originalRow,
          newText: "",
          intent: "empty",
        });
      }
      return next;
    });
  };

  // Context menu (right-click em cell). Itens re-gerados por click — o hook
  // cuida do fechamento/tecla Esc. Os callbacks capturam col/row no fechamento
  // do handler abaixo.
  const [cellMenuItems, setCellMenuItems] = useState<ContextEntry[]>([]);
  const cellMenu = useContextMenu(cellMenuItems);

  // Context menu do header (right-click). Ordenar, ocultar.
  const [headerMenuItems, setHeaderMenuItems] = useState<ContextEntry[]>([]);
  const headerMenu = useContextMenu(headerMenuItems);

  const handleHeaderContextMenu = (
    col: number,
    x: number,
    y: number,
  ) => {
    if (!data) return;
    const colName = data.columns[col];
    if (!colName) return;
    const isAsc = orderBy?.column === colName && orderBy.direction === "asc";
    const isDesc = orderBy?.column === colName && orderBy.direction === "desc";

    const items: ContextEntry[] = [
      {
        icon: <ArrowUpNarrowWide className="h-3.5 w-3.5" />,
        label: t("table.headerMenu.asc"),
        disabled: isAsc,
        onClick: () => {
          setOrderBy({ column: colName, direction: "asc" });
          setPage(0);
        },
      },
      {
        icon: <ArrowDownNarrowWide className="h-3.5 w-3.5" />,
        label: t("table.headerMenu.desc"),
        disabled: isDesc,
        onClick: () => {
          setOrderBy({ column: colName, direction: "desc" });
          setPage(0);
        },
      },
    ];
    if (orderBy?.column === colName) {
      items.push({
        icon: <XCircle className="h-3.5 w-3.5" />,
        label: t("table.headerMenu.clearOrder"),
        onClick: () => setOrderBy(null),
      });
    }
    items.push({ separator: true });
    items.push({
      icon: <EyeOff className="h-3.5 w-3.5" />,
      label: t("table.headerMenu.hide"),
      // Never allow hiding the last visible column — otherwise the grid becomes NaN.
      disabled: hiddenColumns.size >= data.columns.length - 1,
      onClick: () => {
        setHiddenColumns((prev) => {
          const next = new Set(prev);
          next.add(colName);
          return next;
        });
      },
    });

    setHeaderMenuItems(items);
    headerMenu.openAtPos(x, y);
  };

  const handleCellContextMenu = (
    col: number,
    row: number,
    x: number,
    y: number,
  ) => {
    if (!data) return;
    const colName = data.columns[col];
    if (!colName) return;
    const existingLen = data.rows.length;
    const isNewRow = row >= existingLen;

    // Resolve texto + null status da cell considerando dirty / newRows.
    let currentText: string;
    let currentIsNull: boolean;
    if (isNewRow) {
      const rowMap = newRows[row - existingLen];
      const typed = rowMap?.get(colName);
      if (typed === undefined) {
        currentText = "";
        currentIsNull = true;
      } else {
        currentText = typed;
        currentIsNull = false;
      }
    } else {
      const key = `${row}:${col}`;
      const pending = dirty.get(key);
      if (pending) {
        if (pending.intent === "null") {
          currentText = "";
          currentIsNull = true;
        } else {
          currentText = pending.newText;
          currentIsNull = false;
        }
      } else {
        const v = data.rows[row]?.[col];
        currentText = formatValue(v);
        currentIsNull = isNullish(v);
      }
    }

    const items: ContextEntry[] = [
      {
        icon: <Copy className="h-3.5 w-3.5" />,
        label: t("table.cellMenu.copy"),
        shortcut: "Ctrl+C",
        onClick: () => {
          void navigator.clipboard.writeText(currentText);
        },
      },
      {
        icon: <FileCode2 className="h-3.5 w-3.5" />,
        label: t("table.cellMenu.copyAsSql"),
        onClick: () => {
          void navigator.clipboard.writeText(
            textToSqlLiteral(currentIsNull ? null : currentText),
          );
        },
      },
    ];
    if (editable) {
      // For existing rows: detect whether it's already an empty string to disable.
      const alreadyEmpty = (() => {
        if (isNewRow) return false;
        const key = `${row}:${col}`;
        const pending = dirty.get(key);
        if (pending) return pending.intent === "empty";
        const v = data.rows[row]?.[col];
        return v?.type === "string" && v.value === "";
      })();

      items.push({ separator: true });
      items.push({
        icon: <Ban className="h-3.5 w-3.5" />,
        label: t("table.cellMenu.setNull"),
        disabled: currentIsNull,
        variant: "destructive",
        onClick: () => handleDeleteCells([[col, row]]),
      });
      items.push({
        icon: <Eraser className="h-3.5 w-3.5" />,
        label: t("table.cellMenu.setEmpty"),
        disabled: isNewRow || alreadyEmpty,
        onClick: () => handleSetEmpty(col, row),
      });
    }

    setCellMenuItems(items);
    cellMenu.openAtPos(x, y);
  };

  /** Builds the "row key" that goes in the UPDATE/DELETE WHERE: PK if
   *  any, otherwise all "comparable" columns of the original row. */
  const buildRowKey = (originalRow: Value[]): PkEntry[] => {
    if (!data) return [];
    if (pkColumns.length > 0) {
      return pkColumns.map((pkName) => {
        const idx = data.columns.indexOf(pkName);
        return {
          column: pkName,
          value: originalRow[idx] ?? { type: "null" },
        };
      });
    }
    const cols = matchableColumns ?? data.columns;
    return cols.map((colName) => {
      const idx = data.columns.indexOf(colName);
      return {
        column: colName,
        value: originalRow[idx] ?? { type: "null" },
      };
    });
  };

  const handleApply = async () => {
    if (
      !data ||
      (dirty.size === 0 && rowsToDelete.size === 0 && newRows.length === 0)
    )
      return;
    // No PK: confirm before applying. The user needs to know that
    // UPDATE/DELETE will match the row by full value + LIMIT 1.
    if (noPk && (dirty.size > 0 || rowsToDelete.size > 0)) {
      const matchableCount =
        matchableColumns?.length ?? data.columns.length;
      const skippedCount = data.columns.length - matchableCount;
      const skipped =
        skippedCount > 0
          ? t("table.noPk.skippedSuffix", { n: skippedCount })
          : "";
      const warn = [
        t("table.noPk.confirmTitle"),
        "",
        t("table.noPk.confirmBody", { count: matchableCount, skipped }),
        "",
        t("table.noPk.dupWarn"),
        "",
        t("table.noPk.continueQ"),
      ].join("\n");
      const ok = await appConfirm(warn);
      if (!ok) return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      const errs: string[] = [];
      // Collect the successes to apply locally (no refetch) —
      // INSERTs promote the newRow with last_insert_id, UPDATEs patch
      // the cell at the index, DELETEs remove it.
      const deletedRowSet = new Set<number>();
      const updatedCells = new Map<string, Value>(); // "row:col" → newValue
      const insertedRows: Array<{ values: Value[] }> = [];

      // 1. DELETE FROM ... WHERE pk (ou WHERE col1=? AND ... sem PK)
      if (rowsToDelete.size > 0) {
        const rowIdxArr = Array.from(rowsToDelete);
        const rowsPayload: PkEntry[][] = [];
        for (const r of rowIdxArr) {
          const originalRow = data.rows[r];
          if (!originalRow) continue;
          rowsPayload.push(buildRowKey(originalRow));
        }
        if (rowsPayload.length > 0) {
          const delRes = await ipc.db.deleteTableRows(
            connectionId,
            schema,
            table,
            rowsPayload,
          );
          delRes.forEach((r, i) => {
            if (r.kind === "err") errs.push(`del #${i + 1}: ${r.message}`);
            else deletedRowSet.add(rowIdxArr[i]);
          });
        }
      }

      // 2. UPDATE cells
      if (dirty.size > 0) {
        const entries = Array.from(dirty.entries());
        const edits: CellEdit[] = entries.map(([, e]) => {
          const colName = data.columns[e.col];
          const rowPk: PkEntry[] = buildRowKey(e.originalRow);
          const newVal: Value = intentToValue(e.intent, e.newText);
          return { row_pk: rowPk, column: colName, new_value: newVal };
        });
        const results = await ipc.db.applyTableEdits(
          connectionId,
          schema,
          table,
          edits,
        );
        results.forEach((r, i) => {
          const [key, e] = entries[i];
          if (r.kind === "err") {
            errs.push(`edit #${i + 1}: ${r.message}`);
          } else {
            updatedCells.set(key, intentToValue(e.intent, e.newText));
          }
        });
      }

      // 3. INSERT INTO ... VALUES — only rows with at least one value.
      const nonEmptyNewRows = newRows.filter((m) => m.size > 0);
      if (nonEmptyNewRows.length > 0) {
        const rowsPayload: PkEntry[][] = nonEmptyNewRows.map((m) =>
          Array.from(m.entries()).map(([column, text]) => ({
            column,
            value: textToValue(text),
          })),
        );
        const insRes = await ipc.db.insertTableRows(
          connectionId,
          schema,
          table,
          rowsPayload,
        );
        insRes.forEach((r, i) => {
          if (r.kind === "err") {
            errs.push(`insert #${i + 1}: ${r.message}`);
            return;
          }
          // Builds the "persisted" row locally: uses the typed values +
          // fills the auto_increment PK with last_insert_id.
          const m = nonEmptyNewRows[i];
          const values: Value[] = data.columns.map((colName) => {
            const typed = m.get(colName);
            if (typed !== undefined) return textToValue(typed);
            const colMeta = cachedColumns?.find((c) => c.name === colName);
            if (
              colMeta?.is_primary_key &&
              colMeta.is_auto_increment &&
              r.last_insert_id > 0
            ) {
              return { type: "u_int", value: r.last_insert_id };
            }
            return { type: "null" };
          });
          insertedRows.push({ values });
        });
      }

      // Apply changes LOCALLY — no refetch. Preserves scroll and keeps
      // new rows at their current position (Navicat-style).
      if (
        deletedRowSet.size > 0 ||
        updatedCells.size > 0 ||
        insertedRows.length > 0
      ) {
        setData((prev) => {
          if (!prev) return prev;
          // UPDATEs primeiro (mutam in-place no row existente).
          let rows = prev.rows.map((row, rIdx) => {
            let mutated: Value[] | null = null;
            for (let c = 0; c < row.length; c++) {
              const v = updatedCells.get(`${rIdx}:${c}`);
              if (v !== undefined) {
                if (!mutated) mutated = row.slice();
                mutated[c] = v;
              }
            }
            return mutated ?? row;
          });
          // DELETEs (descending remove to keep indices valid).
          if (deletedRowSet.size > 0) {
            const sorted = Array.from(deletedRowSet).sort((a, b) => b - a);
            rows = rows.slice();
            for (const r of sorted) rows.splice(r, 1);
          }
          // INSERTs (append no fim).
          if (insertedRows.length > 0) {
            rows = [...rows, ...insertedRows.map((r) => r.values)];
          }
          return { ...prev, rows };
        });
        if (deletedRowSet.size > 0 || insertedRows.length > 0) {
          setCount((c) =>
            c == null
              ? c
              : c - deletedRowSet.size + insertedRows.length,
          );
        }
      }

      // Clear pending state. Errors stay in the footer for the user to
      // see, but dirty/newRows/delete are reset — we assume failures
      // are rare; if needed, the user can refresh or re-edit.
      if (errs.length > 0) {
        setApplyError(errs.join("\n"));
      }
      setDirty(new Map());
      setRowsToDelete(new Set());
      setNewRows([]);
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setApplying(false);
    }
  };
  useEffect(() => {
    if (!connActive) return;
    loadPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, table, page, limit, orderBy, filterTree, connActive]);

  // Status bar live info.
  useEffect(() => {
    setLive(tabId, {
      currentSql: `${schema}.${table}`,
      totalRows: count ?? undefined,
      elapsedMs: data?.elapsed_ms,
    });
  }, [tabId, schema, table, count, data?.elapsed_ms, setLive]);

  // Persiste runtime da tabela no tab-state store (sobrevive a
  // detach/reattach e restart do app). Debounced pelo effect do React.
  useEffect(() => {
    patchTableState(tabId, {
      page,
      limit,
      orderBy,
      hiddenColumns: Array.from(hiddenColumns),
      columnOrder: data?.columns,
      filterTree,
      // V1 legacy — zeroed to avoid confusion on next read.
      filters: undefined,
    });
  }, [tabId, page, limit, orderBy, hiddenColumns, data?.columns, filterTree, patchTableState]);

  const handleFilterTreeChange = (next: FilterNode) => {
    setFilterTree(next);
    setPage(0); // reset pagination on filter change
  };
  useEffect(() => {
    return () => clearLive(tabId);
  }, [tabId, clearLive]);

  // Shortcuts: Ctrl+F (search), F5 (refresh).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        loadCount();
        loadPage();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived maps for the grid (display value + intent → color).
  // Normal edits → yellow. Entirely new row → green via dirtyIntents="new".
  const dirtyValues = useMemo(() => {
    const m = new Map<string, string>();
    for (const [k, e] of dirty) {
      // empty → show the cell empty (the dirty yellow color already
      // distinguishes it from null, which shows "NULL" in red).
      m.set(
        k,
        e.intent === "null" ? "NULL" : e.intent === "empty" ? "" : e.newText,
      );
    }
    // Values for new rows (each filled cell).
    if (data) {
      newRows.forEach((rowMap, newIdx) => {
        const row = data.rows.length + newIdx;
        data.columns.forEach((colName, col) => {
          const text = rowMap.get(colName);
          if (text !== undefined) {
            m.set(`${row}:${col}`, text);
          }
        });
      });
    }
    return m;
  }, [dirty, newRows, data]);
  const dirtyIntents = useMemo(() => {
    const m = new Map<string, "edit" | "null" | "new">();
    for (const [k, e] of dirty) {
      // "empty" reuses "edit" color (yellow) — visually it doesn't break.
      m.set(k, e.intent === "empty" ? "edit" : e.intent);
    }
    // New rows: mark ALL cells as "new" (green).
    if (data) {
      newRows.forEach((_, newIdx) => {
        const row = data.rows.length + newIdx;
        data.columns.forEach((_c, col) => {
          m.set(`${row}:${col}`, "new");
        });
      });
    }
    return m;
  }, [dirty, newRows, data]);

  // Augmented rows: existing + new ones (filled with Null).
  const augmentedRows = useMemo(() => {
    if (!data) return [];
    const placeholder: Value[] = data.columns.map(() => ({ type: "null" }));
    const extras = newRows.map(() => placeholder);
    return [...data.rows, ...extras];
  }, [data, newRows]);

  // columnMeta aligned with the current order of data.columns (which
  // may have been permuted by drag & drop). Without this, typed editors
  // would pick the wrong column after a reorder.
  const orderedColumnMeta = useMemo(() => {
    if (!cachedColumns || !data) return cachedColumns;
    const byName = new Map(cachedColumns.map((c) => [c.name, c]));
    const result = data.columns
      .map((name) => byName.get(name))
      .filter((c): c is Column => !!c);
    return result.length === data.columns.length ? result : cachedColumns;
  }, [cachedColumns, data]);

  // Visual mapping (index passed to Glide) → full (index in data.columns).
  // When there are no hidden columns, becomes identity.
  const visualToFull = useMemo(() => {
    if (!data) return [] as number[];
    if (hiddenColumns.size === 0)
      return data.columns.map((_, i) => i);
    return data.columns
      .map((name, i) => (hiddenColumns.has(name) ? -1 : i))
      .filter((i) => i >= 0);
  }, [data, hiddenColumns]);

  // Everything passed to ResultGrid uses VISUAL order.
  const displayColumns = useMemo(
    () => (data ? visualToFull.map((i) => data.columns[i]) : []),
    [data, visualToFull],
  );
  const displayRows = useMemo(
    () => augmentedRows.map((r) => visualToFull.map((i) => r[i])),
    [augmentedRows, visualToFull],
  );
  const displayColumnMeta = useMemo(() => {
    if (!orderedColumnMeta) return orderedColumnMeta;
    return visualToFull.map((i) => orderedColumnMeta[i]);
  }, [orderedColumnMeta, visualToFull]);

  /** Maps full col idx → visual col idx. Returns -1 if hidden. */
  const fullToVisual = useMemo(() => {
    const m = new Map<number, number>();
    visualToFull.forEach((full, visual) => m.set(full, visual));
    return m;
  }, [visualToFull]);

  // Dirty maps in VISUAL coords (for ResultGrid). Entries in hidden
  // cols are filtered from the display (but remain in state).
  const displayDirtyValues = useMemo(() => {
    if (hiddenColumns.size === 0) return dirtyValues;
    const out = new Map<string, string>();
    for (const [key, val] of dirtyValues) {
      const [r, c] = key.split(":").map(Number);
      const v = fullToVisual.get(c);
      if (v === undefined) continue;
      out.set(`${r}:${v}`, val);
    }
    return out;
  }, [dirtyValues, hiddenColumns, fullToVisual]);
  const displayDirtyIntents = useMemo(() => {
    if (hiddenColumns.size === 0) return dirtyIntents;
    const out = new Map<string, "edit" | "null" | "new">();
    for (const [key, val] of dirtyIntents) {
      const [r, c] = key.split(":").map(Number);
      const v = fullToVisual.get(c);
      if (v === undefined) continue;
      out.set(`${r}:${v}`, val);
    }
    return out;
  }, [dirtyIntents, hiddenColumns, fullToVisual]);

  // Wrappers that translate visual→full before calling handlers. Only
  // used when something is hidden — otherwise reuse the originals
  // directly to avoid allocations.
  const v2f = (v: number) => visualToFull[v] ?? v;
  const visualCellEdit = (col: number, row: number, text: string) =>
    handleCellEdit(v2f(col), row, text);
  const visualBatchEdit = (
    edits: Array<{ col: number; row: number; text: string }>,
  ) => handleBatchEdit(edits.map((e) => ({ ...e, col: v2f(e.col) })));
  const visualDeleteCells = (cells: Array<readonly [number, number]>) =>
    handleDeleteCells(cells.map(([c, r]) => [v2f(c), r] as const));
  const visualCellContextMenu = (
    col: number,
    row: number,
    x: number,
    y: number,
  ) => handleCellContextMenu(v2f(col), row, x, y);
  const visualColumnMoved = (from: number, to: number) =>
    handleColumnMoved(v2f(from), v2f(to));
  const visualHeaderClick = (col: number) => handleHeaderClick(v2f(col));
  const visualHeaderContextMenu = (col: number, x: number, y: number) =>
    handleHeaderContextMenu(v2f(col), x, y);

  // Compute matches + navigation.
  const { matches, index: matchIndex, prev: matchPrev, next: matchNext } =
    useGridSearch(search, data?.columns ?? [], data?.rows ?? []);

  // Focused match (passed as prop to ResultGrid → highlightRegions).
  const focused = matches.length > 0 ? matches[matchIndex] : null;
  const focusedCell =
    searchOpen && focused && search.mode === "dado" ? focused : null;
  const focusedColumn =
    searchOpen && focused && search.mode === "campo" ? focused[0] : null;

  // Scroll para o match.
  useEffect(() => {
    if (!focused) return;
    const [col, row] = focused;
    if (search.mode === "campo") {
      gridRef.current?.scrollToColumn(col);
    } else {
      gridRef.current?.scrollToCell(col, row);
    }
  }, [focused, search.mode]);

  const totalPages = useMemo(() => {
    if (count == null || limit === 0) return null;
    return Math.max(1, Math.ceil(count / limit));
  }, [count, limit]);

  const handleHeaderClick = (col: number) => {
    const colName = data?.columns[col];
    if (!colName) return;
    setOrderBy((prev) => cycleSort(prev, colName));
    setPage(0);
  };

  const refresh = async () => {
    await Promise.all([loadCount(), loadPage()]);
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        connectionId={connectionId}
        schema={schema}
        table={table}
        view={view}
        onView={setView}
        page={page}
        totalPages={totalPages}
        count={count}
        limit={limit}
        onLimit={(l) => {
          setLimit(l);
          setPage(0);
        }}
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() =>
          setPage((p) =>
            totalPages != null ? Math.min(totalPages - 1, p + 1) : p + 1,
          )
        }
        onRefresh={refresh}
        onOpenSearch={() => setSearchOpen(true)}
        onToggleColumns={() => setColumnsPopoverOpen((o) => !o)}
        columnsHidden={hiddenColumns.size}
        onToggleFilters={() => setFilterBarOpen((o) => !o)}
        filterCount={filterCount}
        onDeleteSelected={
          editable && hasSelection
            ? () => gridRef.current?.deleteSelected()
            : undefined
        }
        onAppendRow={editable ? handleAppendRow : undefined}
        onExport={
          data && data.rows.length > 0 ? () => setExportOpen(true) : undefined
        }
        loading={loading}
        orderBy={orderBy}
        onClearOrder={() => setOrderBy(null)}
        dataView={dataView}
        onDataView={setDataView}
      />
      {view === "data" && (
        <SearchBar
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onChange={setSearch}
          matchCount={matches.length}
          matchIndex={matchIndex}
          onPrev={matchPrev}
          onNext={matchNext}
        />
      )}
      {view === "data" && filterBarOpen && data && (
        <FilterBar
          columns={data.columns}
          columnMeta={orderedColumnMeta}
          tree={filterTree}
          onChange={handleFilterTreeChange}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {view === "data" && !connActive ? (
          <ConnectingPlaceholder
            connName={conn?.name ?? connectionId}
            opening={connOpening}
            errorMsg={connOpenError}
            onRetry={tryOpenConn}
          />
        ) : view === "data" && dataView === "form" ? (
          <RecordFormView
            columns={displayColumns}
            rows={displayRows}
            pkColumns={
              data?.source_table
                ? new Set(data.source_table.pk_columns)
                : undefined
            }
            dirtyValues={displayDirtyValues}
            dirtyIntents={displayDirtyIntents as never}
            editable={editable}
            onCellEdit={({ row, col, text, intent }) => {
              const actualCol = v2f(col);
              if (intent === "null") {
                handleDeleteCells([[actualCol, row]]);
              } else if (intent === "empty") {
                handleSetEmpty(actualCol, row);
              } else {
                handleCellEdit(actualCol, row, text);
              }
            }}
          />
        ) : view === "data" ? (
          <DataPane
            data={data}
            displayColumns={displayColumns}
            displayRows={displayRows}
            columnMeta={displayColumnMeta}
            loading={loading}
            error={error}
            theme={theme}
            searchValue={search.mode === "dado" ? search.value : ""}
            searchResults={search.mode === "dado" ? matches : undefined}
            focusedCell={focusedCell}
            focusedColumn={focusedColumn}
            accentColor={conn?.color ?? null}
            editable={editable}
            dirtyValues={displayDirtyValues}
            dirtyIntents={displayDirtyIntents}
            rowsPendingDelete={rowsToDelete}
            onCellEdit={visualCellEdit}
            onBatchEdit={visualBatchEdit}
            onDeleteCells={visualDeleteCells}
            onDeleteRows={handleDeleteRows}
            onSelectionStateChange={setHasSelection}
            onAppendRow={editable ? handleAppendRow : undefined}
            onCellContextMenu={visualCellContextMenu}
            onColumnMoved={visualColumnMoved}
            onCellSelect={(cell) =>
              setLive(tabId, {
                cellCol: cell?.[0],
                cellRow:
                  cell?.[1] != null
                    ? (limit > 0 ? cell[1] + page * limit : cell[1])
                    : undefined,
              })
            }
            onHeaderClick={visualHeaderClick}
            onHeaderContextMenu={visualHeaderContextMenu}
            orderBy={orderBy}
            gridRef={gridRef}
          />
        ) : (
          <StructurePane
            tabId={tabId}
            connectionId={connectionId}
            schema={schema}
            table={table}
            initialEdit={initialEdit}
          />
        )}
        {view === "data" &&
          (dirty.size > 0 ||
            rowsToDelete.size > 0 ||
            filledNewRowsCount > 0) && (
            <DirtyFooter
              editCount={dirty.size}
              deleteCount={rowsToDelete.size}
              insertCount={filledNewRowsCount}
              applying={applying}
              error={applyError}
              onApply={handleApply}
              onDiscard={handleDiscard}
            />
          )}
        {view === "data" && noPk && data && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-2 border-t border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-700 dark:text-amber-400",
            )}
            title={t("table.noPk.bannerTitle")}
          >
            <span className="grid h-4 w-4 place-items-center rounded-full bg-amber-500/20 font-bold leading-none">
              !
            </span>
            <span>{t("table.noPk.banner")}</span>
          </div>
        )}
      </div>
      {cellMenu.element}
      {headerMenu.element}
      {columnsPopoverOpen && data && (
        <ColumnsPopover
          columns={data.columns}
          hidden={hiddenColumns}
          onToggle={(name) => {
            setHiddenColumns((prev) => {
              const next = new Set(prev);
              if (next.has(name)) next.delete(name);
              else next.add(name);
              return next;
            });
          }}
          onShowAll={() => setHiddenColumns(new Set())}
          onClose={() => setColumnsPopoverOpen(false)}
        />
      )}
      {data && (
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          columns={data.columns}
          rowCount={data.rows.length}
          defaultName={`${schema}.${table}`}
          onExport={async ({ format, columns, path }) => {
            const keep: number[] = [];
            for (let i = 0; i < data.columns.length; i++) {
              if (columns.includes(data.columns[i])) keep.push(i);
            }
            const sliced = data.rows.map((r) => keep.map((i) => r[i]));
            await writeInMemory(path, format, columns, sliced);
          }}
        />
      )}
    </div>
  );
}

function Toolbar({
  connectionId,
  schema,
  table,
  view,
  onView,
  page,
  totalPages,
  count,
  limit,
  onLimit,
  onPrev,
  onNext,
  onRefresh,
  onOpenSearch,
  onToggleColumns,
  columnsHidden,
  onToggleFilters,
  filterCount,
  onDeleteSelected,
  onAppendRow,
  onExport,
  loading,
  orderBy,
  onClearOrder,
  dataView,
  onDataView,
}: {
  connectionId: Uuid;
  schema: string;
  table: string;
  view: View;
  onView: (v: View) => void;
  page: number;
  totalPages: number | null;
  count: number | null;
  limit: number;
  onLimit: (l: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onOpenSearch: () => void;
  onToggleColumns: () => void;
  columnsHidden: number;
  onToggleFilters: () => void;
  filterCount: number;
  onDeleteSelected?: () => void;
  onAppendRow?: () => void;
  onExport?: () => void;
  loading: boolean;
  orderBy: OrderBy | null;
  onClearOrder: () => void;
  dataView: "grid" | "form";
  onDataView: (v: "grid" | "form") => void;
}) {
  const showPagination = view === "data" && limit > 0;
  const start = limit > 0 ? page * limit + 1 : 1;
  const end =
    limit > 0
      ? count != null
        ? Math.min(count, (page + 1) * limit)
        : (page + 1) * limit
      : count ?? 0;
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const localeCountFmt = (n: number) =>
    n.toLocaleString(lang === "en" ? "en-US" : "pt-BR");

  return (
    <div className="flex h-10 items-center gap-3 border-b border-border bg-card/30 px-3 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{schema}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="font-medium text-foreground">{table}</span>
      </div>

      <div className="ml-2 inline-flex rounded-md border border-border p-0.5">
        <SubTab active={view === "data"} onClick={() => onView("data")}>
          {t("table.view.data")}
        </SubTab>
        <SubTab active={view === "structure"} onClick={() => onView("structure")}>
          {t("table.view.structure")}
        </SubTab>
      </div>

      {view === "data" && (
        <>
          <div className="ml-3 flex items-center gap-1.5">
            <span className="text-muted-foreground">{t("table.toolbar.limit")}</span>
            <select
              value={limit}
              onChange={(e) => onLimit(Number(e.target.value))}
              className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring/40"
            >
              {LIMIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === 0 ? t("common.all") : o.label}
                </option>
              ))}
            </select>
          </div>

          {showPagination && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onPrev}
                disabled={page === 0 || loading}
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={t("table.toolbar.prevPage")}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="tabular-nums text-muted-foreground">
                {start}–{end}
                {count != null && (
                  <>
                    {" "}
                    <span className="opacity-60">
                      {t("table.pagination.of", { count: localeCountFmt(count) })}
                    </span>
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={onNext}
                disabled={
                  loading ||
                  (totalPages != null && page >= totalPages - 1)
                }
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                title={t("table.toolbar.nextPage")}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {!showPagination && view === "data" && (
            <span className="tabular-nums text-muted-foreground">
              {count != null
                ? t("table.pagination.allRows", { count: localeCountFmt(count) })
                : t("table.pagination.all")}
            </span>
          )}

          {orderBy && (
            <button
              type="button"
              onClick={onClearOrder}
              className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("table.toolbar.clearOrder")}
            >
              {orderBy.column} {orderBy.direction === "asc" ? "↑" : "↓"} ×
            </button>
          )}
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        {view === "data" && onAppendRow && (
          <button
            type="button"
            onClick={onAppendRow}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-emerald-500/15 hover:text-emerald-500"
            title={t("table.toolbar.addRow")}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {view === "data" && onDeleteSelected && (
          <button
            type="button"
            onClick={onDeleteSelected}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            title={t("table.toolbar.deleteSelected")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {view === "data" && (
          <button
            type="button"
            onClick={onToggleFilters}
            className={cn(
              "relative grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground",
              filterCount > 0 && "text-conn-accent",
            )}
            title={t("table.toolbar.filters")}
          >
            <FilterIcon className="h-3.5 w-3.5" />
            {filterCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-conn-accent text-[8px] font-bold text-conn-accent-foreground">
                {filterCount}
              </span>
            )}
          </button>
        )}
        {view === "data" && (
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => onDataView("grid")}
              className={cn(
                "grid h-6 w-6 place-items-center rounded",
                dataView === "grid"
                  ? "bg-conn-accent/20 text-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
              title={t("table.toolbar.viewGrid")}
            >
              <LayoutGrid className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onDataView("form")}
              className={cn(
                "grid h-6 w-6 place-items-center rounded",
                dataView === "form"
                  ? "bg-conn-accent/20 text-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
              title={t("table.toolbar.viewForm")}
            >
              <Rows3 className="h-3 w-3" />
            </button>
          </div>
        )}
        {view === "data" && (
          <button
            type="button"
            onClick={onToggleColumns}
            className={cn(
              "relative grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground",
              columnsHidden > 0 && "text-conn-accent",
            )}
            title={t("table.toolbar.columns")}
          >
            <Columns3 className="h-3.5 w-3.5" />
            {columnsHidden > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-conn-accent text-[8px] font-bold text-conn-accent-foreground">
                {columnsHidden}
              </span>
            )}
          </button>
        )}
        {view === "data" && onExport && (
          <button
            type="button"
            onClick={onExport}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("tableView.exportTitle")}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        )}
        {view === "data" && (
          <button
            type="button"
            onClick={() =>
              useTabs.getState().open({
                label: t("tree.importLabel", { name: table }),
                kind: {
                  kind: "data-import",
                  connectionId,
                  schema,
                  table,
                },
              })
            }
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("tableView.importTitle")}
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
        )}
        {view === "data" && (
          <button
            type="button"
            onClick={onOpenSearch}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("table.toolbar.search")}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          title={t("table.toolbar.refresh")}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function SubTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2.5 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "bg-conn-accent text-conn-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function DataPane({
  data,
  displayColumns,
  displayRows,
  columnMeta,
  loading,
  error,
  theme,
  searchValue,
  searchResults,
  focusedCell,
  focusedColumn,
  accentColor,
  editable,
  dirtyValues,
  dirtyIntents,
  rowsPendingDelete,
  onCellEdit,
  onBatchEdit,
  onDeleteCells,
  onDeleteRows,
  onSelectionStateChange,
  onCellSelect,
  onCellContextMenu,
  onColumnMoved,
  onHeaderClick,
  onHeaderContextMenu,
  onAppendRow,
  orderBy,
  gridRef,
}: {
  data: QueryResult | null;
  displayColumns: string[];
  displayRows: Value[][];
  columnMeta?: readonly Column[];
  loading: boolean;
  error: string | null;
  theme: "dark" | "light";
  searchValue: string;
  searchResults?: ReadonlyArray<readonly [number, number]>;
  focusedCell?: readonly [number, number] | null;
  focusedColumn?: number | null;
  accentColor?: string | null;
  editable: boolean;
  dirtyValues: ReadonlyMap<string, string>;
  dirtyIntents: ReadonlyMap<string, "edit" | "null" | "new">;
  rowsPendingDelete: ReadonlySet<number>;
  onCellEdit: (col: number, row: number, newValue: string) => void;
  onBatchEdit: (
    edits: Array<{ col: number; row: number; text: string }>,
  ) => void;
  onDeleteCells: (cells: Array<readonly [number, number]>) => void;
  onDeleteRows: (rows: number[]) => void;
  onSelectionStateChange: (has: boolean) => void;
  onCellSelect: (cell: readonly [number, number] | undefined) => void;
  onCellContextMenu?: (
    col: number,
    row: number,
    clientX: number,
    clientY: number,
  ) => void;
  onColumnMoved?: (from: number, to: number) => void;
  onHeaderClick: (col: number) => void;
  onHeaderContextMenu?: (col: number, clientX: number, clientY: number) => void;
  onAppendRow?: () => void;
  orderBy: OrderBy | null;
  gridRef: React.RefObject<ResultGridHandle | null>;
}) {
  if (error) {
    return (
      <div className="h-full overflow-auto p-4">
        <pre
          className={cn(
            "rounded-md border border-destructive/30 bg-destructive/5 p-4",
            "font-mono text-xs leading-relaxed text-destructive whitespace-pre-wrap break-words",
          )}
        >
          {error}
        </pre>
      </div>
    );
  }
  if (!data && loading) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return null;

  const decoratedColumns = useDecoratedColumns(displayColumns, orderBy);

  // Empty state when there are NO rows (existing or new) — Glide with
  // rows=0 doesn't render a useful visual, so we swap it for an
  // explanatory "empty" state. Clicking add updates state, displayRows
  // grows to 1, and the grid takes over normally.
  if (displayRows.length === 0) {
    return (
      <div className="relative h-full w-full">
        <EmptyTableState
          columns={data.columns}
          canAppend={!!onAppendRow}
          onAppendRow={onAppendRow}
        />
        {loading && <LoadingOverlay />}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <ResultGrid
        ref={gridRef}
        columns={decoratedColumns}
        columnMeta={columnMeta}
        rows={displayRows}
        theme={theme}
        searchValue={searchValue}
        searchResults={searchResults}
        focusedCell={focusedCell}
        focusedColumn={focusedColumn}
        accentColor={accentColor}
        editable={editable}
        dirtyValues={dirtyValues}
        dirtyIntents={dirtyIntents}
        rowsPendingDelete={rowsPendingDelete}
        onCellEdit={onCellEdit}
        onBatchEdit={onBatchEdit}
        onAppendRow={onAppendRow}
        onDeleteCells={onDeleteCells}
        onDeleteRows={onDeleteRows}
        onSelectionStateChange={onSelectionStateChange}
        onCellSelect={onCellSelect}
        onCellContextMenu={onCellContextMenu}
        onColumnMoved={onColumnMoved}
        onHeaderClick={onHeaderClick}
        onHeaderContextMenu={onHeaderContextMenu}
      />
      {loading && <LoadingOverlay />}
    </div>
  );
}

function ColumnsPopover({
  columns,
  hidden,
  onToggle,
  onShowAll,
  onClose,
}: {
  columns: string[];
  hidden: Set<string>;
  onToggle: (name: string) => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Fecha com click fora / Esc + foca o search ao abrir.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    searchInputRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return columns;
    const q = filter.toLowerCase();
    return columns.filter((c) => c.toLowerCase().includes(q));
  }, [columns, filter]);

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className={cn(
          "fixed right-3 top-12 z-50 w-64 rounded-md border border-border",
          "bg-popover text-popover-foreground shadow-lg",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium">{t("table.columnsPopover.title")}</span>
          <button
            type="button"
            onClick={onShowAll}
            disabled={hidden.size === 0}
            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {t("common.showAll")}
          </button>
        </div>
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("table.columnsPopover.filter")}
              className="w-full rounded border border-border bg-background py-1 pl-6 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring/40"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              {t("table.columnsPopover.none")}
            </div>
          ) : (
            filtered.map((name) => {
              const isHidden = hidden.has(name);
              return (
                <label
                  key={name}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => onToggle(name)}
                    className="h-3 w-3"
                  />
                  <span className="flex-1 truncate font-mono">{name}</span>
                </label>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

function EmptyTableState({
  columns,
  canAppend,
  onAppendRow,
}: {
  columns: string[];
  canAppend: boolean;
  onAppendRow?: () => void;
}) {
  const t = useT();
  const cols = `${columns.slice(0, 8).join(", ")}${columns.length > 8 ? "…" : ""}`;
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex max-w-lg flex-col items-center text-center">
        <div className="mb-2 text-sm font-medium text-foreground">
          {t("table.empty.title")}
        </div>
        <div className="mb-5 max-w-md text-xs text-muted-foreground">
          {t("table.empty.colsLine", { n: columns.length, cols })}
        </div>
        {canAppend && onAppendRow && (
          <button
            type="button"
            onClick={onAppendRow}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("table.empty.addFirst")}
          </button>
        )}
      </div>
    </div>
  );
}

function LoadingOverlay() {
  const t = useT();
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/40">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-md">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("tableView.loadingOverlay")}
      </div>
    </div>
  );
}

function ConnectingPlaceholder({
  connName,
  opening,
  errorMsg,
  onRetry,
}: {
  connName: string;
  opening: boolean;
  errorMsg: string | null;
  onRetry: () => void;
}) {
  const t = useT();
  if (errorMsg) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex max-w-lg flex-col items-center gap-3 text-center">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-destructive/15 text-destructive">
            !
          </div>
          <div className="text-sm font-medium text-foreground">
            {t("tableView.connectFailed")}
          </div>
          <div className="font-mono text-xs text-muted-foreground">{connName}</div>
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded border border-destructive/30 bg-destructive/5 p-2 text-left font-mono text-[11px] text-destructive">
            {errorMsg}
          </pre>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
          >
            {t("tableView.retry")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex flex-col items-center gap-3 text-center text-xs text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin text-conn-accent" />
        <div className="text-sm font-medium text-foreground">
          {opening ? t("tableView.connecting") : t("tableView.waitingConn")}
        </div>
        <div className="font-mono">{connName}</div>
        <div className="text-[11px] text-muted-foreground/80">
          {opening
            ? t("tableView.establishingLink")
            : t("tableView.autoOpen")}
        </div>
      </div>
    </div>
  );
}

function useDecoratedColumns(columns: string[], orderBy: OrderBy | null): string[] {
  return useMemo(
    () =>
      columns.map((c) =>
        orderBy?.column === c
          ? `${c}  ${orderBy.direction === "asc" ? "↑" : "↓"}`
          : c,
      ),
    [columns, orderBy],
  );
}

interface PendingEdit {
  row: number;
  col: number;
  originalRow: Value[];
  newText: string;
  intent: "edit" | "null" | "empty";
}

/** Text shown in the edit overlay for a Value (round-trippable). */
function formatValueForEdit(v: Value): string {
  if (v.type === "null") return "";
  if (
    v.type === "string" ||
    v.type === "decimal" ||
    v.type === "date" ||
    v.type === "time" ||
    v.type === "date_time" ||
    v.type === "timestamp"
  )
    return v.value;
  if (v.type === "bool") return v.value ? "1" : "0";
  if (v.type === "int" || v.type === "u_int" || v.type === "float")
    return String(v.value);
  if (v.type === "json") return JSON.stringify(v.value);
  if (v.type === "bytes") return `[${v.value.length} bytes]`;
  return "";
}

/** Converts user-typed text into a Value to send to the backend.
 *  v0: empty string → NULL; else → string (MySQL coerces).
 *  v1+: use the column type to pick the correct variant. */
function textToValue(text: string): Value {
  if (text === "") return { type: "null" };
  return { type: "string", value: text };
}

/** Resolves the Value from the pending edit's intent. "empty" forces
 *  literal empty string; "null" forces NULL; "edit" falls into textToValue. */
function intentToValue(
  intent: "edit" | "null" | "empty",
  text: string,
): Value {
  if (intent === "null") return { type: "null" };
  if (intent === "empty") return { type: "string", value: "" };
  return textToValue(text);
}

/** Applies the column order saved in tab-state (if it exists and matches
 *  the current schema) by permuting data.columns + each row. Fallback:
 *  returns r unchanged — the saved order is "soft", it doesn't break if
 *  columns changed on the table (e.g. ALTER TABLE). */
function applySavedColumnOrder(
  r: QueryResult,
  saved: readonly string[] | undefined,
): QueryResult {
  if (!saved || saved.length === 0) return r;
  if (saved.length !== r.columns.length) return r;
  // Permutation new_visual_idx → old_idx_in_r. If any saved col doesn't
  // exist in r.columns, abort (schema changed).
  const perm: number[] = [];
  for (const name of saved) {
    const idx = r.columns.indexOf(name);
    if (idx < 0) return r;
    perm.push(idx);
  }
  return {
    ...r,
    columns: perm.map((i) => r.columns[i]),
    rows: r.rows.map((row) => perm.map((i) => row[i])),
  };
}

/** Produces the permutation resulting from "move the item at index
 *  `from` to position `to`" in an array of `len` positions. Returns
 *  newIdx→oldIdx. */
function reorderPermutation(len: number, from: number, to: number): number[] {
  const idx = Array.from({ length: len }, (_, i) => i);
  const [moved] = idx.splice(from, 1);
  idx.splice(to, 0, moved);
  return idx;
}

/** Serializa um valor pra literal SQL (usado pelo "Copiar como SQL"). */
function textToSqlLiteral(text: string | null): string {
  if (text === null) return "NULL";
  if (text === "") return "''";
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function DirtyFooter({
  editCount,
  deleteCount,
  insertCount,
  applying,
  error,
  onApply,
  onDiscard,
}: {
  editCount: number;
  deleteCount: number;
  insertCount: number;
  applying: boolean;
  error: string | null;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const parts: string[] = [];
  if (editCount > 0)
    parts.push(
      t(editCount === 1 ? "table.footer.editedCells" : "table.footer.editedCellsMany", { n: editCount }),
    );
  if (deleteCount > 0)
    parts.push(
      t(deleteCount === 1 ? "table.footer.rowsToDelete" : "table.footer.rowsToDeleteMany", { n: deleteCount }),
    );
  if (insertCount > 0)
    parts.push(
      t(insertCount === 1 ? "table.footer.newRows" : "table.footer.newRowsMany", { n: insertCount }),
    );
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-t border-border px-3 py-1.5 text-xs",
        error
          ? "bg-destructive/10"
          : deleteCount > 0
            ? "bg-destructive/10"
            : "bg-yellow-500/10",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="font-medium">{parts.join(" · ")}</span>
        {error && (
          <span className="truncate text-destructive" title={error}>
            {error.split("\n")[0]}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onDiscard}
            disabled={applying}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Undo2 className="h-3 w-3" />
            {t("common.discard")}
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={applying}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {t("common.apply")}
          </button>
        </div>
      </div>
      {error && error.includes("\n") && (
        <details className="text-[11px] text-destructive">
          <summary className="cursor-pointer">{t("table.footer.seeAllErrors")}</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">{error}</pre>
        </details>
      )}
    </div>
  );
}

function cycleSort(prev: OrderBy | null, col: string): OrderBy | null {
  if (!prev || prev.column !== col)
    return { column: col, direction: "asc" as SortDir };
  if (prev.direction === "asc")
    return { column: col, direction: "desc" as SortDir };
  return null;
}
