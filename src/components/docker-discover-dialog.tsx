import { useEffect, useState } from "react";
import {
  Container,
  Loader2,
  RefreshCw,
  X,
  Check as CheckIcon,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { DockerCandidate } from "@/lib/types";
import { useConnections } from "@/state/connections";
import { useDockerDiscover } from "@/state/docker-discover";
import { useTabs } from "@/state/tabs";

export function DockerDiscoverDialog() {
  const open = useDockerDiscover((s) => s.open);
  const setOpen = useDockerDiscover((s) => s.setOpen);
  if (!open) return null;
  return <Dialog onClose={() => setOpen(false)} />;
}

function Dialog({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<DockerCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createdIds, setCreatedIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await ipc.docker.discover();
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createConnection = async (c: DockerCandidate) => {
    setBusy(c.id);
    try {
      await useConnections.getState().refresh();
      const profile = await ipc.connections.create(
        {
          name: c.container_name,
          driver: c.driver,
          host: c.host,
          port: c.port,
          user: c.user ?? "root",
          default_database: c.default_database,
          tls: "disabled",
        },
        c.password,
      );
      await useConnections.getState().refresh();
      setCreatedIds((prev) => new Set(prev).add(c.id));
      // Abre a conexão em background pra já aparecer expandida na árvore.
      void useConnections.getState().open(profile.id).catch(() => void 0);
    } catch (e) {
      alert(
        `Falha ao criar conexão: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setBusy(null);
    }
  };

  const openInForm = (c: DockerCandidate) => {
    useTabs.getState().open({
      label: `Nova conexão — ${c.container_name}`,
      kind: { kind: "new-connection" },
    });
    onClose();
    // TODO: futuro — pré-preencher via state. Por ora só abre o form.
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[640px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Container className="h-4 w-4 text-conn-accent" />
          <h2 className="flex-1 text-sm font-semibold">
            Containers Docker detectados
          </h2>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            title="Recarregar"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Fechar"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && items.length === 0 ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              procurando containers…
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              <div className="font-medium">Não foi possível consultar o Docker:</div>
              <div className="mt-1 whitespace-pre-wrap font-mono">{error}</div>
              <div className="mt-2 text-muted-foreground">
                Verifique se o Docker Desktop está rodando, ou se o container
                está dentro do WSL e o integration habilitado.
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="grid h-32 place-items-center text-sm text-muted-foreground">
              Nenhum container MySQL/MariaDB/Postgres com portas expostas.
            </div>
          ) : (
            <ul className="grid gap-2">
              {items.map((c) => (
                <li key={c.id}>
                  <CandidateRow
                    c={c}
                    created={createdIds.has(c.id)}
                    busy={busy === c.id}
                    onCreate={() => void createConnection(c)}
                    onOpenInForm={() => openInForm(c)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CandidateRow({
  c,
  created,
  busy,
  onCreate,
  onOpenInForm: _onOpenInForm,
}: {
  c: DockerCandidate;
  created: boolean;
  busy: boolean;
  onCreate: () => void;
  onOpenInForm: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-border bg-background/50 p-3",
        !c.running && "opacity-70",
      )}
    >
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted/60 text-muted-foreground">
        <Container className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {c.container_name}
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px]",
              c.running
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-muted text-muted-foreground",
            )}
          >
            {c.running ? "rodando" : "parado"}
          </span>
          {c.via_wsl && (
            <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
              wsl
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-mono">{c.image}</span>
          <span>·</span>
          <span>{c.driver}</span>
          <span>·</span>
          <span className="font-mono">
            {c.host}:{c.port}
          </span>
          {c.user && <span>· user={c.user}</span>}
          {c.default_database && <span>· db={c.default_database}</span>}
          {!c.password && (
            <span className="text-amber-600 dark:text-amber-400">
              · sem senha detectada
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        disabled={busy || created}
        onClick={onCreate}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-60",
          created
            ? "bg-green-500/10 text-green-600 dark:text-green-400"
            : "bg-conn-accent text-conn-accent-foreground hover:opacity-90",
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : created ? (
          <>
            <CheckIcon className="h-3.5 w-3.5" />
            criada
          </>
        ) : (
          "Criar conexão"
        )}
      </button>
    </div>
  );
}
