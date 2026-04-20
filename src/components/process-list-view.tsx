import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Skull } from "lucide-react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { Uuid, Value } from "@/lib/types";
import { useConnections } from "@/state/connections";

interface Props {
  connectionId: Uuid;
}

function valueText(v: Value): string {
  switch (v.type) {
    case "null":
      return "";
    case "bool":
      return String(v.value);
    case "int":
    case "u_int":
    case "float":
      return String(v.value);
    case "decimal":
    case "string":
    case "date":
    case "time":
    case "date_time":
    case "timestamp":
      return String(v.value);
    case "json":
      return JSON.stringify(v.value);
    case "bytes":
      return `<${v.value.length} bytes>`;
  }
}

function mysqlQuery() {
  return "SHOW FULL PROCESSLIST";
}
function postgresQuery() {
  return `SELECT
    pid,
    usename AS user,
    client_addr AS host,
    datname AS db,
    state,
    EXTRACT(EPOCH FROM (now() - query_start))::int AS time_s,
    wait_event,
    query
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
  ORDER BY query_start NULLS LAST`;
}

function killStatement(driver: string | undefined, id: string) {
  if (driver === "postgres") return `SELECT pg_terminate_backend(${id})`;
  // mysql
  return `KILL ${id}`;
}

/** Encontra a coluna "ID" do processo no resultado. Mysql: "Id". PG: "pid". */
function findIdCol(cols: string[]): number {
  const lower = cols.map((c) => c.toLowerCase());
  const idx = lower.indexOf("id");
  if (idx >= 0) return idx;
  const pidIdx = lower.indexOf("pid");
  if (pidIdx >= 0) return pidIdx;
  return -1;
}

export function ProcessListView({ connectionId }: Props) {
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );
  const connActive = useConnections((s) => s.active.has(connectionId));
  const openConn = useConnections((s) => s.open);
  const [result, setResult] = useState<{
    columns: string[];
    rows: Value[][];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [killingId, setKillingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!conn) return;
    setLoading(true);
    setError(null);
    try {
      // Auto-open da conexão — após restart ela pode ter sido fechada.
      if (!connActive) {
        await openConn(connectionId);
      }
      const sql = conn.driver === "postgres" ? postgresQuery() : mysqlQuery();
      const batch = await ipc.db.runQuery(connectionId, sql, null);
      const first = batch.results[0];
      if (!first) throw new Error("sem resultado");
      if (first.kind === "error") throw new Error(first.message);
      if (first.kind !== "select") throw new Error("não é select");
      setResult({ columns: first.columns, rows: first.rows });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [conn, connectionId, connActive, openConn]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [auto, load]);

  const killProcess = async (id: string) => {
    if (!conn) return;
    const ok = window.confirm(
      `Matar processo ${id} em "${conn.name}"?\n\nIsso aborta a query em execução.`,
    );
    if (!ok) return;
    setKillingId(id);
    try {
      await ipc.db.runQuery(connectionId, killStatement(conn.driver, id), null);
      await load();
    } catch (e) {
      alert(`Falha ao matar ${id}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setKillingId(null);
    }
  };

  const idCol = useMemo(
    () => (result ? findIdCol(result.columns) : -1),
    [result],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 items-center gap-3 border-b border-border bg-card/30 px-3">
        <span className="text-sm font-medium">Processos</span>
        {conn && (
          <span className="text-xs text-muted-foreground">
            {conn.name} · {conn.driver}
          </span>
        )}

        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
            className="h-3 w-3"
          />
          Auto-refresh (3s)
        </label>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          title="Recarregar"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" />
              Erro
            </div>
            <div className="mt-1 font-mono">{error}</div>
          </div>
        ) : !result ? (
          <div className="grid h-full place-items-center text-xs text-muted-foreground">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "—"}
          </div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-card/90 backdrop-blur">
              <tr>
                <th className="border-b border-border px-2 py-1.5 text-left font-medium">
                  ação
                </th>
                {result.columns.map((c) => (
                  <th
                    key={c}
                    className="border-b border-border px-2 py-1.5 text-left font-medium"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => {
                const pid = idCol >= 0 ? valueText(r[idCol]) : "";
                return (
                  <tr key={i} className="hover:bg-accent/30">
                    <td className="border-b border-border/40 px-2 py-1 align-top">
                      <button
                        type="button"
                        onClick={() => void killProcess(pid)}
                        disabled={!pid || killingId === pid}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                        title={`Matar ${pid}`}
                      >
                        {killingId === pid ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Skull className="h-3 w-3" />
                        )}
                        kill
                      </button>
                    </td>
                    {r.map((v, j) => (
                      <td
                        key={j}
                        className="max-w-[300px] truncate border-b border-border/40 px-2 py-1 align-top font-mono"
                        title={valueText(v)}
                      >
                        {valueText(v)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
