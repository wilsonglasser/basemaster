import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { allCells } from "@glideapps/glide-data-grid-cells";

import { isNullish } from "@/lib/format-value";
import type { Column, Value } from "@/lib/types";

import {
  displayText as toDisplayText,
  extractCellText,
  parseDateText,
  pickEditorKind,
  textToNumber,
  valueToBoolean,
  valueToNumber,
} from "./cell-types";

interface ResultGridProps {
  columns: string[];
  rows: Value[][];
  theme?: "dark" | "light";
  /** Text for the yellow highlight (all occurrences). */
  searchValue?: string;
  /** List of matches (col, row) — painted yellow. */
  searchResults?: ReadonlyArray<readonly [number, number]>;
  /** Cell with accent border (focused match, Data mode). */
  focusedCell?: readonly [number, number] | null;
  /** Column with accent border (Field mode). */
  focusedColumn?: number | null;
  /** Focused match's border color (CSS color string). Default blue. */
  accentColor?: string | null;
  /** Map "row:col" → pending new text. has() = dirty; get() = display value. */
  dirtyValues?: ReadonlyMap<string, string>;
  /** Map "row:col" → intent: "null" red, "edit" yellow, "new" green. */
  dirtyIntents?: ReadonlyMap<string, "edit" | "null" | "new">;
  /** Column metadata — used to pick typed editors (Number, DatePicker,
   *  Dropdown, etc.). Without it, everything becomes Text. */
  columnMeta?: readonly Column[];
  /** Enables inline editing (overlay editor + onCellEdit). */
  editable?: boolean;
  /** Callback when a cell is edited (single or batched). */
  onCellEdit?: (col: number, row: number, newValue: string) => void;
  /** Fired when the user presses Delete on N cells — marks them NULL. */
  onDeleteCells?: (cells: Array<readonly [number, number]>) => void;
  /** Fired by the trash button — marks rows for DELETE. */
  onDeleteRows?: (rows: number[]) => void;
  /** Fired in batch (multi-cell paste). Parent handles spillover. */
  onBatchEdit?: (
    edits: Array<{ col: number; row: number; text: string }>,
  ) => void;
  /** Arrow ArrowDown on the last row — `focusCol` is the current column,
   *  so the parent can select the matching cell on the new row. */
  onAppendRow?: (focusCol?: number) => void;
  /** Right-click on a cell — parent opens its own menu (copy, null, etc.). */
  onCellContextMenu?: (
    col: number,
    row: number,
    clientX: number,
    clientY: number,
  ) => void;
  /** Rows marked for deletion (paints the entire row red). */
  rowsPendingDelete?: ReadonlySet<number>;
  /** Notifies whether there's any selection (cell range or row). Used to
   *  enable/hide the trash button on the toolbar. */
  onSelectionStateChange?: (hasSelection: boolean) => void;
  /** [col, row] when the manual cursor changes — for the status bar. */
  onCellSelect?: (cell: readonly [number, number] | undefined) => void;
  /** Click on a column header (0-based index). */
  onHeaderClick?: (col: number) => void;
  /** Right-click no header (ordenar, ocultar, etc.). */
  onHeaderContextMenu?: (col: number, clientX: number, clientY: number) => void;
  /** Drag & drop no header reordenou colunas (from → to). */
  onColumnMoved?: (from: number, to: number) => void;
}

export interface ResultGridHandle {
  scrollToTop: () => void;
  scrollToColumn: (col: number) => void;
  scrollToCell: (
    col: number,
    row: number,
    align?: "start" | "center" | "end",
  ) => void;
  /** Moves the selection to [col, row] and scrolls to keep it visible. */
  selectCell: (col: number, row: number) => void;
  /** Expands the current selection and calls onDeleteCells (used by the trash button). */
  deleteSelected: () => void;
}

const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
  current: undefined,
};

// rowMarkers="checkbox" → Glide reserva col 0 para o handler.
// `searchResults` is internal coord (needs the +1).
// `highlightRegions` is data coord (Glide applies the shift itself — do NOT add).
const ROW_MARKER_OFFSET = 1;

interface HighlightRegion {
  color: string;
  range: Rectangle;
  /**
   * "solid" PINTA o cell todo. "solid-outline" desenha BORDA.
   * "dashed" / "no-outline" are additional Glide variants.
   */
  style?: "solid" | "solid-outline" | "dashed" | "no-outline";
}

export const ResultGrid = forwardRef<ResultGridHandle, ResultGridProps>(
  function ResultGrid(
    {
      columns,
      rows,
      theme = "dark",
      searchValue,
      searchResults,
      focusedCell,
      focusedColumn,
      accentColor,
      dirtyValues,
      dirtyIntents,
      columnMeta,
      editable = false,
      onCellEdit,
      onDeleteCells,
      onDeleteRows,
      rowsPendingDelete,
      onSelectionStateChange,
      onBatchEdit,
      onAppendRow,
      onCellContextMenu,
      onCellSelect,
      onHeaderClick,
      onHeaderContextMenu,
      onColumnMoved,
    },
    ref,
  ) {
    const editorRef = useRef<DataEditorRef>(null);
    // Capture clientX/Y from the native contextmenu to position the menu —
    // Glide only gives bounds relative to the canvas, not the viewport.
    const ctxPosRef = useRef<{ x: number; y: number } | null>(null);
    const [columnSizes, setColumnSizes] = useState<Record<string, number>>({});
    const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);

    const expandSelectionToCells = (
      sel: GridSelection,
    ): Array<readonly [number, number]> => {
      const out: Array<[number, number]> = [];
      if (sel.current) {
        const r = sel.current.range;
        for (let y = r.y; y < r.y + r.height; y++) {
          for (let x = r.x; x < r.x + r.width; x++) {
            out.push([x, y]);
          }
        }
      }
      // Whole rows selected (via marker click) — ALL columns.
      sel.rows.toArray().forEach((row) => {
        for (let c = 0; c < columns.length; c++) {
          out.push([c, row]);
        }
      });
      return out;
    };

    useImperativeHandle(ref, () => ({
      scrollToTop() {
        editorRef.current?.scrollTo(0, 0, "both", 0, 0);
      },
      scrollToColumn(col) {
        editorRef.current?.scrollTo(col, 0, "horizontal", 0, 0);
      },
      scrollToCell(col, row, align) {
        // `align` controls vAlign/hAlign — "end" keeps the cell at the
        // bottom of the viewport (useful to "stay at end" when footer appears).
        editorRef.current?.scrollTo(col, row, "both", 0, 0, {
          vAlign: align,
          hAlign: align,
        });
      },
      selectCell(col, row) {
        setSelection({
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
          current: {
            cell: [col, row],
            range: { x: col, y: row, width: 1, height: 1 },
            rangeStack: [],
          },
        });
        editorRef.current?.scrollTo(col, row, "both", 0, 0, {
          vAlign: "end",
        });
      },
      deleteSelected() {
        // Priority: whole-row selection → onDeleteRows.
        // Otherwise, uses the current cursor row.
        const rowSel = selection.rows.toArray();
        if (rowSel.length > 0) {
          onDeleteRows?.(rowSel);
          return;
        }
        if (selection.current) {
          onDeleteRows?.([selection.current.cell[1]]);
        }
      },
    }));

    // Reset only when data changes (not on every parent re-render).
    useEffect(() => {
      setSelection(EMPTY_SELECTION);
    }, [rows]);

    const gridColumns: GridColumn[] = useMemo(
      () =>
        columns.map((c) => ({
          id: c,
          title: c,
          width: columnSizes[c] ?? 160,
        })),
      [columns, columnSizes],
    );

    // searchResults uses INTERNAL coords (Glide passes straight to the
    // canvas without shifting), so we add +1 for the row marker.
    const shiftedSearchResults = useMemo<readonly Item[] | undefined>(
      () =>
        searchResults?.map(([c, r]) => [c + ROW_MARKER_OFFSET, r] as Item),
      [searchResults],
    );

    // highlightRegions uses DATA coords — Glide applies the row-marker
    // shift internally. Do NOT add +1 here.
    const effectiveAccent = accentColor || "#3b82f6";

    const selectedRow = selection.current?.cell[1];
    const rowOverrideTheme: Partial<Theme> = useMemo(
      () =>
        theme === "dark"
          ? { bgCell: "#252830", bgCellMedium: "#282b34" }
          : { bgCell: "#f1f5f9", bgCellMedium: "#e9eff5" },
      [theme],
    );
    // Rows marked for DELETE: translucent red across the whole row.
    // Don't override textDark/textLight — doing so would make the row marker
    // (which uses textDark: "transparent" in its own theme) show the number.
    const deleteRowTheme: Partial<Theme> = useMemo(
      () => ({
        bgCell: "rgba(239, 68, 68, 0.18)",
        bgCellMedium: "rgba(239, 68, 68, 0.22)",
      }),
      [],
    );
    const getRowThemeOverride = useMemo(
      () => (row: number) => {
        if (rowsPendingDelete?.has(row)) return deleteRowTheme;
        if (row === selectedRow) return rowOverrideTheme;
        return undefined;
      },
      [selectedRow, rowOverrideTheme, rowsPendingDelete, deleteRowTheme],
    );

    const highlightRegions = useMemo<HighlightRegion[] | undefined>(() => {
      if (focusedCell) {
        const [c, r] = focusedCell;
        return [
          {
            color: effectiveAccent,
            range: { x: c, y: r, width: 1, height: 1 },
            style: "solid-outline",
          },
        ];
      }
      if (focusedColumn != null && rows.length > 0) {
        return [
          {
            color: effectiveAccent,
            range: { x: focusedColumn, y: 0, width: 1, height: rows.length },
            style: "solid-outline",
          },
        ];
      }
      return undefined;
    }, [focusedCell, focusedColumn, rows.length, effectiveAccent]);

    const getCellContent = (cell: Item): GridCell => {
      const [col, row] = cell;
      const value = rows[row]?.[col];
      const key = `${row}:${col}`;
      const dirtyText = dirtyValues?.get(key);
      const isDirty = dirtyText !== undefined;
      const display = toDisplayText(value, isDirty, dirtyText);
      const nullish = !isDirty && isNullish(value);
      const intent = dirtyIntents?.get(key);

      let themeOverride: Partial<Theme> | undefined;
      if (intent === "new") {
        themeOverride = {
          bgCell: "rgba(34, 197, 94, 0.15)",
          bgCellMedium: "rgba(34, 197, 94, 0.20)",
        };
      } else if (isDirty && intent === "null") {
        themeOverride = {
          bgCell: "rgba(239, 68, 68, 0.22)",
          bgCellMedium: "rgba(239, 68, 68, 0.28)",
          textDark: "#fca5a5",
          textLight: "#fca5a5",
        };
      } else if (isDirty) {
        themeOverride = {
          bgCell: "rgba(255, 200, 80, 0.20)",
          bgCellMedium: "rgba(255, 200, 80, 0.25)",
        };
      } else if (nullish) {
        themeOverride = { textDark: "#9ca3af", textLight: "#9ca3af" };
      }

      const readonly = !editable;
      const editor = pickEditorKind(columnMeta?.[col]);

      // ENUM → dropdown with the valid values.
      if (editor.kind === "enum") {
        return {
          kind: GridCellKind.Custom,
          copyData: display,
          allowOverlay: true,
          readonly,
          themeOverride,
          data: {
            kind: "dropdown-cell",
            value: isDirty ? dirtyText : nullish ? null : display,
            allowedValues: editor.values,
          },
        } as GridCell;
      }

      // DATE / DATETIME / TIME → native HTML picker.
      if (editor.kind === "date") {
        const rawText = isDirty
          ? dirtyText ?? ""
          : nullish
            ? ""
            : display;
        const date = parseDateText(rawText, editor.dateKind);
        return {
          kind: GridCellKind.Custom,
          copyData: display,
          allowOverlay: true,
          readonly,
          themeOverride,
          data: {
            kind: "date-picker-cell",
            date,
            displayDate: rawText,
            format: editor.dateKind,
          },
        } as GridCell;
      }

      // NUMERIC → Number built-in (automatic validation).
      if (editor.kind === "number") {
        const num = isDirty ? textToNumber(dirtyText ?? "") : valueToNumber(value);
        return {
          kind: GridCellKind.Number,
          data: num,
          displayData: display,
          allowOverlay: true,
          readonly,
          themeOverride,
          allowNegative: editor.allowNegative,
          fixedDecimals: editor.fixedDecimals,
          // No thousands separator; decimal is always a dot.
          thousandSeparator: false,
          decimalSeparator: ".",
        };
      }

      // BOOLEAN → built-in checkbox.
      if (editor.kind === "boolean") {
        const b = isDirty
          ? dirtyText === "1" || dirtyText?.toLowerCase() === "true"
          : valueToBoolean(value);
        return {
          kind: GridCellKind.Boolean,
          data: b as boolean | undefined,
          allowOverlay: false,
          readonly,
          themeOverride,
        };
      }

      // TEXT (default).
      return {
        kind: GridCellKind.Text,
        data: display,
        displayData: display,
        allowOverlay: true,
        readonly,
        themeOverride,
      };
    };

    return (
      <div
        className="h-full w-full"
        onContextMenuCapture={(e) => {
          ctxPosRef.current = { x: e.clientX, y: e.clientY };
        }}
      >
        <DataEditor
          ref={editorRef}
          columns={gridColumns}
          rows={rows.length}
          getCellContent={getCellContent}
          getCellsForSelection={true}
          cellActivationBehavior="second-click"
          getRowThemeOverride={getRowThemeOverride}
          smoothScrollX
          smoothScrollY
          rowMarkers={{
            // "clickable-number" is what ACTIVATES row selection on click
            // (with plain "number", Glide returns early in the selection handler).
            // Transparent text hides the number and the cursor becomes pointer.
            kind: "clickable-number",
            width: 22,
            theme: {
              textDark: "transparent",
              textLight: "transparent",
              textMedium: "transparent",
              textHeader: "transparent",
              textBubble: "transparent",
            } as Partial<Theme>,
          }}
          height="100%"
          width="100%"
          theme={theme === "dark" ? DARK_THEME : LIGHT_THEME}
          searchValue={searchValue ?? ""}
          searchResults={shiftedSearchResults}
          highlightRegions={highlightRegions}
          gridSelection={selection}
          onGridSelectionChange={(s) => {
            setSelection(s);
            onCellSelect?.(s.current?.cell);
            const hasSel =
              s.current !== undefined || s.rows.toArray().length > 0;
            onSelectionStateChange?.(hasSel);
          }}
          onColumnResize={(_col, newSize, idx) => {
            const id = columns[idx];
            if (!id) return;
            setColumnSizes((cs) => ({ ...cs, [id]: newSize }));
          }}
          onHeaderClicked={
            onHeaderClick ? (colIndex) => onHeaderClick(colIndex) : undefined
          }
          customRenderers={allCells}
          onCellEdited={
            onCellEdit
              ? ([col, row], newCell) => {
                  const text = extractCellText(newCell);
                  // Multi-cell fill: if there are N selected cells, replicate
                  // the value to all of them — Navicat-style behavior.
                  const cells = expandSelectionToCells(selection);
                  if (cells.length > 1) {
                    for (const [c, r] of cells) onCellEdit(c, r, text);
                  } else {
                    onCellEdit(col, row, text);
                  }
                }
              : undefined
          }
          onCellsEdited={
            onCellEdit || onBatchEdit
              ? (edits) => {
                  const cells = expandSelectionToCells(selection);
                  if (edits.length === 1 && cells.length > 1 && onCellEdit) {
                    const text = extractCellText(edits[0].value);
                    for (const [c, r] of cells) onCellEdit(c, r, text);
                    return true;
                  }
                  if (onBatchEdit) {
                    const batched = edits.map((e) => ({
                      col: e.location[0],
                      row: e.location[1],
                      text: extractCellText(e.value),
                    }));
                    if (batched.length > 0) onBatchEdit(batched);
                    return true;
                  }
                  for (const e of edits) {
                    const [col, row] = e.location;
                    onCellEdit?.(col, row, extractCellText(e.value));
                  }
                  return true;
                }
              : undefined
          }
          onKeyDown={(e) => {
            if (
              e.key === "ArrowDown" &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.altKey &&
              onAppendRow &&
              editable &&
              selection.current !== undefined &&
              selection.current.cell[1] === rows.length - 1 &&
              rows.length > 0
            ) {
              e.stopPropagation();
              onAppendRow(selection.current.cell[0]);
            }
          }}
          onCellContextMenu={
            onCellContextMenu
              ? (cell, event) => {
                  event.preventDefault();
                  const pos = ctxPosRef.current ?? {
                    x: event.bounds.x + event.localEventX,
                    y: event.bounds.y + event.localEventY,
                  };
                  onCellContextMenu(cell[0], cell[1], pos.x, pos.y);
                }
              : undefined
          }
          onColumnMoved={
            onColumnMoved
              ? (from, to) => {
                  if (from !== to) onColumnMoved(from, to);
                }
              : undefined
          }
          onHeaderContextMenu={
            onHeaderContextMenu
              ? (col, event) => {
                  event.preventDefault();
                  const pos = ctxPosRef.current ?? {
                    x: event.bounds.x + event.localEventX,
                    y: event.bounds.y + event.localEventY,
                  };
                  onHeaderContextMenu(col, pos.x, pos.y);
                }
              : undefined
          }
          onPaste={
            onBatchEdit
              ? (target, values) => {
                  // Generate edits even for positions BEYOND rows.length
                  // (Glide would truncate if we let it process).
                  const edits: Array<{
                    col: number;
                    row: number;
                    text: string;
                  }> = [];
                  for (let r = 0; r < values.length; r++) {
                    const row = values[r];
                    for (let c = 0; c < row.length; c++) {
                      const colIdx = target[0] + c;
                      if (colIdx >= columns.length) continue;
                      edits.push({
                        col: colIdx,
                        row: target[1] + r,
                        text: row[c],
                      });
                    }
                  }
                  if (edits.length > 0) onBatchEdit(edits);
                  return false; // impede Glide de processar (evita truncamento)
                }
              : true
          }
          onDelete={
            onDeleteCells || onDeleteRows
              ? (sel) => {
                  // Row selection (sem cell selecionada) → delete row.
                  // Cell selection → set NULL.
                  const rowSel = sel.rows.toArray();
                  if (rowSel.length > 0 && onDeleteRows) {
                    onDeleteRows(rowSel);
                    return false;
                  }
                  const cells = expandSelectionToCells(sel);
                  if (cells.length > 0 && onDeleteCells) onDeleteCells(cells);
                  return false;
                }
              : undefined
          }
        />
      </div>
    );
  },
);

const BASE: Partial<Theme> = {
  fontFamily: "var(--font-sans)",
  headerFontStyle: "600 12px",
  baseFontStyle: "13px",
  cellHorizontalPadding: 12,
  cellVerticalPadding: 4,
  drilldownBorder: "transparent",
};

// Cores em hex/rgba — evita esquisitices do parser do Glide com `oklch`
// (cause of the "white background" on the selected cell).
const DARK_THEME: Partial<Theme> = {
  ...BASE,
  bgCell: "#0b0d12",
  bgCellMedium: "#13161d",
  bgHeader: "#13161d",
  bgHeaderHovered: "#1c1f27",
  bgHeaderHasFocus: "rgba(74, 109, 230, 0.45)",
  textDark: "#f5f6f8",
  textMedium: "#9ea3ad",
  textLight: "#6b7280",
  textBubble: "#f5f6f8",
  textHeader: "#f5f6f8",
  textHeaderSelected: "#ffffff",
  bgIconHeader: "#9ea3ad",
  fgIconHeader: "#0b0d12",
  borderColor: "#262a33",
  horizontalBorderColor: "#1f232b",
  accentColor: "var(--conn-accent)" as unknown as string,
  accentLight: "rgba(74, 109, 230, 0.22)",
  bgSearchResult: "rgba(255, 200, 80, 0.45)",
};

const LIGHT_THEME: Partial<Theme> = {
  ...BASE,
  bgCell: "#ffffff",
  bgCellMedium: "#f9fafb",
  bgHeader: "#f3f4f6",
  bgHeaderHovered: "#e5e7eb",
  bgHeaderHasFocus: "rgba(67, 96, 200, 0.35)",
  textDark: "#111827",
  textMedium: "#4b5563",
  textLight: "#9ca3af",
  textBubble: "#111827",
  textHeader: "#111827",
  bgIconHeader: "#6b7280",
  fgIconHeader: "#ffffff",
  borderColor: "#e5e7eb",
  horizontalBorderColor: "#f3f4f6",
  accentColor: "var(--conn-accent)" as unknown as string,
  accentLight: "rgba(67, 96, 200, 0.18)",
  bgSearchResult: "rgba(255, 200, 80, 0.55)",
};
