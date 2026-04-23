import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/** Global coordinator: only one context menu open at a time. When one
 *  asks to open, closes the previous one. */
type CloseFn = () => void;
const openMenus = new Set<CloseFn>();
function registerOpen(close: CloseFn) {
  // Close all others already open BEFORE joining the set.
  for (const other of [...openMenus]) {
    if (other !== close) other();
  }
  openMenus.add(close);
}
function unregisterOpen(close: CloseFn) {
  openMenus.delete(close);
}

export interface ContextItem {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
  shortcut?: string;
}

export interface ContextSeparator {
  separator: true;
}

export interface ContextSubmenu {
  submenu: true;
  icon?: ReactNode;
  label: string;
  items: ContextEntry[];
  disabled?: boolean;
}

export type ContextEntry = ContextItem | ContextSeparator | ContextSubmenu;

interface OpenState {
  x: number;
  y: number;
}

/**
 * Minimalist hook for a context menu (right-click).
 *
 *   const menu = useContextMenu([{ label: 'Edit', onClick: ... }, ...]);
 *   <div onContextMenu={menu.openAt}>...</div>
 *   {menu.element}
 */
export function useContextMenu(items: ContextEntry[]) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const closeRef = useRef<CloseFn>(() => setOpen(null));

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    closeRef.current = close;
    registerOpen(close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Wait for the next tick so we don't close on the same event that opened.
    const t = setTimeout(() => {
      document.addEventListener("click", close);
      document.addEventListener("contextmenu", close);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("keydown", onKey);
      unregisterOpen(close);
    };
  }, [open]);

  const openAt = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openAtPos(e.clientX, e.clientY);
  };

  const openAtPos = (clientX: number, clientY: number) => {
    const x = Math.min(clientX, window.innerWidth - 220);
    const y = Math.min(clientY, window.innerHeight - items.length * 32 - 16);
    setOpen({ x, y });
  };

  const close = () => setOpen(null);

  // Portal to document.body — essential to escape parent stacking
  // contexts (e.g., CodeMirror, panels with overflow, etc). Without the
  // portal, the menu can look clickable but clicks fall through to the
  // content underneath when the parent creates its own stacking context.
  const menuInner = open ? (
    <MenuPanel x={open.x} y={open.y} items={items} onClose={close} />
  ) : null;

  const element =
    menuInner && typeof document !== "undefined"
      ? createPortal(menuInner, document.body)
      : menuInner;

  return { openAt, openAtPos, element, close };
}

/** Renders a menu panel. Recursive for submenus — each submenu opens
 *  on hover of the "submenu" item and positions to the right of the parent. */
function MenuPanel({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextEntry[];
  onClose: () => void;
}) {
  const [openSubIdx, setOpenSubIdx] = useState<number | null>(null);
  const [subPos, setSubPos] = useState<{ x: number; y: number } | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [adjusted, setAdjusted] = useState<{ x: number; y: number }>({ x, y });

  // Measures the panel post-render and flips/shifts it into the viewport.
  // Handles both: (a) menu opened on a button near the right edge — the
  // right edge overflows the viewport, so we align the right edge with
  // the click's X (opens to the left); (b) submenu that doesn't fit to
  // the right, same handling.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (x + rect.width > vw - 4) nx = Math.max(4, x - rect.width);
    if (y + rect.height > vh - 4) ny = Math.max(4, vh - rect.height - 4);
    if (nx !== adjusted.x || ny !== adjusted.y) setAdjusted({ x: nx, y: ny });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, items.length]);

  const scheduleClose = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setOpenSubIdx(null);
      setSubPos(null);
    }, 200);
  };
  const cancelClose = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  return (
    <div
      ref={panelRef}
      role="menu"
      className={cn(
        "fixed z-[9999] min-w-[200px] rounded-md border border-border py-1 shadow-lg",
        "bg-popover text-popover-foreground",
      )}
      style={{ top: adjusted.y, left: adjusted.x }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if ("separator" in entry) {
          return <div key={i} className="my-1 h-px bg-border" />;
        }
        if ("submenu" in entry) {
          const active = openSubIdx === i;
          return (
            <button
              key={i}
              type="button"
              disabled={entry.disabled}
              onMouseEnter={(e) => {
                cancelClose();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setOpenSubIdx(i);
                setSubPos({
                  x: Math.min(rect.right - 4, window.innerWidth - 220),
                  y: rect.top,
                });
              }}
              onMouseLeave={scheduleClose}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors",
                entry.disabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-accent hover:text-accent-foreground",
                active && "bg-accent text-accent-foreground",
              )}
            >
              {entry.icon && (
                <span className="grid h-4 w-4 place-items-center text-muted-foreground">
                  {entry.icon}
                </span>
              )}
              <span className="flex-1 truncate">{entry.label}</span>
              <span className="text-muted-foreground">›</span>
            </button>
          );
        }
        return (
          <button
            key={i}
            type="button"
            disabled={entry.disabled}
            onClick={() => {
              entry.onClick();
              onClose();
            }}
            onMouseEnter={() => setOpenSubIdx(null)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm",
              "transition-colors",
              !entry.disabled && entry.variant !== "destructive" &&
                "hover:bg-accent hover:text-accent-foreground",
              !entry.disabled && entry.variant === "destructive" &&
                "text-destructive hover:bg-destructive/10",
              entry.disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {entry.icon && (
              <span className="grid h-4 w-4 place-items-center text-muted-foreground">
                {entry.icon}
              </span>
            )}
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.shortcut && (
              <kbd className="ml-2 text-[10px] tracking-wider text-muted-foreground">
                {entry.shortcut}
              </kbd>
            )}
          </button>
        );
      })}
      {openSubIdx !== null &&
        subPos &&
        (() => {
          const entry = items[openSubIdx];
          if (!entry || !("submenu" in entry)) return null;
          return (
            <div
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              <MenuPanel
                x={subPos.x}
                y={subPos.y}
                items={entry.items}
                onClose={onClose}
              />
            </div>
          );
        })()}
    </div>
  );
}
