import { Database, FileText, Plug } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

export function Welcome() {
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const t = useT();

  const newConnection = () =>
    openOrFocus(
      (tab) => tab.kind.kind === "new-connection",
      () => ({
        label: t("sidebar.newConnection"),
        kind: { kind: "new-connection" },
      }),
    );

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
            icon={<FileText className="h-4 w-4" />}
            title={t("welcome.importTitle")}
            hint={t("welcome.importHint")}
            disabled
          />
          <ActionRow
            icon={<Database className="h-4 w-4" />}
            title={t("welcome.docsTitle")}
            hint={t("welcome.docsHint")}
            disabled
          />
        </div>
      </div>
    </div>
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
