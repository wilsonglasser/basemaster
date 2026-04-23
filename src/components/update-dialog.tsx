import { AlertTriangle, ArrowRight, Download, Loader2, X } from "lucide-react";

import { useT } from "@/state/i18n";
import { useUpdater } from "@/state/updater";
import { cn } from "@/lib/utils";

export function UpdateDialog() {
  const t = useT();
  const status = useUpdater((s) => s.status);
  const ignore = useUpdater((s) => s.ignoreCurrent);
  const dismiss = useUpdater((s) => s.dismiss);
  const install = useUpdater((s) => s.downloadAndInstall);

  if (status.kind === "idle" || status.kind === "checking") return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={() => {
        // Only closes on click-outside when not downloading/installing.
        if (status.kind === "available" || status.kind === "error") dismiss();
      }}
    >
      <div
        className="flex w-[560px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {status.kind === "available" && (
          <Available
            t={t}
            current={status.update.currentVersion}
            next={status.update.version}
            body={status.update.body ?? null}
            onUpdate={install}
            onSkip={ignore}
            onLater={dismiss}
          />
        )}

        {status.kind === "downloading" && (
          <Downloading
            t={t}
            current={status.update.currentVersion}
            next={status.update.version}
            downloaded={status.downloaded}
            total={status.total}
          />
        )}

        {status.kind === "ready" && (
          <Installing t={t} />
        )}

        {status.kind === "error" && (
          <ErrorBox t={t} message={status.message} onClose={dismiss} />
        )}
      </div>
    </div>
  );
}

function Available({
  t,
  current,
  next,
  body,
  onUpdate,
  onSkip,
  onLater,
}: {
  t: ReturnType<typeof useT>;
  current: string;
  next: string;
  body: string | null;
  onUpdate: () => void;
  onSkip: () => void;
  onLater: () => void;
}) {
  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Download className="h-4 w-4 text-conn-accent" />
        <h2 className="flex-1 text-sm font-semibold">{t("updater.title")}</h2>
      </header>

      <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
        <p className="text-sm">{t("updater.bodyHeader")}</p>
        <p className="mt-2 inline-flex items-center gap-2 rounded-md bg-muted px-2 py-1 font-mono text-xs">
          <span className="text-muted-foreground">v{current}</span>
          <ArrowRight className="h-3 w-3" />
          <span className="font-semibold">v{next}</span>
        </p>

        {body && body.trim().length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              {t("updater.notesHeading")}
            </summary>
            <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
              {body}
            </pre>
          </details>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-3">
        <button
          type="button"
          onClick={onSkip}
          className={cn(
            "inline-flex items-center rounded-md px-3 py-1.5 text-xs text-muted-foreground",
            "hover:bg-accent hover:text-foreground",
          )}
        >
          {t("updater.skipBtn")}
        </button>
        <button
          type="button"
          onClick={onLater}
          className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {t("updater.laterBtn")}
        </button>
        <button
          type="button"
          onClick={onUpdate}
          className="inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
        >
          <Download className="h-3.5 w-3.5" />
          {t("updater.updateBtn")}
        </button>
      </footer>
    </>
  );
}

function Downloading({
  t,
  current,
  next,
  downloaded,
  total,
}: {
  t: ReturnType<typeof useT>;
  current: string;
  next: string;
  downloaded: number;
  total: number | null;
}) {
  const pct = total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;
  const mb = (downloaded / 1024 / 1024).toFixed(1);
  const totalMb = total ? (total / 1024 / 1024).toFixed(1) : null;

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-conn-accent" />
        <h2 className="flex-1 text-sm font-semibold">{t("updater.downloading")}</h2>
      </header>

      <div className="px-4 py-4">
        <p className="mb-2 font-mono text-xs text-muted-foreground">
          v{current} → v{next}
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full bg-conn-accent transition-[width]",
              pct == null && "w-1/3 animate-pulse",
            )}
            style={pct != null ? { width: `${pct}%` } : undefined}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {totalMb
            ? t("updater.downloadingProgress", { mb, totalMb })
            : t("updater.downloadingIndeterminate", { mb })}
        </p>
      </div>
    </>
  );
}

function Installing({ t }: { t: ReturnType<typeof useT> }) {
  return (
    <div className="flex items-center gap-3 px-4 py-6">
      <Loader2 className="h-5 w-5 animate-spin text-conn-accent" />
      <p className="text-sm">{t("updater.installing")}</p>
    </div>
  );
}

function ErrorBox({
  t,
  message,
  onClose,
}: {
  t: ReturnType<typeof useT>;
  message: string;
  onClose: () => void;
}) {
  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <h2 className="flex-1 text-sm font-semibold">{t("updater.errorTitle")}</h2>
      </header>
      <div className="px-4 py-4">
        <pre className="max-h-[40vh] overflow-auto rounded-md border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs leading-relaxed text-destructive">
          {message}
        </pre>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
          {t("updater.errorDismiss")}
        </button>
      </footer>
    </>
  );
}
