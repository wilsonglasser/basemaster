import { useMemo, useState } from "react";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Ban,
} from "lucide-react";

import { formatValue, isNullish } from "@/lib/format-value";
import type { Value } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";

export interface FormCellEdit {
  row: number;
  col: number;
  text: string;
  intent: "edit" | "null" | "empty";
}

interface Props {
  columns: readonly string[];
  rows: readonly (readonly Value[])[];
  /** Optional: visual metadata (e.g. PK column) — just for the badge. */
  pkColumns?: ReadonlySet<string>;
  /** Dirty overlay — whether the (row, col) cell has a pending edit. */
  dirtyValues?: Map<string, string>; // key: "row:col"
  dirtyIntents?: Map<string, "edit" | "null" | "empty">;
  editable: boolean;
  onCellEdit?: (e: FormCellEdit) => void;
  /** Linha inicial (default 0). */
  initialRow?: number;
}

function key(r: number, c: number) {
  return `${r}:${c}`;
}

export function RecordFormView({
  columns,
  rows,
  pkColumns,
  dirtyValues,
  dirtyIntents,
  editable,
  onCellEdit,
  initialRow = 0,
}: Props) {
  const t = useT();
  const [rowIdx, setRowIdx] = useState(
    Math.min(Math.max(0, initialRow), Math.max(0, rows.length - 1)),
  );
  const clampedIdx = Math.min(rowIdx, Math.max(0, rows.length - 1));
  const row = rows[clampedIdx];

  // Reset position if the underlying rows changed (e.g. refresh to a new page).
  useMemo(() => {
    if (rowIdx > rows.length - 1) setRowIdx(Math.max(0, rows.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  if (rows.length === 0 || !row) {
    return (
      <div className="grid h-full place-items-center text-xs text-muted-foreground">
        {t("recordForm.noRecords")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/30 px-3 text-xs">
        <NavBtn
          onClick={() => setRowIdx(0)}
          disabled={clampedIdx === 0}
          title={t("recordForm.firstTitle")}
        >
          <ChevronFirst className="h-3.5 w-3.5" />
        </NavBtn>
        <NavBtn
          onClick={() => setRowIdx((i) => Math.max(0, i - 1))}
          disabled={clampedIdx === 0}
          title={t("recordForm.prevTitle")}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </NavBtn>
        <div className="flex items-center gap-1 font-mono tabular-nums">
          <input
            type="number"
            min={1}
            max={rows.length}
            value={clampedIdx + 1}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isFinite(n)) {
                setRowIdx(Math.min(rows.length - 1, Math.max(0, n - 1)));
              }
            }}
            className="h-5 w-14 rounded border border-border bg-background px-1 text-center text-xs"
          />
          <span className="text-muted-foreground">/</span>
          <span className="text-muted-foreground">
            {rows.length.toLocaleString()}
          </span>
        </div>
        <NavBtn
          onClick={() => setRowIdx((i) => Math.min(rows.length - 1, i + 1))}
          disabled={clampedIdx >= rows.length - 1}
          title={t("recordForm.nextTitle")}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </NavBtn>
        <NavBtn
          onClick={() => setRowIdx(rows.length - 1)}
          disabled={clampedIdx >= rows.length - 1}
          title={t("recordForm.lastTitle")}
        >
          <ChevronLast className="h-3.5 w-3.5" />
        </NavBtn>
      </header>

      <div
        className="min-h-0 flex-1 overflow-auto p-4"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            setRowIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            setRowIdx((i) => Math.min(rows.length - 1, i + 1));
          } else if (e.key === "Home") {
            setRowIdx(0);
          } else if (e.key === "End") {
            setRowIdx(rows.length - 1);
          }
        }}
      >
        <div className="mx-auto max-w-2xl space-y-1">
          {columns.map((col, c) => {
            const v = row[c];
            const k = key(clampedIdx, c);
            const dirtyText = dirtyValues?.get(k);
            const dirtyIntent = dirtyIntents?.get(k);
            const isDirty = dirtyText !== undefined;
            const displayText = isDirty
              ? dirtyIntent === "null"
                ? ""
                : dirtyIntent === "empty"
                  ? ""
                  : dirtyText
              : isNullish(v)
                ? ""
                : formatValue(v);
            const isPk = pkColumns?.has(col) ?? false;
            return (
              <div
                key={c}
                className={cn(
                  "grid grid-cols-[180px_1fr] items-start gap-2 rounded-md border px-2 py-1.5 transition-colors",
                  isDirty
                    ? "border-amber-500/50 bg-amber-500/5"
                    : "border-border/50 hover:bg-accent/20",
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5 pt-1">
                  <span className="truncate font-mono text-[11px]">
                    {col}
                  </span>
                  {isPk && (
                    <span className="shrink-0 rounded bg-conn-accent/20 px-1 py-px text-[9px] font-semibold text-conn-accent">
                      PK
                    </span>
                  )}
                  {isDirty && (
                    <span className="shrink-0 rounded bg-amber-500/20 px-1 py-px text-[9px] font-medium text-amber-500">
                      {dirtyIntent === "null" ? "NULL" : dirtyIntent === "empty" ? "''" : "edit"}
                    </span>
                  )}
                </div>
                <div className="flex items-start gap-1">
                  <FieldInput
                    value={displayText}
                    isNull={
                      isDirty
                        ? dirtyIntent === "null"
                        : isNullish(v)
                    }
                    editable={editable}
                    onChange={(t) =>
                      onCellEdit?.({
                        row: clampedIdx,
                        col: c,
                        text: t,
                        intent: "edit",
                      })
                    }
                  />
                  {editable && (
                    <div className="flex flex-col gap-0.5 pt-1">
                      <button
                        type="button"
                        onClick={() =>
                          onCellEdit?.({
                            row: clampedIdx,
                            col: c,
                            text: "",
                            intent: "null",
                          })
                        }
                        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                        title={t("recordForm.setNullTitle")}
                      >
                        <Ban className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onCellEdit?.({
                            row: clampedIdx,
                            col: c,
                            text: "",
                            intent: "empty",
                          })
                        }
                        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                        title={t("recordForm.setEmptyTitle")}
                      >
                        <Eraser className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FieldInput({
  value,
  isNull,
  editable,
  onChange,
}: {
  value: string;
  isNull: boolean;
  editable: boolean;
  onChange: (v: string) => void;
}) {
  const isMultiline = value.includes("\n") || value.length > 80;
  if (isMultiline) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={!editable}
        placeholder={isNull ? "NULL" : ""}
        rows={Math.min(8, Math.max(2, value.split("\n").length))}
        className={cn(
          "w-full resize-y rounded border border-border bg-background px-2 py-1 font-mono text-xs",
          "focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40",
          isNull && "italic text-muted-foreground/60",
          !editable && "cursor-default",
        )}
      />
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      readOnly={!editable}
      placeholder={isNull ? "NULL" : ""}
      className={cn(
        "w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs",
        "focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40",
        isNull && "italic text-muted-foreground/60",
        !editable && "cursor-default",
      )}
    />
  );
}

function NavBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
