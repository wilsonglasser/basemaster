import { useMemo } from "react";
import { Database, FileCode2, Save, Table as TableIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useSavedQueries } from "@/state/saved-queries";
import { useSchemaCache } from "@/state/schema-cache";
import { useTabs } from "@/state/tabs";

interface Props {
  query: string;
  onResultClicked: () => void;
}

type ResultKind = "schema" | "table" | "view" | "saved_query";

interface SearchResult {
  key: string;
  kind: ResultKind;
  connId: string;
  connName: string;
  connColor?: string | null;
  schema: string;
  label: string;
  /** Para saved queries: SQL truncado pra tooltip / hint. */
  hint?: string;
  /** Para saved queries. */
  savedQueryId?: string;
  savedQuerySql?: string;
}

function includesCI(needle: string, hay: string): boolean {
  return hay.toLowerCase().includes(needle);
}

/**
 * Vasculha o que tá cacheado pra cada conexão ativa (schemas + tables +
 * saved queries). Search global é best-effort — sem chamar o banco. Se
 * o usuário não visitou um schema ainda, o conteúdo dele não aparece.
 * Hint no header do resultado deixa isso claro.
 */
export function SidebarSearchResults({ query, onResultClicked }: Props) {
  const connections = useConnections((s) => s.connections);
  const activeSet = useConnections((s) => s.active);
  const caches = useSchemaCache((s) => s.caches);
  const savedQueriesCache = useSavedQueries((s) => s.cache);
  const newTab = useTabs((s) => s.open);
  const openOrFocus = useTabs((s) => s.openOrFocus);

  const q = query.trim().toLowerCase();

  const results = useMemo<SearchResult[]>(() => {
    if (!q) return [];
    const out: SearchResult[] = [];
    for (const conn of connections) {
      if (!activeSet.has(conn.id)) continue;
      const cache = caches[conn.id];

      // Schemas.
      const schemas = cache?.schemas ?? [];
      for (const s of schemas) {
        if (includesCI(q, s.name)) {
          out.push({
            key: `s:${conn.id}:${s.name}`,
            kind: "schema",
            connId: conn.id,
            connName: conn.name,
            connColor: conn.color,
            schema: s.name,
            label: s.name,
          });
        }
      }

      // Tables / Views — só pra schemas já carregados no cache.
      const tablesBySchema = cache?.tables ?? {};
      for (const [schema, tables] of Object.entries(tablesBySchema)) {
        for (const t of tables) {
          if (includesCI(q, t.name)) {
            const isView =
              t.kind === "view" || t.kind === "materialized_view";
            out.push({
              key: `t:${conn.id}:${schema}:${t.name}`,
              kind: isView ? "view" : "table",
              connId: conn.id,
              connName: conn.name,
              connColor: conn.color,
              schema,
              label: t.name,
            });
          }
        }
      }

      // Saved queries (por conexão, pode cair em qualquer schema).
      const sq = savedQueriesCache[conn.id] ?? [];
      for (const q2 of sq) {
        if (
          includesCI(q, q2.name) ||
          includesCI(q, q2.sql)
        ) {
          out.push({
            key: `q:${q2.id}`,
            kind: "saved_query",
            connId: conn.id,
            connName: conn.name,
            connColor: conn.color,
            schema: q2.schema ?? "",
            label: q2.name,
            hint: q2.sql.replace(/\s+/g, " ").slice(0, 100),
            savedQueryId: q2.id,
            savedQuerySql: q2.sql,
          });
        }
      }
    }
    // Ordena: schema > table > view > saved_query; depois alfabético.
    const orderKey: Record<ResultKind, number> = {
      schema: 0,
      table: 1,
      view: 2,
      saved_query: 3,
    };
    out.sort((a, b) => {
      const d = orderKey[a.kind] - orderKey[b.kind];
      if (d !== 0) return d;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
    return out;
  }, [q, connections, activeSet, caches, savedQueriesCache]);

  const handle = (r: SearchResult) => {
    const conn = connections.find((c) => c.id === r.connId);
    if (!conn) return;
    if (r.kind === "schema") {
      openOrFocus(
        (tab) =>
          tab.kind.kind === "tables-list" &&
          tab.kind.connectionId === r.connId &&
          tab.kind.schema === r.schema,
        () => ({
          label: `${r.schema} · Tabelas`,
          kind: {
            kind: "tables-list",
            connectionId: r.connId,
            schema: r.schema,
          },
          accentColor: conn.color,
        }),
      );
    } else if (r.kind === "table" || r.kind === "view") {
      newTab({
        label: r.label,
        kind: {
          kind: "table",
          connectionId: r.connId,
          schema: r.schema,
          table: r.label,
        },
        accentColor: conn.color,
      });
    } else if (r.kind === "saved_query" && r.savedQueryId) {
      openOrFocus(
        (tab) =>
          tab.kind.kind === "query" &&
          tab.kind.savedQueryId === r.savedQueryId,
        () => ({
          label: r.label,
          kind: {
            kind: "query",
            connectionId: r.connId,
            schema: r.schema || undefined,
            initialSql: r.savedQuerySql ?? "",
            savedQueryId: r.savedQueryId,
            savedQueryName: r.label,
          },
          accentColor: conn.color,
        }),
      );
    }
    onResultClicked();
  };

  if (results.length === 0) {
    return (
      <div className="mt-2 px-2 text-center text-[11px] italic text-muted-foreground">
        Nenhum resultado em conexões ativas.
        <div className="mt-1 opacity-70">
          Só busca no que já foi carregado — expanda schemas pra alimentar o cache.
        </div>
      </div>
    );
  }

  return (
    <ul className="grid gap-0.5">
      {results.map((r) => (
        <li
          key={r.key}
          className="cursor-pointer rounded-md px-1.5 py-1 hover:bg-accent/50"
          onClick={() => handle(r)}
          style={
            {
              "--conn-accent": r.connColor ?? "var(--conn-accent-default)",
            } as React.CSSProperties
          }
          title={r.hint}
        >
          <div className="flex items-center gap-1.5 text-xs">
            <ResultIcon kind={r.kind} />
            <span className="flex-1 truncate font-medium">{r.label}</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
              {r.kind === "saved_query" ? "query" : r.kind}
            </span>
          </div>
          <div className="ml-5 truncate text-[10px] text-muted-foreground">
            <span
              className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
              style={{
                backgroundColor: r.connColor ?? "var(--muted-foreground)",
              }}
            />
            {r.connName}
            {r.schema && ` / ${r.schema}`}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ResultIcon({ kind }: { kind: ResultKind }) {
  const cls = cn("h-3 w-3 shrink-0 text-muted-foreground");
  switch (kind) {
    case "schema":
      return <Database className={cls} />;
    case "table":
      return <TableIcon className={cls} />;
    case "view":
      return <FileCode2 className={cls} />;
    case "saved_query":
      return <Save className={cls} />;
  }
}
