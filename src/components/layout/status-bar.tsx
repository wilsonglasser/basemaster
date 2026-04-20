import { Circle } from "lucide-react";

import { cn } from "@/lib/utils";
import { useActiveInfo } from "@/state/active-info";
import { useConnections } from "@/state/connections";
import { useTabs } from "@/state/tabs";

interface StatusBarProps {
  className?: string;
}

export function StatusBar({ className }: StatusBarProps) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);

  const active = tabs.find((t) => t.id === activeId);
  const connectionId =
    active && "connectionId" in active.kind
      ? active.kind.connectionId
      : undefined;

  const conn = useConnections((s) =>
    connectionId ? s.connections.find((c) => c.id === connectionId) : undefined,
  );
  const isLive = useConnections((s) =>
    connectionId ? s.active.has(connectionId) : false,
  );

  const schema =
    active?.kind.kind === "query" ? active.kind.schema : undefined;

  const live = useActiveInfo((s) => (activeId ? s.byTab[activeId] : undefined));

  return (
    <footer
      className={cn(
        "flex h-7 items-center gap-3 border-t border-border bg-card/40 px-3 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <Circle
          className={cn(
            "h-2 w-2 fill-current",
            isLive ? "text-emerald-500" : "text-muted-foreground/40",
          )}
        />
        {conn ? (
          <>
            <span className="font-medium text-foreground/80">{conn.name}</span>
            {isLive ? (
              <>
                <Sep />
                <span>
                  {conn.user}@{conn.host}:{conn.port}
                </span>
              </>
            ) : (
              <>
                <Sep />
                <span>desconectado</span>
              </>
            )}
            {schema && (
              <>
                <Sep />
                <span>{schema}</span>
              </>
            )}
          </>
        ) : (
          <span>Sem conexão ativa</span>
        )}
      </span>

      {live?.currentSql && (
        <>
          <Sep />
          <span
            className="min-w-0 max-w-[40ch] truncate font-mono"
            title={live.currentSql}
          >
            {live.currentSql.replace(/\s+/g, " ")}
          </span>
        </>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-3">
        {live?.totalRows != null && (
          <>
            <span className="tabular-nums">{live.totalRows} linhas</span>
            <Sep />
          </>
        )}
        {live?.elapsedMs != null && (
          <>
            <span className="tabular-nums">{live.elapsedMs} ms</span>
            <Sep />
          </>
        )}
        {live?.cellRow != null && live?.cellCol != null && (
          <>
            <span className="tabular-nums">
              L {live.cellRow + 1} : C {live.cellCol + 1}
            </span>
            <Sep />
          </>
        )}
        <span>UTF-8</span>
      </span>
    </footer>
  );
}

function Sep() {
  return <span className="h-3 w-px bg-border" aria-hidden />;
}
