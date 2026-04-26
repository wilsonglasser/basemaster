import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { useDangerousQuery } from "@/state/dangerous-query";
import { useT } from "@/state/i18n";

export function DangerousQueryDialog() {
  const t = useT();
  const pending = useDangerousQuery((s) => s.pending);
  const resolve = useDangerousQuery((s) => s.resolvePending);
  const [dontAsk, setDontAsk] = useState(false);

  // Reset the checkbox when a new prompt arrives.
  useEffect(() => {
    if (pending) setDontAsk(false);
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(false, false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, resolve]);

  if (!pending) return null;

  const many = pending.statements.length > 1;

  return (
    <div
      className="fixed inset-0 z-[68] flex items-center justify-center bg-black/50"
      onClick={() => resolve(false, false)}
    >
      <div
        className="flex w-[540px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h2 className="flex-1 text-sm font-semibold text-destructive">
            {many
              ? t("dangerousQuery.titleMany", {
                  count: pending.statements.length,
                })
              : t("dangerousQuery.titleOne")}
          </h2>
          <button
            type="button"
            onClick={() => resolve(false, false)}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("common.cancel")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="max-h-[55vh] space-y-3 overflow-y-auto px-4 py-3">
          <p className="text-xs text-foreground/90">
            {t("dangerousQuery.body")}
          </p>

          <ul className="space-y-2">
            {pending.statements.map((s, i) => (
              <li
                key={i}
                className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2"
              >
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-destructive">
                  <span>{s.kind}</span>
                  {s.table && (
                    <>
                      <span className="text-destructive/50">·</span>
                      <span className="font-mono normal-case tracking-normal">
                        {s.table}
                      </span>
                    </>
                  )}
                </div>
                <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/90">
                  {s.sql}
                </pre>
              </li>
            ))}
          </ul>

          <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(e) => setDontAsk(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-conn-accent"
            />
            {t("dangerousQuery.dontAskAgain")}
          </label>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-2.5">
          <button
            type="button"
            onClick={() => resolve(false, false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => resolve(true, dontAsk)}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
          >
            {t("dangerousQuery.runAnyway")}
          </button>
        </footer>
      </div>
    </div>
  );
}
