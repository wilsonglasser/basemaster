import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Loader2, X } from "lucide-react";

import { EXPORT_FORMATS, type ExportFormat } from "@/lib/export";
import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";

/** Picker result. The caller decides what to do with format + columns. */
export interface ExportChoice {
  format: ExportFormat;
  columns: string[];
  path: string;
}

/** Export progress — reported by the caller during the work. */
export interface ExportProgress {
  done: number;
  total: number | null;
  message?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  columns: readonly string[];
  /** Default base name suggested in the save dialog. */
  defaultName: string;
  /** Known total row count (optional — streaming may not know). */
  rowCount?: number | null;
  /** Supported formats. Default = all. Useful to disable XLSX in
   *  streaming mode (in-memory-only). */
  allowedFormats?: ExportFormat[];
  /** Runs the export. Receives what the user chose. Can update
   *  progress via setProgress (rendered by the dialog). Throws on error. */
  onExport: (
    choice: ExportChoice,
    setProgress: (p: ExportProgress | null) => void,
  ) => Promise<void>;
}

export function ExportDialog({
  open,
  onClose,
  columns,
  defaultName,
  rowCount,
  allowedFormats,
  onExport,
}: Props) {
  const t = useT();
  const formats = useMemo(
    () =>
      allowedFormats
        ? EXPORT_FORMATS.filter((f) => allowedFormats.includes(f.id))
        : EXPORT_FORMATS,
    [allowedFormats],
  );
  const [format, setFormat] = useState<ExportFormat>(
    formats[0]?.id ?? "csv_comma",
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(columns),
  );
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);

  useEffect(() => {
    if (open) {
      setSelected(new Set(columns));
      setFilter("");
      setRunning(false);
      setProgress(null);
      if (!formats.some((f) => f.id === format)) {
        setFormat(formats[0]?.id ?? "csv_comma");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, columns]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, running]);

  const visibleColumns = useMemo(() => {
    if (!filter.trim()) return columns;
    const q = filter.toLowerCase();
    return columns.filter((c) => c.toLowerCase().includes(q));
  }, [columns, filter]);

  const toggle = (col: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(columns));
  const selectNone = () => setSelected(new Set());

  const handleExport = async () => {
    if (selected.size === 0) {
      alert(t("exportDialog.selectAtLeastOneColumn"));
      return;
    }
    const meta = EXPORT_FORMATS.find((f) => f.id === format);
    const ext =
      format === "xlsx"
        ? "xlsx"
        : format === "json"
          ? "json"
          : "csv";
    const path = await save({
      title: t("exportDialog.title"),
      defaultPath: `${defaultName}.${ext}`,
      filters: [
        { name: meta?.label ?? ext.toUpperCase(), extensions: [ext] },
      ],
    });
    if (!path) return;

    const orderedCols = columns.filter((c) => selected.has(c));
    setRunning(true);
    setProgress(null);
    try {
      await onExport({ format, columns: orderedCols, path }, setProgress);
      onClose();
    } catch (e) {
      alert(t("exportDialog.exportFailed", { error: String(e) }));
    } finally {
      setRunning(false);
    }
  };

  if (!open) return null;

  const pct =
    progress && progress.total && progress.total > 0
      ? Math.min(100, (progress.done / progress.total) * 100)
      : null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex max-h-[80vh] w-[520px] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <Download className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("exportDialog.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title={t("exportDialog.closeTitle")}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          <section>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("exportDialog.formatLabel")}
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {formats.map((f) => (
                <label
                  key={f.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                    format === f.id
                      ? "border-conn-accent/60 bg-conn-accent/10 text-foreground"
                      : "border-border hover:bg-accent/40",
                  )}
                >
                  <input
                    type="radio"
                    name="export-format"
                    checked={format === f.id}
                    onChange={() => setFormat(f.id)}
                    className="h-3 w-3 accent-conn-accent"
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("exportDialog.columnsLabel", {
                  selected: selected.size,
                  total: columns.length,
                })}
              </label>
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {t("exportDialog.selectAll")}
                </button>
                <span className="text-muted-foreground/40">·</span>
                <button
                  type="button"
                  onClick={selectNone}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {t("exportDialog.selectNone")}
                </button>
              </div>
            </div>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("exportDialog.filterPlaceholder")}
              className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
            />
            <div className="max-h-[240px] overflow-auto rounded-md border border-border">
              {visibleColumns.length === 0 ? (
                <div className="p-3 text-center text-[11px] italic text-muted-foreground">
                  {t("exportDialog.noColumnsMatch")}
                </div>
              ) : (
                <ul className="grid grid-cols-2 gap-0.5 p-1.5">
                  {visibleColumns.map((col) => (
                    <li key={col}>
                      <label className="flex cursor-pointer items-center gap-2 truncate rounded px-2 py-1 text-xs hover:bg-accent/40">
                        <input
                          type="checkbox"
                          checked={selected.has(col)}
                          onChange={() => toggle(col)}
                          className="h-3 w-3 accent-conn-accent"
                        />
                        <span className="truncate font-mono">{col}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {rowCount != null && (
            <div className="text-[11px] text-muted-foreground">
              {t("exportDialog.rowsCountLine", {
                count: rowCount.toLocaleString(),
                plural: rowCount === 1 ? "" : "s",
                speed:
                  rowCount > 100_000
                    ? t("exportDialog.speedSlow")
                    : t("exportDialog.speedFast"),
              })}
            </div>
          )}

          {running && (
            <div className="rounded-md border border-border bg-card/40 p-3">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">
                  {progress?.message ?? t("exportDialog.exporting")}
                </span>
                {progress && (
                  <span className="tabular-nums text-muted-foreground">
                    {progress.total != null
                      ? t("exportDialog.rowsProgressTotal", {
                          done: progress.done.toLocaleString(),
                          total: progress.total.toLocaleString(),
                        })
                      : t("exportDialog.rowsProgress", {
                          done: progress.done.toLocaleString(),
                        })}
                  </span>
                )}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full bg-conn-accent transition-all duration-200",
                    pct == null && "animate-pulse w-full",
                  )}
                  style={pct != null ? { width: `${pct}%` } : undefined}
                />
              </div>
            </div>
          )}
        </div>

        <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-border px-4">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("exportDialog.cancel")}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={running || selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {t("exportDialog.exportBtn")}
          </button>
        </footer>
      </div>
    </div>
  );
}
