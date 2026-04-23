import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Play,
  Sparkles,
  Upload,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { autoMapColumns } from "@/lib/auto-map";
import { parseFile, toValue, type ParsedData } from "@/lib/data-import";
import type { Column, Uuid } from "@/lib/types";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";

const CHUNK = 500;

interface Props {
  /** Optional preselection. */
  initialConnectionId?: Uuid;
  initialSchema?: string;
  initialTable?: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | {
      kind: "done";
      inserted: number;
      errors: Array<{ row: number; message: string }>;
    }
  | { kind: "error"; message: string };

export function DataImportView({
  initialConnectionId,
  initialSchema,
  initialTable,
}: Props) {
  const t = useT();
  const connections = useConnections((s) => s.connections);
  const ensureSchemas = useSchemaCache((s) => s.ensureSchemas);
  const ensureTables = useSchemaCache((s) => s.ensureTables);
  const caches = useSchemaCache((s) => s.caches);

  const [filePath, setFilePath] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedData | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  const [connId, setConnId] = useState<Uuid | null>(initialConnectionId ?? null);
  const [schema, setSchema] = useState<string | null>(initialSchema ?? null);
  const [table, setTable] = useState<string | null>(initialTable ?? null);
  const [cols, setCols] = useState<Column[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  /** Which targets were edited manually (don't overwrite on re-automap). */
  const [manualTargets, setManualTargets] = useState<Set<string>>(new Set());
  const [fuzzySuggestions, setFuzzySuggestions] = useState<
    Record<string, { source: string; score: number }>
  >({});

  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const cache = connId ? caches[connId] : undefined;
  const schemaNames = cache?.schemas?.map((s) => s.name) ?? [];
  const tableList = schema && cache?.tables[schema] ? cache.tables[schema] : [];

  useEffect(() => {
    if (connId) void ensureSchemas(connId).catch(() => void 0);
  }, [connId, ensureSchemas]);

  useEffect(() => {
    if (connId && schema) void ensureTables(connId, schema).catch(() => void 0);
  }, [connId, schema, ensureTables]);

  // Load target table columns to show the mapping.
  useEffect(() => {
    setCols([]);
    if (!connId || !schema || !table) return;
    let cancelled = false;
    ipc.db
      .describeTable(connId, schema, table)
      .then((c) => !cancelled && setCols(c))
      .catch(() => void 0);
    return () => {
      cancelled = true;
    };
  }, [connId, schema, table]);

  // Initial auto-map — only runs when the dataset or target columns change.
  // Preserves manual edits if the same table/file is re-selected.
  useEffect(() => {
    if (!parsed || cols.length === 0) return;
    runAutoMap({ preserveManual: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, cols]);

  const runAutoMap = (opts: { preserveManual: boolean }) => {
    if (!parsed || cols.length === 0) return;
    const preserve: Record<string, string> = {};
    if (opts.preserveManual) {
      for (const t of manualTargets) {
        const v = mapping[t];
        if (v) preserve[t] = v;
      }
    }
    const result = autoMapColumns(
      cols.map((c) => c.name),
      parsed.columns,
      { preserve },
    );
    setMapping(result.mapping);
    setFuzzySuggestions(result.fuzzySuggestions);
    if (!opts.preserveManual) {
      setManualTargets(new Set());
    }
  };

  const setMappingManual = (target: string, source: string) => {
    setMapping((m) => {
      const next = { ...m };
      if (source) next[target] = source;
      else delete next[target];
      return next;
    });
    setManualTargets((s) => new Set(s).add(target));
  };

  const acceptSuggestion = (target: string) => {
    const s = fuzzySuggestions[target];
    if (!s) return;
    setMappingManual(target, s.source);
    setFuzzySuggestions((m) => {
      const next = { ...m };
      delete next[target];
      return next;
    });
  };

  const pickFile = async () => {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Dados",
          extensions: ["csv", "tsv", "json", "xlsx", "xls"],
        },
      ],
    });
    if (!path || Array.isArray(path)) return;
    setFilePath(path);
    setParseErr(null);
    setParsed(null);
    try {
      const bytes = await invoke<number[]>("read_file_bytes", { path });
      const content = new Uint8Array(bytes);
      const fileName = path.replace(/\\/g, "/").split("/").pop() ?? path;
      const data = await parseFile(content, fileName);
      setParsed(data);
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e));
    }
  };

  const canImport =
    parsed && connId && schema && table && Object.keys(mapping).length > 0;

  const runImport = useCallback(async () => {
    if (!parsed || !connId || !schema || !table) return;
    const total = parsed.rows.length;
    setStatus({ kind: "running", done: 0, total });

    try {
      // Pre-compute source indices.
      const sourceIdx = new Map<string, number>();
      parsed.columns.forEach((c, i) => sourceIdx.set(c, i));

      // Pairs (targetCol, sourceIdx).
      const pairs: Array<{ target: string; idx: number }> = [];
      for (const [target, source] of Object.entries(mapping)) {
        const idx = sourceIdx.get(source);
        if (idx != null) pairs.push({ target, idx });
      }
      if (pairs.length === 0) throw new Error("nenhum mapping definido");

      const errors: Array<{ row: number; message: string }> = [];
      let inserted = 0;

      for (let start = 0; start < total; start += CHUNK) {
        const chunk = parsed.rows.slice(start, start + CHUNK);
        const pkEntries = chunk.map((row) =>
          pairs.map((p) => ({
            column: p.target,
            value: toValue(row[p.idx]),
          })),
        );
        const results = await ipc.db.insertTableRows(
          connId,
          schema,
          table,
          pkEntries,
        );
        results.forEach((r, i) => {
          if (r.kind === "ok") inserted++;
          else errors.push({ row: start + i + 1, message: r.message });
        });
        setStatus({
          kind: "running",
          done: Math.min(start + chunk.length, total),
          total,
        });
      }

      setStatus({ kind: "done", inserted, errors });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [parsed, connId, schema, table, mapping]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex h-10 items-center gap-2 border-b border-border bg-card/30 px-3">
        <FileSpreadsheet className="h-4 w-4 text-conn-accent" />
        <span className="text-sm font-medium">Importar CSV / JSON / Excel</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-4">
          {/* 1. File */}
          <Card title="1. Arquivo">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={pickFile}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
              >
                <Upload className="h-3.5 w-3.5" />
                Escolher arquivo
              </button>
              {filePath && (
                <code className="truncate text-xs text-muted-foreground">
                  {filePath}
                </code>
              )}
            </div>
            {parseErr && (
              <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                {parseErr}
              </div>
            )}
            {parsed && (
              <div className="mt-3 text-xs text-muted-foreground">
                {parsed.columns.length} coluna(s) · {parsed.rows.length} linha(s)
              </div>
            )}
          </Card>

          {/* 2. Preview */}
          {parsed && parsed.rows.length > 0 && (
            <Card title="2. Preview (primeiras 10 linhas)">
              <div className="overflow-auto rounded-md border border-border">
                <table className="w-full border-collapse text-[11px]">
                  <thead className="bg-muted/30">
                    <tr>
                      {parsed.columns.map((c) => (
                        <th
                          key={c}
                          className="border-b border-border px-2 py-1 text-left font-medium"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 10).map((r, i) => (
                      <tr key={i}>
                        {parsed.columns.map((_, j) => (
                          <td
                            key={j}
                            className="max-w-[200px] truncate border-b border-border/40 px-2 py-1 align-top font-mono"
                          >
                            {r[j] == null ? "" : String(r[j])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* 3. Target */}
          {parsed && (
            <Card title="3. Destino">
              <div className="grid grid-cols-3 gap-2">
                <SelectField
                  label={t("dataImport.connectionLabel")}
                  value={connId ?? ""}
                  onChange={(v) => {
                    setConnId(v || null);
                    setSchema(null);
                    setTable(null);
                  }}
                  options={[
                    { value: "", label: "—" },
                    ...connections.map((c) => ({
                      value: c.id,
                      label: c.name,
                    })),
                  ]}
                />
                <SelectField
                  label="Schema"
                  value={schema ?? ""}
                  onChange={(v) => {
                    setSchema(v || null);
                    setTable(null);
                  }}
                  disabled={!connId}
                  options={[
                    { value: "", label: "—" },
                    ...schemaNames.map((s) => ({ value: s, label: s })),
                  ]}
                />
                <SelectField
                  label="Tabela"
                  value={table ?? ""}
                  onChange={(v) => setTable(v || null)}
                  disabled={!schema}
                  options={[
                    { value: "", label: "—" },
                    ...tableList.map((t) => ({
                      value: t.name,
                      label: t.name,
                    })),
                  ]}
                />
              </div>
            </Card>
          )}

          {/* 4. Mapping */}
          {cols.length > 0 && parsed && (
            <Card title="4. Mapeamento de colunas">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] text-muted-foreground">
                  Auto-map normaliza nomes (snake/camel/kebab), usa sinônimos e
                  similaridade. Sugestões abaixo do limiar aparecem em cinza.
                </p>
                <button
                  type="button"
                  onClick={() => runAutoMap({ preserveManual: true })}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-accent"
                  title={t("dataImport.preserveManualTitle")}
                >
                  <Sparkles className="h-3 w-3" />
                  Auto-map
                </button>
                <button
                  type="button"
                  onClick={() => runAutoMap({ preserveManual: false })}
                  className="ml-1 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                  title={t("dataImport.discardManualTitle")}
                >
                  reset
                </button>
              </div>
              <div className="grid gap-1">
                {cols.map((c) => {
                  const current = mapping[c.name] ?? "";
                  const suggestion = fuzzySuggestions[c.name];
                  const isManual = manualTargets.has(c.name);
                  return (
                    <div key={c.name} className="flex items-center gap-2">
                      <span className="w-40 shrink-0 truncate text-xs">
                        {c.name}
                        {c.is_primary_key && (
                          <span className="ml-1 text-[10px] text-conn-accent">
                            PK
                          </span>
                        )}
                        {!c.nullable && (
                          <span className="ml-1 text-[10px] text-amber-500">
                            !null
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground">←</span>
                      <select
                        value={current}
                        onChange={(e) =>
                          setMappingManual(c.name, e.target.value)
                        }
                        className={cn(
                          "flex-1 rounded-md border bg-background px-2 py-1 text-xs",
                          isManual
                            ? "border-conn-accent/50"
                            : "border-border",
                        )}
                      >
                        <option value="">— ignorar —</option>
                        {parsed.columns.map((sc) => (
                          <option key={sc} value={sc}>
                            {sc}
                          </option>
                        ))}
                      </select>
                      {!current && suggestion && (
                        <button
                          type="button"
                          onClick={() => acceptSuggestion(c.name)}
                          className="shrink-0 rounded border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-conn-accent hover:text-foreground"
                          title={`Similaridade: ${(suggestion.score * 100).toFixed(0)}%`}
                        >
                          sugerir: {suggestion.source}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <UnmappedWarning
                sourceAll={parsed.columns}
                mapping={mapping}
              />
            </Card>
          )}

          {/* 5. Import */}
          {canImport && (
            <Card title="5. Importar">
              <button
                type="button"
                onClick={() => void runImport()}
                disabled={status.kind === "running"}
                className="inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:opacity-50"
              >
                {status.kind === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 fill-current" />
                )}
                Importar {parsed!.rows.length} linha(s)
              </button>

              {status.kind === "running" && (
                <div className="mt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-conn-accent transition-all"
                      style={{
                        width: `${
                          status.total > 0
                            ? (status.done / status.total) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {status.done.toLocaleString()} /{" "}
                    {status.total.toLocaleString()} linhas
                  </div>
                </div>
              )}

              {status.kind === "done" && (
                <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Concluído: {status.inserted.toLocaleString()} linha(s)
                    inseridas
                  </div>
                  {status.errors.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-destructive">
                        {status.errors.length} erro(s)
                      </summary>
                      <ul className="mt-1 max-h-40 overflow-auto font-mono text-[10px]">
                        {status.errors.slice(0, 200).map((err, i) => (
                          <li key={i}>
                            linha {err.row}: {err.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              {status.kind === "error" && (
                <div
                  className={cn(
                    "mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive",
                  )}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {status.message}
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/40 p-3">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function UnmappedWarning({
  sourceAll,
  mapping,
}: {
  sourceAll: string[];
  mapping: Record<string, string>;
}) {
  const used = new Set(Object.values(mapping));
  const unused = sourceAll.filter((s) => !used.has(s));
  if (unused.length === 0) return null;
  return (
    <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <div>
        <div className="font-medium">
          {unused.length} coluna(s) source não mapeada(s):
        </div>
        <div className="mt-0.5 font-mono">
          {unused.slice(0, 20).join(", ")}
          {unused.length > 20 && ` … +${unused.length - 20}`}
        </div>
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
