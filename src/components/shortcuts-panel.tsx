import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";

import { displayBinding, eventToBinding } from "@/lib/shortcuts/match";
import { SHORTCUTS } from "@/lib/shortcuts/registry";
import type { ShortcutAction } from "@/lib/shortcuts/types";
import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";
import { useShortcuts } from "@/state/shortcuts";

export function ShortcutsPanel() {
  const resolve = useShortcuts((s) => s.resolve);
  const setBinding = useShortcuts((s) => s.setBinding);
  const resetBinding = useShortcuts((s) => s.resetBinding);
  const resetAll = useShortcuts((s) => s.resetAll);

  // Re-render when overrides change.
  useShortcuts((s) => s.overrides);

  const grouped = useMemo(() => {
    const out: Record<string, ShortcutAction[]> = {};
    for (const a of SHORTCUTS) {
      (out[a.category] ??= []).push(a);
    }
    return out;
  }, []);

  const conflicts = useMemo(() => {
    // Group by (binding, scope) — different scopes do NOT conflict
    // (editor keymap doesn't intercept global shortcuts and vice-versa).
    const map = new Map<string, string[]>();
    for (const a of SHORTCUTS) {
      const b = resolve(a.id);
      if (!b) continue;
      const key = `${a.scope}::${b}`;
      (map.get(key) ?? map.set(key, []).get(key))!.push(a.id);
    }
    const conflictIds = new Set<string>();
    for (const [, ids] of map) {
      if (ids.length > 1) ids.forEach((id) => conflictIds.add(id));
    }
    return conflictIds;
  }, [resolve]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Clique em um atalho pra rebind. Esc cancela · Backspace limpa.
        </p>
        <button
          type="button"
          onClick={resetAll}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
          title="Resetar todos pros defaults"
        >
          <RotateCcw className="h-3 w-3" />
          Resetar todos
        </button>
      </div>

      {Object.entries(grouped).map(([cat, actions]) => (
        <section key={cat}>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {cat}
          </div>
          <div className="grid gap-0.5">
            {actions.map((a) => (
              <ShortcutRow
                key={a.id}
                action={a}
                binding={resolve(a.id)}
                conflict={conflicts.has(a.id)}
                onChange={(b) => setBinding(a.id, b)}
                onReset={() => resetBinding(a.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ShortcutRow({
  action,
  binding,
  conflict,
  onChange,
  onReset,
}: {
  action: ShortcutAction;
  binding: string | null;
  conflict: boolean;
  onChange: (b: string | null) => void;
  onReset: () => void;
}) {
  const t = useT();
  const [capturing, setCapturing] = useState(false);

  const onCaptureKey = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Esc cancels, Backspace clears.
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      onChange(null);
      setCapturing(false);
      return;
    }
    const b = eventToBinding(e.nativeEvent);
    if (!b) return;
    // Must have at least one modifier (avoids binding just a letter).
    const hasMod = /(Mod|Ctrl|Alt|Meta)\+/.test(b);
    const isFKey = /^F\d+$/.test(b);
    if (!hasMod && !isFKey) return;
    onChange(b);
    setCapturing(false);
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-background/50 px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{action.label}</div>
        {action.description && (
          <div className="truncate text-[11px] text-muted-foreground">
            {action.description}
          </div>
        )}
      </div>
      {conflict && (
        <span
          className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-600 dark:text-amber-400"
          title={t("shortcutsPanel.conflictTitle")}
        >
          conflito
        </span>
      )}
      <button
        type="button"
        onClick={() => setCapturing(true)}
        onKeyDown={capturing ? onCaptureKey : undefined}
        onBlur={() => setCapturing(false)}
        className={cn(
          "min-w-[90px] rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
          capturing
            ? "border-conn-accent bg-conn-accent/10 text-conn-accent"
            : conflict
              ? "border-amber-500/40 bg-amber-500/5"
              : "border-border bg-muted/30 hover:border-conn-accent",
        )}
      >
        {capturing
          ? "aperte as teclas…"
          : binding
            ? displayBinding(binding)
            : "—"}
      </button>
      <button
        type="button"
        onClick={onReset}
        className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Resetar default"
      >
        <RotateCcw className="h-3 w-3" />
      </button>
    </div>
  );
}
