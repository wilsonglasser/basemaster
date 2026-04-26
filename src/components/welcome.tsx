import { useMemo } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRightLeft,
  Container,
  Database,
  Plug,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { DbIcon } from "@/components/ui/db-icon";
import { appAlert, appConfirm } from "@/state/app-dialog";
import type { ConnectionProfile } from "@/lib/types";
import { useConnections } from "@/state/connections";
import { useDockerDiscover } from "@/state/docker-discover";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

const REPO_URL = "https://github.com/wilsonglasser/basemaster";

export function Welcome() {
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const newTab = useTabs((s) => s.open);
  const refreshConnections = useConnections((s) => s.refresh);
  const connections = useConnections((s) => s.connections);
  const openConn = useConnections((s) => s.open);
  const setDockerOpen = useDockerDiscover((s) => s.setOpen);
  const t = useT();

  // Top 3 recently used connections (skip never-used so brand-new
  // installs don't show ghost rows).
  const recent = useMemo(() => {
    return connections
      .filter((c) => c.last_used_at != null)
      .sort((a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0))
      .slice(0, 3);
  }, [connections]);

  const openConnection = async (c: ConnectionProfile) => {
    try {
      await openConn(c.id);
      // Open the schema's table list when there's a default DB; otherwise
      // a blank query tab against the connection so the user lands
      // somewhere useful right away.
      if (c.default_database) {
        newTab({
          label: `${c.default_database} · ${t("tablesList.tabLabel")}`,
          kind: {
            kind: "tables-list",
            connectionId: c.id,
            schema: c.default_database,
          },
          accentColor: c.color,
        });
      } else {
        newTab({
          label: t("tree.newQuery"),
          kind: { kind: "query", connectionId: c.id },
          accentColor: c.color,
        });
      }
    } catch (e) {
      void appAlert(t("welcome.openConnFailed", { error: String(e) }));
    }
  };

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
          {
            name: t("welcome.filterName"),
            extensions: ["bmconn", "json", "ncx", "xml", "txt"],
          },
        ],
      });
      if (!path || Array.isArray(path)) return;
      const payload = await ipc.portability.importParse(path);
      const count = payload.connections.length;
      if (count === 0) {
        void appAlert(t("welcome.fileHasNoConnections"));
        return;
      }
      const folders = payload.folders.length
        ? t("welcome.foldersSuffix", { n: payload.folders.length })
        : "";
      const ok = await appConfirm(
        t("welcome.confirmImport", { count, folders }),
      );
      if (!ok) return;
      const applied = await ipc.portability.importApply(payload);
      void appAlert(t("welcome.imported", { count: applied }));
      await refreshConnections();
    } catch (e) {
      void appAlert(t("welcome.importFailed", { error: String(e) }));
    }
  };

  const dockerDiscover = () => setDockerOpen(true);

  const openGithub = () => {
    void openUrl(REPO_URL).catch(() => window.open(REPO_URL, "_blank"));
  };

  return (
    <div className="h-full overflow-auto px-8 py-10">
      <div className="mx-auto w-full max-w-3xl">
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

        <div className="grid gap-2 sm:grid-cols-2">
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

        {recent.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("welcome.recentTitle")}
            </h2>
            <div className="grid gap-1.5">
              {recent.map((c) => (
                <RecentRow key={c.id} conn={c} onOpen={openConnection} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-10">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("welcome.featuresTitle")}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <FeatureCard
              icon={<Database className="h-4 w-4" />}
              title={t("welcome.featureMultiEngineTitle")}
              hint={t("welcome.featureMultiEngineHint")}
            />
            <FeatureCard
              icon={<Sparkles className="h-4 w-4" />}
              title={t("welcome.featureAiTitle")}
              hint={t("welcome.featureAiHint")}
            />
            <FeatureCard
              icon={<ShieldCheck className="h-4 w-4" />}
              title={t("welcome.featureSshTitle")}
              hint={t("welcome.featureSshHint")}
            />
            <FeatureCard
              icon={<ArrowRightLeft className="h-4 w-4" />}
              title={t("welcome.featureTransferTitle")}
              hint={t("welcome.featureTransferHint")}
            />
          </div>
        </section>

        <p className="mt-10 text-center text-[11px] text-muted-foreground">
          {t("welcome.tipShortcutPrefix")}{" "}
          <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]">
            Ctrl+K
          </kbd>{" "}
          {t("welcome.tipShortcutSuffix")}
        </p>
      </div>
    </div>
  );
}

function RecentRow({
  conn,
  onOpen,
}: {
  conn: ConnectionProfile;
  onOpen: (c: ConnectionProfile) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(conn)}
      style={
        {
          "--conn-accent": conn.color ?? "var(--conn-accent-default)",
        } as React.CSSProperties
      }
      className="group flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2 text-left transition-colors hover:border-conn-accent/50 hover:bg-conn-accent/5"
    >
      <span className="grid h-7 w-7 place-items-center rounded text-conn-accent">
        <DbIcon driver={conn.driver} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{conn.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {conn.driver} · {conn.host}
          {conn.port ? `:${conn.port}` : ""}
          {conn.default_database ? ` · ${conn.default_database}` : ""}
        </span>
      </span>
      <span className="text-[10px] text-muted-foreground/70">
        {conn.last_used_at ? formatRelative(conn.last_used_at * 1000) : ""}
      </span>
    </button>
  );
}

function FeatureCard({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card/30 px-3 py-2.5">
      <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-md bg-muted text-conn-accent">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{title}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {hint}
        </div>
      </div>
    </div>
  );
}

/** Compact "2h ago", "3d ago" formatter — falls back to local date. */
function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ms).toLocaleDateString();
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
