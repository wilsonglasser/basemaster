import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Gauge,
  Rows,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";

export interface ExplainNode {
  label: string;
  detail?: string;
  estimatedRows?: number;
  actualRows?: number;
  totalCost?: number;
  timeMs?: number;
  loops?: number;
  /** Warnings detectados (seq scan em tabela grande, sort sem index, etc.) */
  warnings?: string[];
  /** Raw do driver pra debugging / copy */
  raw: unknown;
  children: ExplainNode[];
}

interface ExplainViewProps {
  driver: "mysql" | "postgres" | string;
  raw: unknown;
  /** Texto bruto do plano — mostrado na aba "Raw JSON" pra copy/debug. */
  rawText?: string;
}

export function ExplainView({ driver, raw, rawText }: ExplainViewProps) {
  const t = useT();
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  const tree = useMemo(() => {
    try {
      if (driver === "postgres") return parsePostgres(raw);
      return parseMysql(raw);
    } catch (e) {
      console.warn("explain parse failed:", e);
      return null;
    }
  }, [driver, raw]);

  const totalCost = tree?.totalCost ?? 0;
  const totalRows = tree?.actualRows ?? tree?.estimatedRows ?? 0;
  const totalTime = tree?.timeMs;

  const copyRaw = () => {
    void navigator.clipboard.writeText(rawText ?? JSON.stringify(raw, null, 2));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
        <div className="inline-flex rounded-md border border-border">
          <button
            type="button"
            onClick={() => setMode("tree")}
            className={cn(
              "px-3 py-1 text-xs",
              mode === "tree"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/40",
            )}
          >
            {t("explain.viewTree")}
          </button>
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={cn(
              "px-3 py-1 text-xs",
              mode === "raw"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/40",
            )}
          >
            {t("explain.viewRaw")}
          </button>
        </div>

        {tree && (
          <div className="flex items-center gap-3 text-muted-foreground">
            {totalCost > 0 && (
              <span className="inline-flex items-center gap-1">
                <Gauge className="h-3 w-3" />
                {t("explain.totalCost")}: {fmtCost(totalCost)}
              </span>
            )}
            {totalRows > 0 && (
              <span className="inline-flex items-center gap-1">
                <Rows className="h-3 w-3" />
                {fmtRows(totalRows)}
              </span>
            )}
            {totalTime != null && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {fmtTime(totalTime)}
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={copyRaw}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("explain.copyRaw")}
        >
          <Copy className="h-3 w-3" />
          {t("explain.copy")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {mode === "tree" ? (
          tree ? (
            <TreeNode node={tree} depth={0} maxCost={tree.totalCost ?? 0} />
          ) : (
            <div className="text-xs text-muted-foreground">
              {t("explain.parseFailed")}
            </div>
          )
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/80">
            {rawText ?? JSON.stringify(raw, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  maxCost,
}: {
  node: ExplainNode;
  depth: number;
  maxCost: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasKids = node.children.length > 0;
  const costPct =
    maxCost > 0 && node.totalCost != null
      ? Math.min(100, (node.totalCost / maxCost) * 100)
      : 0;

  const estVsAct =
    node.estimatedRows != null && node.actualRows != null
      ? rowEstimationBadge(node.estimatedRows, node.actualRows)
      : null;

  return (
    <div>
      <div
        className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/30"
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className={cn(
            "mt-0.5 grid h-4 w-4 place-items-center shrink-0 rounded text-muted-foreground",
            !hasKids && "invisible",
          )}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>

        <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{node.label}</span>
            {node.detail && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {node.detail}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
            {node.totalCost != null && (
              <span>
                cost={fmtCost(node.totalCost)}
              </span>
            )}
            {node.estimatedRows != null && (
              <span>
                rows≈{fmtRows(node.estimatedRows)}
              </span>
            )}
            {node.actualRows != null && (
              <span>
                actual={fmtRows(node.actualRows)}
                {node.loops && node.loops > 1 ? ` ×${node.loops}` : ""}
              </span>
            )}
            {node.timeMs != null && <span>{fmtTime(node.timeMs)}</span>}
            {estVsAct && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5",
                  estVsAct.severity === "warn"
                    ? "bg-amber-500/15 text-amber-500"
                    : estVsAct.severity === "bad"
                      ? "bg-destructive/15 text-destructive"
                      : "bg-emerald-500/15 text-emerald-500",
                )}
              >
                {estVsAct.label}
              </span>
            )}
            {node.warnings?.map((w, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-500"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {w}
              </span>
            ))}
          </div>

          {costPct > 0 && node.totalCost != null && (
            <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full",
                  costPct > 60
                    ? "bg-destructive"
                    : costPct > 30
                      ? "bg-amber-500"
                      : "bg-conn-accent",
                )}
                style={{ width: `${costPct}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {expanded &&
        node.children.map((c, i) => (
          <TreeNode key={i} node={c} depth={depth + 1} maxCost={maxCost} />
        ))}
    </div>
  );
}

// ---------- Parsers ----------

/** PG: `EXPLAIN (FORMAT JSON[, ANALYZE])` retorna `[{ Plan: {...} }]`. */
function parsePostgres(raw: unknown): ExplainNode | null {
  const arr = unwrapPgRaw(raw);
  if (!arr || !Array.isArray(arr) || arr.length === 0) return null;
  const root = (arr[0] as Record<string, unknown>).Plan as
    | Record<string, unknown>
    | undefined;
  if (!root) return null;
  return pgNode(root);
}

function unwrapPgRaw(raw: unknown): unknown {
  // PG retorna uma coluna "QUERY PLAN" com array JSON; dependendo de como
  // o driver devolve, pode vir como string ou já parseado.
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) return raw;
  return null;
}

function pgNode(p: Record<string, unknown>): ExplainNode {
  const nodeType = String(p["Node Type"] ?? "Node");
  const label = buildPgLabel(nodeType, p);
  const totalCost = numOrNull(p["Total Cost"]);
  const startupCost = numOrNull(p["Startup Cost"]);
  const estRows = numOrNull(p["Plan Rows"]);
  const actualRows = numOrNull(p["Actual Rows"]);
  const loops = numOrNull(p["Actual Loops"]);
  const actualMs = numOrNull(p["Actual Total Time"]);

  const detailParts: string[] = [];
  if (p["Index Name"]) detailParts.push(`index=${p["Index Name"]}`);
  if (p["Filter"]) detailParts.push(`filter=${p["Filter"]}`);
  if (p["Index Cond"]) detailParts.push(`cond=${p["Index Cond"]}`);
  if (p["Hash Cond"]) detailParts.push(`on=${p["Hash Cond"]}`);
  if (p["Join Filter"]) detailParts.push(`join=${p["Join Filter"]}`);

  const warnings = pgWarnings(nodeType, p);
  const kids = Array.isArray(p["Plans"]) ? (p["Plans"] as unknown[]) : [];
  return {
    label,
    detail: detailParts.join(" · ") || undefined,
    estimatedRows: estRows ?? undefined,
    actualRows: actualRows ?? undefined,
    totalCost: totalCost ?? undefined,
    timeMs: actualMs ?? undefined,
    loops: loops ?? undefined,
    warnings: warnings.length ? warnings : undefined,
    raw: p,
    children: kids.map((c) => pgNode(c as Record<string, unknown>)),
  };
  void startupCost;
}

function buildPgLabel(nodeType: string, p: Record<string, unknown>): string {
  const rel = p["Relation Name"];
  const alias = p["Alias"];
  if (rel) {
    const name = alias && alias !== rel ? `${rel} (${alias})` : rel;
    return `${nodeType} on ${name}`;
  }
  return nodeType;
}

function pgWarnings(nodeType: string, p: Record<string, unknown>): string[] {
  const w: string[] = [];
  const estRows = numOrNull(p["Plan Rows"]) ?? 0;
  const actualRows = numOrNull(p["Actual Rows"]) ?? 0;
  if (nodeType === "Seq Scan" && estRows > 10_000) {
    w.push("seq scan grande");
  }
  if (estRows > 0 && actualRows > 0) {
    const ratio =
      actualRows > estRows ? actualRows / estRows : estRows / actualRows;
    if (ratio > 10) w.push("estimativa ruim");
  }
  return w;
}

/** MySQL: `EXPLAIN FORMAT=JSON` retorna UMA coluna com uma string JSON. */
function parseMysql(raw: unknown): ExplainNode | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const block = (parsed as Record<string, unknown>)?.query_block;
  if (!block || typeof block !== "object") return null;
  return mysqlBlock(block as Record<string, unknown>);
}

function mysqlBlock(block: Record<string, unknown>): ExplainNode {
  const costInfo = block["cost_info"] as Record<string, unknown> | undefined;
  const queryCost = numOrNull(costInfo?.["query_cost"]);
  const children: ExplainNode[] = [];

  const kinds = [
    "table",
    "nested_loop",
    "grouping_operation",
    "ordering_operation",
    "duplicates_removal",
    "union_result",
  ] as const;
  for (const k of kinds) {
    const v = block[k];
    if (Array.isArray(v)) {
      for (const item of v) children.push(mysqlAny(item as Record<string, unknown>));
    } else if (v && typeof v === "object") {
      children.push(mysqlAny(v as Record<string, unknown>));
    }
  }

  return {
    label: `query_block #${block["select_id"] ?? "?"}`,
    totalCost: queryCost ?? undefined,
    raw: block,
    children,
  };
}

function mysqlAny(n: Record<string, unknown>): ExplainNode {
  if (n["table"]) return mysqlTable(n["table"] as Record<string, unknown>);
  if (n["nested_loop"]) {
    const arr = n["nested_loop"] as unknown[];
    return {
      label: "nested_loop",
      raw: n,
      children: arr.map((it) => mysqlAny(it as Record<string, unknown>)),
    };
  }
  if (n["query_block"]) {
    return mysqlBlock(n["query_block"] as Record<string, unknown>);
  }
  const key = Object.keys(n)[0] ?? "node";
  const v = n[key];
  return {
    label: key,
    raw: n,
    children:
      v && typeof v === "object"
        ? [mysqlAny(v as Record<string, unknown>)]
        : [],
  };
}

function mysqlTable(tbl: Record<string, unknown>): ExplainNode {
  const name = tbl["table_name"] as string | undefined;
  const access = tbl["access_type"] as string | undefined;
  const key = tbl["key"] as string | undefined;
  const rowsExamined = numOrNull(tbl["rows_examined_per_scan"]);
  const rowsProduced = numOrNull(tbl["rows_produced_per_join"]);
  const cost = numOrNull(
    (tbl["cost_info"] as Record<string, unknown> | undefined)?.[
      "read_cost"
    ] ??
      (tbl["cost_info"] as Record<string, unknown> | undefined)?.[
        "eval_cost"
      ],
  );
  const detailParts: string[] = [];
  if (access) detailParts.push(`access=${access}`);
  if (key) detailParts.push(`key=${key}`);
  if (tbl["attached_condition"])
    detailParts.push(`cond=${tbl["attached_condition"]}`);

  const warnings: string[] = [];
  if (access === "ALL" && (rowsExamined ?? 0) > 10_000) {
    warnings.push("full scan grande");
  }
  if (access === "index" && !key) {
    warnings.push("sem key");
  }

  return {
    label: `table: ${name ?? "?"}`,
    detail: detailParts.join(" · ") || undefined,
    estimatedRows: rowsExamined ?? undefined,
    actualRows: rowsProduced ?? undefined,
    totalCost: cost ?? undefined,
    warnings: warnings.length ? warnings : undefined,
    raw: tbl,
    children: [],
  };
}

function rowEstimationBadge(
  est: number,
  actual: number,
): { label: string; severity: "ok" | "warn" | "bad" } | null {
  if (est <= 0 || actual <= 0) return null;
  const ratio = actual > est ? actual / est : est / actual;
  if (ratio < 2) return { label: "estimativa ok", severity: "ok" };
  if (ratio < 10)
    return { label: `estimativa ${ratio.toFixed(1)}× off`, severity: "warn" };
  return { label: `estimativa ${ratio.toFixed(1)}× off`, severity: "bad" };
}

// ---------- helpers ----------

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function fmtCost(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(2);
}

function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTime(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
