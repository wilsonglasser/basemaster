import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Container, Plug, Upload } from "lucide-react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useDockerDiscover } from "@/state/docker-discover";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

const REPO_URL = "https://github.com/wilsonglasser/basemaster";

export function Welcome() {
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const refreshConnections = useConnections((s) => s.refresh);
  const setDockerOpen = useDockerDiscover((s) => s.setOpen);
  const t = useT();

  const newConnection = () =>
    openOrFocus(
      (tab) => tab.kind.kind === "new-connection",
      () => ({
        label: t("sidebar.newConnection"),
        kind: { kind: "new-connection" },
      }),
    );

  const importConnections = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [
          { name: "Conexões", extensions: ["bmconn", "json", "ncx", "xml"] },
        ],
      });
      if (!path || Array.isArray(path)) return;
      const payload = await ipc.portability.importParse(path);
      const count = payload.connections.length;
      if (count === 0) {
        alert("Arquivo não contém conexões.");
        return;
      }
      const ok = window.confirm(
        `Importar ${count} conexão(ões)${
          payload.folders.length ? ` + ${payload.folders.length} pasta(s)` : ""
        }?`,
      );
      if (!ok) return;
      const applied = await ipc.portability.importApply(payload);
      alert(`${applied} conexão(ões) importada(s).`);
      await refreshConnections();
    } catch (e) {
      alert(`Falha ao importar: ${e}`);
    }
  };

  const dockerDiscover = () => setDockerOpen(true);

  const openGithub = () => {
    void openUrl(REPO_URL).catch(() => window.open(REPO_URL, "_blank"));
  };

  return (
    <div className="grid h-full place-items-center px-8">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex items-center gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-conn-accent text-lg font-semibold text-conn-accent-foreground shadow-md">
            BM
          </div>
          <div>
            <div className="text-3xl font-semibold tracking-tight">
              {t("sidebar.appName")}
            </div>
            <div className="text-sm text-muted-foreground">
              {t("welcome.header")}
            </div>
          </div>
        </div>

        <div className="grid gap-2">
          <ActionRow
            icon={<Plug className="h-4 w-4" />}
            title={t("welcome.newConnTitle")}
            hint={t("welcome.newConnHint")}
            onClick={newConnection}
            primary
          />
          <ActionRow
            icon={<Upload className="h-4 w-4" />}
            title={t("welcome.importTitle")}
            hint={t("welcome.importHint")}
            onClick={() => void importConnections()}
          />
          <ActionRow
            icon={<Container className="h-4 w-4" />}
            title={t("welcome.dockerTitle")}
            hint={t("welcome.dockerHint")}
            onClick={dockerDiscover}
          />
          <ActionRow
            icon={<GithubMark className="h-4 w-4" />}
            title={t("welcome.githubTitle")}
            hint={t("welcome.githubHint")}
            onClick={openGithub}
          />
        </div>
      </div>
    </div>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function ActionRow({
  icon,
  title,
  hint,
  onClick,
  primary,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors",
        disabled && "cursor-not-allowed opacity-50",
        !disabled && primary && "border-conn-accent/40 bg-conn-accent/5 hover:bg-conn-accent/10",
        !disabled && !primary && "bg-card/50 hover:bg-accent/50",
      )}
    >
      <span
        className={cn(
          "grid h-9 w-9 place-items-center rounded-md transition-colors",
          primary
            ? "bg-conn-accent text-conn-accent-foreground"
            : "bg-muted text-muted-foreground group-hover:bg-background",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
