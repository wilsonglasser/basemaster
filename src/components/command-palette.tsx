import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  FileSpreadsheet,
  FileText,
  Keyboard,
  Plug,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Table as TableIcon,
} from "lucide-react";

import { displayBinding } from "@/lib/shortcuts/match";
import { SHORTCUTS } from "@/lib/shortcuts/registry";
import { useShortcut } from "@/lib/shortcuts/use-shortcuts";
import { cn } from "@/lib/utils";
import { useAiAgent } from "@/state/ai-agent";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";
import { useShortcuts } from "@/state/shortcuts";
import { useTabs } from "@/state/tabs";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  kbd?: string | null;
  icon: React.ReactNode;
  run: () => void;
  /** Relevance score used when sorting — higher comes first. */
  weight?: number;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useShortcut(
    "global.palette",
    useCallback(() => setOpen((v) => !v), []),
  );

  if (!open) return null;
  return <Palette onClose={() => setOpen(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useCommands();
  const filtered = useFilter(items, q);

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${cursor}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (idx: number) => {
    const it = filtered[idx];
    if (!it) return;
    onClose();
    // Give a tick for the modal to close before the action (avoids focus returning wrong).
    setTimeout(() => it.run(), 0);
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(filtered.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(cursor);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={t("commandPalette.placeholder")}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              {t("commandPalette.noResults", { query: q })}
            </div>
          ) : (
            filtered.map((it, i) => (
              <button
                key={it.id}
                data-idx={i}
                type="button"
                onClick={() => pick(i)}
                onMouseEnter={() => setCursor(i)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm transition-colors",
                  i === cursor ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center text-muted-foreground">
                  {it.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {it.hint}
                  </span>
                )}
                {it.kbd && (
                  <kbd className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]">
                    {it.kbd}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function useCommands(): CommandItem[] {
  const t = useT();
  const connections = useConnections((s) => s.connections);
  const caches = useSchemaCache((s) => s.caches);
  const tabs = useTabs((s) => s.tabs);
  const resolve = useShortcuts((s) => s.resolve);

  return useMemo(() => {
    const out: CommandItem[] = [];

    // Global shortcuts/actions — with label and binding as hint.
    for (const a of SHORTCUTS) {
      if (a.scope !== "global") continue;
      const kbd = resolve(a.id);
      out.push({
        id: `action:${a.id}`,
        label: a.label,
        hint: a.category,
        kbd: displayBinding(kbd),
        icon: <Keyboard className="h-3.5 w-3.5" />,
        run: () => dispatchShortcutAction(a.id),
        weight: 10,
      });
    }

    // Connections — open/focus
    for (const c of connections) {
      out.push({
        id: `conn:${c.id}`,
        label: t("commandPalette.openConnection", { name: c.name }),
        hint: `${c.driver} @ ${c.host}`,
        icon: <Plug className="h-3.5 w-3.5" />,
        run: async () => {
          await useConnections.getState().open(c.id);
        },
        weight: 20,
      });
      out.push({
        id: `procs:${c.id}`,
        label: t("commandPalette.processes", { name: c.name }),
        hint: t("commandPalette.processesHint"),
        icon: <Database className="h-3.5 w-3.5" />,
        run: () => {
          useTabs.getState().openOrFocus(
            (tab) =>
              tab.kind.kind === "processes" &&
              tab.kind.connectionId === c.id,
            () => ({
              label: t("commandPalette.processesLabel", { name: c.name }),
              kind: { kind: "processes", connectionId: c.id },
              accentColor: c.color ?? null,
            }),
          );
        },
        weight: 10,
      });
    }

    // Cached schemas + tables
    for (const c of connections) {
      const cache = caches[c.id];
      if (!cache) continue;
      for (const s of cache.schemas ?? []) {
        const tables = cache.tables?.[s.name] ?? [];
        for (const tb of tables) {
          out.push({
            id: `tbl:${c.id}:${s.name}:${tb.name}`,
            label: `${s.name}.${tb.name}`,
            hint: c.name,
            icon: <TableIcon className="h-3.5 w-3.5" />,
            run: () => {
              useTabs.getState().openOrFocus(
                (tab) =>
                  tab.kind.kind === "table" &&
                  tab.kind.connectionId === c.id &&
                  tab.kind.schema === s.name &&
                  tab.kind.table === tb.name,
                () => ({
                  label: tb.name,
                  kind: {
                    kind: "table",
                    connectionId: c.id,
                    schema: s.name,
                    table: tb.name,
                  },
                  accentColor: c.color ?? null,
                }),
              );
            },
            weight: 30,
          });
        }
      }
    }

    // Open tabs
    for (const tab of tabs) {
      out.push({
        id: `tab:${tab.id}`,
        label: t("commandPalette.focusTab", { label: tab.label }),
        hint: tab.kind.kind,
        icon: <FileText className="h-3.5 w-3.5" />,
        run: () => useTabs.getState().setActive(tab.id),
        weight: 5,
      });
    }

    // Useful shortcuts
    out.push({
      id: "aux:settings",
      label: t("commandPalette.openSettings"),
      icon: <SettingsIcon className="h-3.5 w-3.5" />,
      run: () =>
        useTabs
          .getState()
          .openOrFocus(
            (tab) => tab.kind.kind === "settings",
            () => ({
              label: t("commandPalette.settingsLabel"),
              kind: { kind: "settings" },
            }),
          ),
      weight: 15,
    });
    out.push({
      id: "aux:ai",
      label: t("commandPalette.toggleAi"),
      icon: <Sparkles className="h-3.5 w-3.5" />,
      run: () => useAiAgent.getState().togglePanel(),
      weight: 15,
    });
    out.push({
      id: "aux:import",
      label: t("commandPalette.importData"),
      icon: <FileSpreadsheet className="h-3.5 w-3.5" />,
      run: () =>
        useTabs
          .getState()
          .open({
            label: t("commandPalette.dataImportLabel"),
            kind: { kind: "data-import" },
          }),
      weight: 15,
    });
    out.push({
      id: "aux:newconn",
      label: t("commandPalette.newConnection"),
      icon: <Database className="h-3.5 w-3.5" />,
      run: () =>
        useTabs
          .getState()
          .openOrFocus(
            (tab) => tab.kind.kind === "new-connection",
            () => ({
              label: t("commandPalette.newConnectionLabel"),
              kind: { kind: "new-connection" },
            }),
          ),
      weight: 15,
    });

    return out;
  }, [connections, caches, tabs, resolve, t]);
}

function dispatchShortcutAction(_id: string) {
  // For keyboard actions with scope="global", the handler is wired via
  // useShortcut and responds to a synthetic KeyboardEvent. Since we have
  // the actionId directly, the simplest path is to resolve the current
  // binding and dispatch a KeyboardEvent.
  //
  // Future alternative: have `useShortcut` also export a direct
  // dispatch(actionId). For now, fall back to the binding.
  const binding = useShortcuts.getState().resolve(_id);
  if (!binding) return;
  // Build a coherent KeyboardEvent.
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const ev = new KeyboardEvent("keydown", {
    key: key.length === 1 ? key.toLowerCase() : key,
    ctrlKey: mods.has("mod") || mods.has("ctrl"),
    metaKey: mods.has("meta"),
    altKey: mods.has("alt"),
    shiftKey: mods.has("shift"),
    bubbles: true,
  });
  document.dispatchEvent(ev);
}

/** Fuzzy-ish: score sums word hits + prefix + weight. */
function useFilter(items: CommandItem[], q: string): CommandItem[] {
  return useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      return [...items].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    }
    const terms = query.split(/\s+/).filter(Boolean);
    const scored: Array<{ item: CommandItem; score: number }> = [];
    for (const it of items) {
      const hay = `${it.label} ${it.hint ?? ""}`.toLowerCase();
      let score = 0;
      let matchedAll = true;
      for (const t of terms) {
        const idx = hay.indexOf(t);
        if (idx < 0) {
          matchedAll = false;
          break;
        }
        score += 10 - Math.min(9, idx); // position bonus
        if (hay.startsWith(t)) score += 5;
      }
      if (!matchedAll) continue;
      score += (it.weight ?? 0) / 2;
      scored.push({ item: it, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map((s) => s.item);
  }, [items, q]);
}
