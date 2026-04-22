import { useEffect, useState } from "react";
import { AlertTriangle, X, Trash2 } from "lucide-react";

import { useT } from "@/state/i18n";
import { cn } from "@/lib/utils";
import { useDestructive } from "@/state/destructive-confirm";

export function DestructiveConfirmDialog() {
  const t = useT();
  const pending = useDestructive((s) => s.pending);
  const resolve = useDestructive((s) => s.resolveCurrent);
  const [acknowledged, setAcknowledged] = useState(false);

  // Reset checkbox a cada novo pedido — evita "ok automático" se o
  // mesmo dialog reabre logo em seguida.
  useEffect(() => {
    setAcknowledged(false);
  }, [pending?.id]);

  // Esc cancela. Enter só funciona se o checkbox tá marcado.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(false);
      } else if (e.key === "Enter" && acknowledged) {
        e.preventDefault();
        resolve(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, acknowledged, resolve]);

  if (!pending) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
      onClick={() => resolve(false)}
    >
      <div
        className="flex w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-destructive/40 bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h2 className="flex-1 text-sm font-semibold text-destructive">
            {pending.title}
          </h2>
        </header>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="text-xs text-muted-foreground">{pending.description}</p>

          {pending.items.length > 0 && (
            <ul className="mt-3 max-h-[28vh] overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs">
              {pending.items.map((it) => (
                <li
                  key={it}
                  className="truncate px-1 py-0.5"
                  title={it}
                >
                  {it}
                </li>
              ))}
            </ul>
          )}

          <label
            className={cn(
              "mt-4 flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
              acknowledged
                ? "border-destructive/50 bg-destructive/5"
                : "border-border hover:bg-accent/50",
            )}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-destructive"
              autoFocus
            />
            <span className="flex-1 leading-relaxed">
              {pending.checkboxLabel}
            </span>
          </label>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-3">
          <button
            type="button"
            onClick={() => resolve(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" />
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!acknowledged}
            onClick={() => resolve(true)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              acknowledged
                ? "bg-destructive text-destructive-foreground hover:opacity-90"
                : "cursor-not-allowed bg-muted text-muted-foreground",
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {pending.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
