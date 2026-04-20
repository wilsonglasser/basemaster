import { AlertTriangle, Check, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useApproval } from "@/state/ai-approval";

export function AiApprovalDialog() {
  const pending = useApproval((s) => s.pending);
  const resolve = useApproval((s) => s.resolveCurrent);

  if (!pending) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={() => resolve(false)}
    >
      <div
        className="flex w-[560px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h2 className="flex-1 text-sm font-semibold">{pending.title}</h2>
          <span className="rounded-full bg-conn-accent/15 px-2 py-0.5 text-[10px] text-conn-accent">
            agente
          </span>
        </header>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="text-xs text-muted-foreground">{pending.description}</p>

          {pending.sql && (
            <pre className="mt-3 max-h-[40vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {pending.sql}
            </pre>
          )}

          {pending.meta && Object.keys(pending.meta).length > 0 && (
            <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
              {Object.entries(pending.meta).map(([k, v]) => (
                v == null ? null : (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-mono">{String(v)}</dd>
                  </div>
                )
              ))}
            </dl>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-3">
          <button
            type="button"
            onClick={() => resolve(false)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs",
              "hover:bg-accent",
            )}
          >
            <X className="h-3.5 w-3.5" />
            Negar
          </button>
          <button
            type="button"
            onClick={() => resolve(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
          >
            <Check className="h-3.5 w-3.5" />
            Aprovar
          </button>
        </footer>
      </div>
    </div>
  );
}
