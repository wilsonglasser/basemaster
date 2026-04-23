import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Filter,
  Flame,
  Gauge,
  Info,
  Key,
  Rows,
  Table as TableIcon,
  TreePine,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";
import type { Value } from "@/lib/types";

function valueText(v: Value): string {
  if (v.type === "null") return "";
  if (v.type === "bytes") return `<${v.value.length}B>`;
  return String(v.value);
}

export interface ExplainNode {
  label: string;
  nodeType: string;
  target?: string;
  accessType?: string;
  key?: string;
  condition?: string;
  detail?: string;
  estimatedRows?: number;
  actualRows?: number;
  totalCost?: number;
  timeMs?: number;
  loops?: number;
  warnings?: string[];
  raw: unknown;
  children: ExplainNode[];
}

interface ExplainViewProps {
  driver: "mysql" | "postgres" | string;
  raw: unknown;
  rawText?: string;
  /** Columns + rows of classic EXPLAIN (MySQL) — Navicat-style Grid format. */
  classicColumns?: string[];
  classicRows?: Value[][];
  sql: string;
  elapsedMs: number;
  schema: string | null;
  connectionName: string;
  timestamp: number;
}

type Mode = "grid" | "tree" | "flame" | "stats" | "info" | "json";

export function ExplainView(props: ExplainViewProps) {
  const { driver, raw, rawText, classicColumns, classicRows } = props;
  const t = useT();
  const [mode, setMode] = useState<Mode>(
    classicColumns && classicRows ? "grid" : "tree",
  );

  const tree = useMemo(() => {
    try {
      if (driver === "postgres") return parsePostgres(raw);
      return parseMysql(raw);
    } catch (e) {
      console.warn("explain parse failed:", e);
      return null;
    }
  }, [driver, raw]);

  const flatRows = useMemo(() => (tree ? flatten(tree) : []), [tree]);
  const maxCost = useMemo(
    () => flatRows.reduce((m, r) => Math.max(m, r.node.totalCost ?? 0), 0),
    [flatRows],
  );
  const totalCost = tree?.totalCost ?? 0;
  const totalRows = tree?.actualRows ?? tree?.estimatedRows ?? 0;
  const totalTime = tree?.timeMs;

  const copyRaw = () => {
    void navigator.clipboard.writeText(
      rawText ?? JSON.stringify(raw, null, 2),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {classicRows && (
            <ModeBtn
              active={mode === "grid"}
              onClick={() => setMode("grid")}
              icon={<TableIcon className="h-3 w-3" />}
              label={t("explain.viewGrid")}
            />
          )}
          <ModeBtn
            active={mode === "tree"}
            onClick={() => setMode("tree")}
            icon={<TreePine className="h-3 w-3" />}
            label={t("explain.viewTree")}
          />
          <ModeBtn
            active={mode === "flame"}
            onClick={() => setMode("flame")}
            icon={<Flame className="h-3 w-3" />}
            label={t("explain.viewFlame")}
          />
          <ModeBtn
            active={mode === "stats"}
            onClick={() => setMode("stats")}
            icon={<BarChart3 className="h-3 w-3" />}
            label={t("explain.viewStats")}
          />
          <ModeBtn
            active={mode === "info"}
            onClick={() => setMode("info")}
            icon={<Info className="h-3 w-3" />}
            label={t("explain.viewInfo")}
          />
          <ModeBtn
            active={mode === "json"}
            onClick={() => setMode("json")}
            label={t("explain.viewRaw")}
          />
        </div>

        {tree && (
          <div className="ml-3 flex items-center gap-3 text-muted-foreground">
            {totalCost > 0 && (
              <Stat
                icon={<Gauge className="h-3 w-3" />}
                label={t("explain.totalCost")}
                value={fmtCost(totalCost)}
              />
            )}
            {totalRows > 0 && (
              <Stat
                icon={<Rows className="h-3 w-3" />}
                value={fmtRows(totalRows)}
              />
            )}
            {totalTime != null && (
              <Stat
                icon={<Clock className="h-3 w-3" />}
                value={fmtTime(totalTime)}
              />
            )}
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {driver}
            </span>
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

      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "grid" && classicColumns && classicRows ? (
          <GridMode columns={classicColumns} rows={classicRows} />
        ) : mode === "tree" ? (
          tree ? (
            <div className="p-3">
              <TreeNode node={tree} depth={0} maxCost={maxCost} />
            </div>
          ) : (
            <ParseFailedMsg />
          )
        ) : mode === "flame" ? (
          tree ? (
            <FlameMode rows={flatRows} />
          ) : (
            <ParseFailedMsg />
          )
        ) : mode === "stats" ? (
          tree ? (
            <StatsMode rows={flatRows} totalCost={totalCost} />
          ) : (
            <ParseFailedMsg />
          )
        ) : mode === "info" ? (
          <InfoMode {...props} tree={tree} />
        ) : (
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
            {rawText ?? JSON.stringify(raw, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/40",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label?: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {icon}
      {label ? `${label}: ${value}` : value}
    </span>
  );
}

function ParseFailedMsg() {
  const t = useT();
  return (
    <div className="p-3 text-xs text-muted-foreground">
      {t("explain.parseFailed")}
    </div>
  );
}

// ---------- Grid (classic EXPLAIN) ----------

function GridMode({ columns, rows }: { columns: string[]; rows: Value[][] }) {
  return (
    <table className="min-w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur">
        <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
          {columns.map((c) => (
            <th
              key={c}
              className="border-b border-border px-2 py-2 font-medium"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-t border-border/60 align-top">
            {row.map((cell, j) => {
              const text = valueText(cell);
              const isNull = cell.type === "null";
              return (
                <td
                  key={j}
                  className={cn(
                    "px-2 py-1.5 font-mono",
                    isNull
                      ? "text-muted-foreground/60 italic"
                      : "text-foreground",
                  )}
                >
                  {isNull ? "(null)" : text}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- Flame chart ----------

interface FlatRow {
  depth: number;
  node: ExplainNode;
}

function flatten(n: ExplainNode, depth = 0, acc: FlatRow[] = []): FlatRow[] {
  acc.push({ depth, node: n });
  for (const c of n.children) flatten(c, depth + 1, acc);
  return acc;
}

function FlameMode({ rows }: { rows: FlatRow[] }) {
  const maxDepth = Math.max(0, ...rows.map((r) => r.depth));
  const [hovered, setHovered] = useState<ExplainNode | null>(null);

  // Compute range per depth: width proportional to the node's cost
  // relative to the parent (or total). Each depth is a horizontal row.
  const layout = useMemo(() => buildFlame(rows), [rows]);

  return (
    <div className="p-3">
      <div
        className="relative rounded-md border border-border bg-card/30 p-2"
        style={{ height: `${(maxDepth + 1) * 36 + 16}px` }}
      >
        {layout.map((box, i) => {
          const color = nodeColor(box.node.nodeType);
          const isHovered = hovered === box.node;
          return (
            <div
              key={i}
              onMouseEnter={() => setHovered(box.node)}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                "absolute flex cursor-default items-center overflow-hidden rounded-sm border border-black/20 px-2 text-[11px] font-medium text-white transition-opacity",
                color,
                isHovered ? "opacity-100 ring-1 ring-white/40" : "opacity-85",
              )}
              style={{
                left: `${box.x * 100}%`,
                width: `${box.w * 100}%`,
                top: `${box.depth * 36 + 8}px`,
                height: "30px",
              }}
              title={flameTooltip(box.node)}
            >
              <span className="truncate">
                {box.node.label}
                {box.node.timeMs != null && (
                  <span className="ml-1.5 opacity-70">
                    {fmtTime(box.node.timeMs)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {hovered && (
        <div className="mt-3 rounded-md border border-border bg-card/40 p-3 text-xs">
          <div className="font-semibold">{hovered.label}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-muted-foreground">
            {hovered.totalCost != null && (
              <span>cost={fmtCost(hovered.totalCost)}</span>
            )}
            {hovered.estimatedRows != null && (
              <span>est={fmtRows(hovered.estimatedRows)}</span>
            )}
            {hovered.actualRows != null && (
              <span>
                actual={fmtRows(hovered.actualRows)}
                {hovered.loops && hovered.loops > 1 ? ` ×${hovered.loops}` : ""}
              </span>
            )}
            {hovered.timeMs != null && <span>{fmtTime(hovered.timeMs)}</span>}
          </div>
          {hovered.condition && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
              {hovered.condition}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface FlameBox {
  node: ExplainNode;
  depth: number;
  x: number; // 0..1
  w: number; // 0..1
}

function buildFlame(rows: FlatRow[]): FlameBox[] {
  if (rows.length === 0) return [];
  const rootNode = rows[0].node;
  const rootMetric = flameMetric(rootNode) || 1;
  const boxes: FlameBox[] = [];
  layoutNode(rootNode, 0, 0, 1, rootMetric, boxes);
  return boxes;
}

function layoutNode(
  n: ExplainNode,
  depth: number,
  x: number,
  w: number,
  rootMetric: number,
  out: FlameBox[],
) {
  out.push({ node: n, depth, x, w });
  if (n.children.length === 0) return;
  const childMetrics = n.children.map((c) => flameMetric(c) || 0.01);
  const sum = childMetrics.reduce((a, b) => a + b, 0);
  let cursor = x;
  for (let i = 0; i < n.children.length; i++) {
    const frac = childMetrics[i] / sum;
    const cw = w * frac;
    layoutNode(n.children[i], depth + 1, cursor, cw, rootMetric, out);
    cursor += cw;
  }
  void rootMetric;
}

function flameMetric(n: ExplainNode): number {
  return n.timeMs ?? n.totalCost ?? n.actualRows ?? n.estimatedRows ?? 1;
}

function flameTooltip(n: ExplainNode): string {
  const parts = [n.label];
  if (n.totalCost != null) parts.push(`cost=${fmtCost(n.totalCost)}`);
  if (n.timeMs != null) parts.push(fmtTime(n.timeMs));
  if (n.actualRows != null) parts.push(`actual=${fmtRows(n.actualRows)}`);
  return parts.join(" · ");
}

// ---------- Statistics ----------

function StatsMode({
  rows,
  totalCost,
}: {
  rows: FlatRow[];
  totalCost: number;
}) {
  const t = useT();
  const agg = useMemo(() => {
    const m = new Map<string, { count: number; cost: number; time: number }>();
    for (const r of rows) {
      const k = r.node.accessType || r.node.nodeType;
      const cur = m.get(k) ?? { count: 0, cost: 0, time: 0 };
      cur.count += 1;
      cur.cost += r.node.totalCost ?? 0;
      cur.time += r.node.timeMs ?? 0;
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([k, v]) => ({ type: k, ...v }))
      .sort((a, b) => b.cost - a.cost);
  }, [rows]);

  const sumCost = agg.reduce((a, b) => a + b.cost, 0) || totalCost || 1;
  const sumTime = agg.reduce((a, b) => a + b.time, 0);

  return (
    <table className="min-w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur">
        <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
          <th className="border-b border-border px-2 py-2 font-medium">
            {t("explain.col.nodeType")}
          </th>
          <th className="border-b border-border px-2 py-2 text-right font-medium">
            {t("explain.col.count")}
          </th>
          <th className="border-b border-border px-2 py-2 text-right font-medium">
            {t("explain.col.cost")}
          </th>
          <th className="border-b border-border px-2 py-2 text-right font-medium">
            {t("explain.col.costPct")}
          </th>
          {sumTime > 0 && (
            <th className="border-b border-border px-2 py-2 text-right font-medium">
              {t("explain.col.time")}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {agg.map((row, i) => {
          const pct = sumCost > 0 ? (row.cost / sumCost) * 100 : 0;
          const color = nodeColor(row.type);
          return (
            <tr key={i} className="border-t border-border/60">
              <td className="px-2 py-1.5">
                <span className="inline-flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", color)} />
                  <span className="font-mono">{row.type}</span>
                </span>
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {row.count}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {fmtCost(row.cost)}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <div className="flex items-center justify-end gap-2">
                  <span>{pct.toFixed(2)}%</span>
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full",
                        pct > 60
                          ? "bg-destructive"
                          : pct > 30
                            ? "bg-amber-500"
                            : "bg-conn-accent",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </td>
              {sumTime > 0 && (
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {row.time > 0 ? fmtTime(row.time) : "—"}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------- Info ----------

function InfoMode({
  sql,
  elapsedMs,
  schema,
  connectionName,
  timestamp,
  driver,
  tree,
}: ExplainViewProps & { tree: ExplainNode | null }) {
  const t = useT();
  const dt = new Date(timestamp);
  return (
    <div className="space-y-4 p-4 text-xs">
      <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2">
        <Label>{t("explain.info.timestamp")}</Label>
        <Value>
          <Clock className="mr-1 inline h-3 w-3 text-muted-foreground" />
          {dt.toLocaleString()}
        </Value>
        <Label>{t("explain.info.queryTime")}</Label>
        <Value>{fmtTime(elapsedMs)}</Value>
        <Label>{t("explain.info.connection")}</Label>
        <Value>
          <Database className="mr-1 inline h-3 w-3 text-muted-foreground" />
          {connectionName}
        </Value>
        <Label>{t("explain.info.database")}</Label>
        <Value>{schema ?? "—"}</Value>
        <Label>{t("explain.info.driver")}</Label>
        <Value className="font-mono">{driver}</Value>
        {tree?.totalCost != null && (
          <>
            <Label>{t("explain.info.planCost")}</Label>
            <Value>{fmtCost(tree.totalCost)}</Value>
          </>
        )}
        {tree?.timeMs != null && (
          <>
            <Label>{t("explain.info.planTime")}</Label>
            <Value>{fmtTime(tree.timeMs)}</Value>
          </>
        )}
      </div>

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("explain.info.sql")}
        </div>
        <pre className="overflow-auto rounded-md border border-border bg-card/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
          {sql}
        </pre>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
function Value({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("text-foreground", className)}>
      {children}
    </div>
  );
}

// ---------- Tree ----------

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
  const color = nodeColor(node.nodeType);

  return (
    <div>
      <div
        className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/30"
        style={{ paddingLeft: `${depth * 18 + 6}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className={cn(
            "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground",
            !hasKids && "invisible",
          )}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>

        <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", color)} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{node.label}</span>
            {node.accessType && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {node.accessType}
              </span>
            )}
            {node.key && (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                <Key className="h-2.5 w-2.5" />
                {node.key}
              </span>
            )}
            {node.condition && (
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                <Filter className="mr-1 inline h-2.5 w-2.5" />
                {node.condition}
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
            {node.totalCost != null && (
              <span>cost={fmtCost(node.totalCost)}</span>
            )}
            {node.estimatedRows != null && (
              <span>est={fmtRows(node.estimatedRows)}</span>
            )}
            {node.actualRows != null && (
              <span>
                actual={fmtRows(node.actualRows)}
                {node.loops && node.loops > 1 ? ` ×${node.loops}` : ""}
              </span>
            )}
            {node.timeMs != null && (
              <span>
                <Activity className="mr-0.5 inline h-2.5 w-2.5" />
                {fmtTime(node.timeMs)}
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

          {costPct > 0 && (
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

// ---------- Colors ----------

function nodeColor(nodeType: string): string {
  const nt = nodeType.toLowerCase();
  if (nt.includes("seq scan") || nt === "all" || nt.includes("full"))
    return "bg-destructive";
  if (nt.includes("index scan") || nt === "ref" || nt === "range")
    return "bg-emerald-500";
  if (nt.includes("index only") || nt === "index" || nt === "const")
    return "bg-emerald-400";
  if (nt.includes("bitmap")) return "bg-amber-500";
  if (nt.includes("nested loop") || nt.includes("nested"))
    return "bg-blue-400";
  if (nt.includes("hash join") || nt === "hash") return "bg-violet-500";
  if (nt.includes("merge join")) return "bg-indigo-500";
  if (nt.includes("sort")) return "bg-amber-400";
  if (nt.includes("aggregate") || nt.includes("group")) return "bg-cyan-400";
  if (nt.includes("limit")) return "bg-muted-foreground";
  return "bg-muted-foreground";
}

// ---------- Parsers ----------

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
  const rel = (p["Relation Name"] as string | undefined) ?? undefined;
  const alias = (p["Alias"] as string | undefined) ?? undefined;
  const target = rel
    ? alias && alias !== rel
      ? `${rel} (${alias})`
      : rel
    : undefined;

  const totalCost = numOrNull(p["Total Cost"]);
  const estRows = numOrNull(p["Plan Rows"]);
  const actualRows = numOrNull(p["Actual Rows"]);
  const loops = numOrNull(p["Actual Loops"]);
  const actualMs = numOrNull(p["Actual Total Time"]);

  const accessType = pgAccessType(nodeType);
  const key = (p["Index Name"] as string | undefined) ?? undefined;
  const cond =
    (p["Index Cond"] as string | undefined) ||
    (p["Filter"] as string | undefined) ||
    (p["Hash Cond"] as string | undefined) ||
    (p["Join Filter"] as string | undefined) ||
    (p["Merge Cond"] as string | undefined);

  const warnings = pgWarnings(nodeType, p);
  const kids = Array.isArray(p["Plans"]) ? (p["Plans"] as unknown[]) : [];
  return {
    label: target ? `${nodeType} on ${target}` : nodeType,
    nodeType,
    target,
    accessType,
    key,
    condition: cond,
    estimatedRows: estRows ?? undefined,
    actualRows: actualRows ?? undefined,
    totalCost: totalCost ?? undefined,
    timeMs: actualMs ?? undefined,
    loops: loops ?? undefined,
    warnings: warnings.length ? warnings : undefined,
    raw: p,
    children: kids.map((c) => pgNode(c as Record<string, unknown>)),
  };
}

function pgAccessType(nodeType: string): string | undefined {
  const nt = nodeType.toLowerCase();
  if (nt.includes("seq scan")) return "seq scan";
  if (nt.includes("index only scan")) return "index only";
  if (nt.includes("index scan")) return "index scan";
  if (nt.includes("bitmap index scan")) return "bitmap index";
  if (nt.includes("bitmap heap scan")) return "bitmap heap";
  if (nt.includes("nested loop")) return "nested";
  if (nt.includes("hash join")) return "hash";
  if (nt.includes("merge join")) return "merge";
  return undefined;
}

function pgWarnings(nodeType: string, p: Record<string, unknown>): string[] {
  const w: string[] = [];
  const estRows = numOrNull(p["Plan Rows"]) ?? 0;
  const actualRows = numOrNull(p["Actual Rows"]) ?? 0;
  if (nodeType === "Seq Scan" && estRows > 10_000) w.push("seq scan grande");
  if (estRows > 0 && actualRows > 0) {
    const ratio =
      actualRows > estRows ? actualRows / estRows : estRows / actualRows;
    if (ratio > 10) w.push(`estimativa ${ratio.toFixed(0)}× off`);
  }
  const buffers = numOrNull(p["Shared Read Blocks"]) ?? 0;
  if (buffers > 1000) w.push(`${buffers} buffers lidos`);
  return w;
}

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
      for (const item of v)
        children.push(mysqlAny(item as Record<string, unknown>));
    } else if (v && typeof v === "object") {
      children.push(mysqlAny(v as Record<string, unknown>));
    }
  }

  return {
    label: `query_block #${block["select_id"] ?? "?"}`,
    nodeType: "query_block",
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
      nodeType: "nested_loop",
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
    nodeType: key,
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
  const costInfo = tbl["cost_info"] as Record<string, unknown> | undefined;
  const cost =
    numOrNull(costInfo?.["read_cost"]) ??
    numOrNull(costInfo?.["eval_cost"]) ??
    numOrNull(costInfo?.["prefix_cost"]);
  const cond =
    (tbl["attached_condition"] as string | undefined) ||
    (tbl["index_condition"] as string | undefined);

  const warnings: string[] = [];
  if (access === "ALL" && (rowsExamined ?? 0) > 10_000)
    warnings.push("full_table_scan");
  if (access === "index" && !key) warnings.push("sem key");
  if (tbl["using_temporary_table"]) warnings.push("temp table");
  if (tbl["using_filesort"]) warnings.push("filesort");

  return {
    label: `table: ${name ?? "?"}`,
    nodeType: access ?? "table",
    target: name,
    accessType: access,
    key,
    condition: cond,
    estimatedRows: rowsExamined ?? undefined,
    actualRows: rowsProduced ?? undefined,
    totalCost: cost ?? undefined,
    warnings: warnings.length ? warnings : undefined,
    raw: tbl,
    children: [],
  };
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
