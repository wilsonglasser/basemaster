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
  /** Texto para o highlight amarelo (todas as ocorrências). */
  searchValue?: string;
  /** Lista de matches (col, row) — pintados em amarelo. */
  searchResults?: ReadonlyArray<readonly [number, number]>;
  /** Célula com borda accent (match focado, modo Dado). */
  focusedCell?: readonly [number, number] | null;
  /** Coluna com borda accent (modo Campo). */
  focusedColumn?: number | null;
  /** Cor da borda do match focado (CSS color string). Default azul. */
  accentColor?: string | null;
  /** Map "row:col" → novo texto pendente. has() = dirty; get() = display value. */
  dirtyValues?: ReadonlyMap<string, string>;
  /** Map "row:col" → intent: "null" vermelho, "edit" amarelo, "new" verde. */
  dirtyIntents?: ReadonlyMap<string, "edit" | "null" | "new">;
  /** Metadados das colunas — usado pra escolher editors tipados
   *  (Number, DatePicker, Dropdown, etc.). Sem isso, tudo vira Text. */
  columnMeta?: readonly Column[];
  /** Habilita edição inline (overlay editor + onCellEdit). */
  editable?: boolean;
  /** Callback quando uma célula é editada (single or batched). */
  onCellEdit?: (col: number, row: number, newValue: string) => void;
  /** Disparado quando o usuário aperta Delete em N células — marca como NULL. */
  onDeleteCells?: (cells: Array<readonly [number, number]>) => void;
  /** Disparado pelo botão lixeira — marca linhas pra DELETE. */
  onDeleteRows?: (rows: number[]) => void;
  /** Disparado em batch (paste multi-cell). Parent lida com spillover. */
  onBatchEdit?: (
    edits: Array<{ col: number; row: number; text: string }>,
  ) => void;
  /** Seta ao pressionar ArrowDown na última linha — `focusCol` é a coluna
   *  atual, pra parent selecionar a cell correspondente na linha nova. */
  onAppendRow?: (focusCol?: number) => void;
  /** Right-click numa cell — parent abre seu próprio menu (copy, null, etc.). */
  onCellContextMenu?: (
    col: number,
    row: number,
    clientX: number,
    clientY: number,
  ) => void;
  /** Linhas marcadas pra exclusão (pinta row inteira de vermelho). */
  rowsPendingDelete?: ReadonlySet<number>;
  /** Notifica se há qualquer seleção (cell range ou row). Usado pra
   *  habilitar/ocultar o botão de lixeira na toolbar. */
  onSelectionStateChange?: (hasSelection: boolean) => void;
  /** [col, row] quando o cursor manual muda — para a status bar. */
  onCellSelect?: (cell: readonly [number, number] | undefined) => void;
  /** Click no header de uma coluna (índice 0-based). */
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
  /** Move a seleção para [col, row] e scrolla pra manter visível. */
  selectCell: (col: number, row: number) => void;
  /** Expande a seleção atual e chama onDeleteCells (usado pelo botão lixeira). */
  deleteSelected: () => void;
}

const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
  current: undefined,
};

// rowMarkers="checkbox" → Glide reserva col 0 para o handler.
// `searchResults` é coord interna (precisa do +1).
// `highlightRegions` é coord de dados (Glide aplica o shift sozinho — NÃO somar).
const ROW_MARKER_OFFSET = 1;

interface HighlightRegion {
  color: string;
  range: Rectangle;
  /**
   * "solid" PINTA o cell todo. "solid-outline" desenha BORDA.
   * "dashed" / "no-outline" são variantes adicionais do Glide.
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
    // Capturamos clientX/Y do native contextmenu pra posicionar o menu —
    // Glide só dá bounds relativos ao canvas, não viewport.
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
      // Linhas selecionadas inteiras (via marker click) — TODAS as colunas.
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
        // `align` controla o vAlign/hAlign — "end" deixa a cell no fundo
        // do viewport (útil pra "manter no fim" quando footer aparece).
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
        // Prioridade: linhas selecionadas inteiras → onDeleteRows.
        // Senão, usa a linha do cursor atual.
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

    // Reset apenas quando os dados mudam (não em cada re-render do parent).
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

    // searchResults usa coords INTERNAS (Glide passa direto pro canvas
    // sem shift), por isso somamos +1 do row marker.
    const shiftedSearchResults = useMemo<readonly Item[] | undefined>(
      () =>
        searchResults?.map(([c, r]) => [c + ROW_MARKER_OFFSET, r] as Item),
      [searchResults],
    );

    // highlightRegions usa coords de DADOS — Glide aplica o shift do
    // row marker internamente. NÃO somar +1 aqui.
    const effectiveAccent = accentColor || "#3b82f6";

    const selectedRow = selection.current?.cell[1];
    const rowOverrideTheme: Partial<Theme> = useMemo(
      () =>
        theme === "dark"
          ? { bgCell: "#252830", bgCellMedium: "#282b34" }
          : { bgCell: "#f1f5f9", bgCellMedium: "#e9eff5" },
      [theme],
    );
    // Linhas marcadas pra DELETE: vermelho translúcido em toda linha.
    // Não sobrescrevemos textDark/textLight — se o fizermos, o row marker
    // (que usa textDark: "transparent" no próprio theme) mostra o número.
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

      // ENUM → dropdown com os valores válidos.
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

      // DATE / DATETIME / TIME → picker nativo do HTML.
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

      // NUMERIC → Number built-in (validação automática).
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
          // Sem separador de milhar; decimal sempre ponto.
          thousandSeparator: false,
          decimalSeparator: ".",
        };
      }

      // BOOLEAN → checkbox built-in.
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
            // "clickable-number" é o que ATIVA seleção da linha no click
            // (com "number" puro, Glide retorna cedo no handler de seleção).
            // Texto transparente esconde o número e o cursor vira pointer.
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
                  // Multi-cell fill: se há N cells selecionados, replica o
                  // valor em todos — comportamento estilo Navicat.
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
                  // Gera edits mesmo pra posições ALÉM de rows.length
                  // (Glide truncaria se deixássemos ele processar).
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
// (causa do "fundo branco" na célula selecionada).
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
