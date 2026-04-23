import { useCallback, useMemo, useState } from "react";
import { Keyboard, X } from "lucide-react";

import { displayBinding } from "@/lib/shortcuts/match";
import { SHORTCUTS } from "@/lib/shortcuts/registry";
import { useShortcut } from "@/lib/shortcuts/use-shortcuts";
import { useShortcuts } from "@/state/shortcuts";

export function ShortcutsCheatsheet() {
  const [open, setOpen] = useState(false);

  useShortcut(
    "global.cheatsheet",
    useCallback(() => setOpen((v) => !v), []),
  );

  if (!open) return null;
  return <Modal onClose={() => setOpen(false)} />;
}

function Modal({ onClose }: { onClose: () => void }) {
  const resolve = useShortcuts((s) => s.resolve);
  useShortcuts((s) => s.overrides); // force re-render on changes

  const grouped = useMemo(() => {
    const out: Record<
      string,
      Array<{ label: string; binding: string | null }>
    > = {};
    for (const a of SHORTCUTS) {
      (out[a.category] ??= []).push({
        label: a.label,
        binding: resolve(a.id),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="flex max-h-[80vh] w-[680px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Keyboard className="h-4 w-4 text-conn-accent" />
          <h2 className="flex-1 text-sm font-semibold">Atalhos de teclado</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            {Object.entries(grouped).map(([cat, items]) => (
              <section key={cat}>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {cat}
                </div>
                <div className="grid gap-1">
                  {items.map((it) => (
                    <div
                      key={it.label}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate">{it.label}</span>
                      <kbd className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                        {displayBinding(it.binding)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
