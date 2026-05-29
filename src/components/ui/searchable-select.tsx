import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SearchableSelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Optional secondary text shown to the right (e.g., driver). */
  hint?: string;
  /** Group key. Options sharing the same key render under one heading. */
  group?: string | null;
  /** Used for filtering in addition to `label`. */
  keywords?: string[];
  disabled?: boolean;
}

interface SearchableSelectProps<V extends string = string> {
  value: V | null;
  options: SearchableSelectOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  /** Order of group headings. Groups not in this list go to the end (alpha). */
  groupOrder?: string[];
  /** Label shown for the `null`/`undefined` group bucket. Default: no heading. */
  ungroupedLabel?: string;
  /** Allow typing a value not in `options`. When set, `onChange` is called
   *  with the typed string. The dropdown shows a "Use … as new" row. */
  allowCustom?: boolean;
  /** Custom-row label builder. Receives the typed value. */
  customLabel?: (typed: string) => string;
  disabled?: boolean;
  className?: string;
  dropdownClassName?: string;
  /** Dropdown max height in px. Default 320. */
  maxHeight?: number;
  /** Default sort inside each group. "alpha" (default) or "natural"
   *  (numeric-aware: sis_2, sis_3, sis_20). */
  sort?: "alpha" | "natural" | "none";
}

export function SearchableSelect<V extends string = string>({
  value,
  options,
  onChange,
  placeholder = "(select)",
  groupOrder,
  ungroupedLabel,
  allowCustom = false,
  customLabel,
  disabled,
  className,
  dropdownClassName,
  maxHeight = 320,
  sort = "alpha",
}: SearchableSelectProps<V>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  const collator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    [],
  );

  const sortFn = useMemo(() => {
    if (sort === "none") return null;
    if (sort === "natural") {
      return (a: SearchableSelectOption<V>, b: SearchableSelectOption<V>) =>
        collator.compare(a.label, b.label);
    }
    return (a: SearchableSelectOption<V>, b: SearchableSelectOption<V>) =>
      a.label.localeCompare(b.label);
  }, [sort, collator]);

  // Group + filter + sort.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const buckets = new Map<string, SearchableSelectOption<V>[]>();
    for (const opt of options) {
      if (q) {
        const hay = [
          opt.label.toLowerCase(),
          opt.hint?.toLowerCase() ?? "",
          ...(opt.keywords?.map((k) => k.toLowerCase()) ?? []),
        ].join(" ");
        if (!hay.includes(q)) continue;
      }
      const key = opt.group ?? "";
      const arr = buckets.get(key);
      if (arr) arr.push(opt);
      else buckets.set(key, [opt]);
    }
    if (sortFn) for (const arr of buckets.values()) arr.sort(sortFn);

    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    if (groupOrder) {
      for (const g of groupOrder) {
        if (buckets.has(g)) {
          orderedKeys.push(g);
          seen.add(g);
        }
      }
    }
    // ungrouped bucket ("")
    if (buckets.has("") && !seen.has("")) {
      orderedKeys.push("");
      seen.add("");
    }
    // remaining groups alpha
    const rest = [...buckets.keys()]
      .filter((k) => !seen.has(k))
      .sort((a, b) => collator.compare(a, b));
    orderedKeys.push(...rest);

    return orderedKeys.map((key) => ({
      key,
      label: key === "" ? ungroupedLabel ?? null : key,
      items: buckets.get(key)!,
    }));
  }, [options, query, sortFn, groupOrder, ungroupedLabel, collator]);

  // Flat list of selectable items for keyboard cursor.
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const trimmedQuery = query.trim();
  const showCustomRow =
    allowCustom &&
    trimmedQuery.length > 0 &&
    !options.some((o) => o.value === trimmedQuery || o.label === trimmedQuery);

  useEffect(() => setCursor(0), [query, open]);

  const openDropdown = () => {
    if (disabled) return;
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setOpen(true);
    setQuery("");
    // Focus the search input next frame.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (v: string) => {
    onChange(v as V);
    close();
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const total = flat.length + (showCustomRow ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(total - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showCustomRow && cursor === flat.length) {
        choose(trimmedQuery);
        return;
      }
      const pick = flat[cursor];
      if (pick && !pick.disabled) choose(pick.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      triggerRef.current?.focus();
    }
  };

  const displayLabel = selected?.label ?? (allowCustom && value ? value : null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openDropdown())}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground hover:border-conn-accent/60 focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <span
          className={cn(
            "truncate text-left",
            !displayLabel && "text-muted-foreground",
          )}
        >
          {displayLabel ?? placeholder}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && rect &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onMouseDown={(e) => {
                e.preventDefault();
                close();
              }}
            />
            <div
              className={cn(
                "fixed z-[9999] flex flex-col overflow-hidden rounded-md border border-border bg-popover shadow-lg",
                dropdownClassName,
              )}
              style={{
                top: rect.bottom + 4,
                left: rect.left,
                width: Math.max(220, rect.width),
                maxHeight,
              }}
            >
              <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Search…"
                  className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-1">
                {groups.length === 0 && !showCustomRow && (
                  <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                    No matches
                  </div>
                )}
                {groups.map((g) => {
                  const startIdx = flat.indexOf(g.items[0]);
                  return (
                    <div key={g.key || "__none__"} className="mb-1 last:mb-0">
                      {g.label && (
                        <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                          {g.label}
                        </div>
                      )}
                      {g.items.map((opt, i) => {
                        const idx = startIdx + i;
                        const active = idx === cursor;
                        const isSelected = opt.value === value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            disabled={opt.disabled}
                            onMouseEnter={() => setCursor(idx)}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              if (!opt.disabled) choose(opt.value);
                            }}
                            className={cn(
                              "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs",
                              active && "bg-accent",
                              !active && "hover:bg-accent/60",
                              opt.disabled && "cursor-not-allowed opacity-50",
                            )}
                          >
                            <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                              {isSelected && (
                                <Check className="h-3 w-3 text-conn-accent" />
                              )}
                            </span>
                            <span className="flex-1 truncate">{opt.label}</span>
                            {opt.hint && (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {opt.hint}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {showCustomRow && (
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(flat.length)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(trimmedQuery);
                    }}
                    className={cn(
                      "mt-1 flex w-full items-center gap-2 rounded border border-dashed border-border px-2 py-1 text-left text-xs",
                      cursor === flat.length ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                      <ChevronDown className="h-3 w-3 -rotate-90 text-conn-accent" />
                    </span>
                    <span className="flex-1 truncate">
                      {customLabel
                        ? customLabel(trimmedQuery)
                        : `Use "${trimmedQuery}"`}
                    </span>
                  </button>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
