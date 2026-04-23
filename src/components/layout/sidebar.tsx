import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Container, Database, Folder as FolderIcon, Moon, Plug, Plus, Search, Settings, Sun, Upload, X } from "lucide-react";

import { useContextMenu, type ContextEntry } from "@/hooks/use-context-menu";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { appAlert, appConfirm, appPrompt } from "@/state/app-dialog";
import { useTheme } from "@/state/theme";
import { useConnections } from "@/state/connections";
import { useDockerDiscover } from "@/state/docker-discover";
import { useT } from "@/state/i18n";
import { useSidebarFilter } from "@/state/sidebar-filter";
import { useTabs } from "@/state/tabs";
import { useUiZoom } from "@/state/ui-zoom";

import { ConnTree } from "./conn-tree";

interface SidebarProps {
  className?: string;
}

const MIN_WIDTH = 180;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 260;
const WIDTH_KEY = "basemaster.sidebarWidth";

function readInitialWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const stored = window.localStorage.getItem(WIDTH_KEY);
  const n = stored ? Number(stored) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
}

export function Sidebar({ className }: SidebarProps) {
  const mode = useTheme((s) => s.effectiveMode());
  const setToggle = useTheme((s) => s.setToggle);
  const cycleMode = () => setToggle(mode === "dark" ? "light" : "dark");
  const connections = useConnections((s) => s.connections);
  const loading = useConnections((s) => s.loading);
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const t = useT();

  const newConnection = () => {
    openOrFocus(
      (tab) => tab.kind.kind === "new-connection",
      () => ({
        label: t("sidebar.newConnection"),
        kind: { kind: "new-connection" },
      }),
    );
  };

  const openSettings = () => {
    openOrFocus(
      (tab) => tab.kind.kind === "settings",
      () => ({ label: t("sidebar.settings"), kind: { kind: "settings" } }),
    );
  };

  const [width, setWidth] = useState<number>(readInitialWidth);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const search = useSidebarFilter((s) => s.query);
  const setSearch = useSidebarFilter((s) => s.setQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  // Typing-to-search: any letter/number typed outside an
  // input/textarea/contenteditable/CodeMirror goes to the sidebar's search
  // field. Doesn't require focus literally inside the aside — in the normal
  // state focus is on `body`, which isn't a descendant.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1) return;
      if (!/[\p{L}\p{N}]/u.test(e.key)) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (t.isContentEditable) return;
        if (t.closest && t.closest(".cm-editor")) return;
      }
      e.preventDefault();
      setSearch(useSidebarFilter.getState().query + e.key);
      searchInputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragStartRef.current;
      if (!d) return;
      const delta = e.clientX - d.startX;
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, d.startWidth + delta),
      );
      setWidth(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Keep the resize cursor while dragging, even outside the handle.
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging]);

  useEffect(() => {
    window.localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  return (
    <aside
      ref={sidebarRef}
      style={{ width }}
      className={cn(
        "relative flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-1 px-4">
        <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("sidebar.connections")}
        </span>
        <AddConnectionMenu />
        <NewFolderButton />
        <ImportConnectionsButton />
      </div>

      <SidebarTreeArea>
        {loading && connections.length === 0 ? (
          <SidebarSkeleton />
        ) : connections.length === 0 ? (
          <EmptyConnections onCreate={newConnection} />
        ) : (
          <ConnTree />
        )}
      </SidebarTreeArea>

      <div className="border-t border-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={t("sidebar.searchPlaceholder")}
            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-7 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("sidebar.clearSearch")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <footer className="flex h-12 items-center justify-between border-t border-border px-3">
        <button
          type="button"
          onClick={cycleMode}
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={mode === "dark" ? t("sidebar.themeLight") : t("sidebar.themeDark")}
        >
          {mode === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </button>
        <ZoomIndicator />
        <button
          type="button"
          onClick={openSettings}
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("sidebar.settings")}
        >
          <Settings className="h-4 w-4" />
        </button>
      </footer>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(e) => {
          e.preventDefault();
          dragStartRef.current = { startX: e.clientX, startWidth: width };
          setDragging(true);
        }}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        className={cn(
          "absolute right-0 top-0 h-full w-1 cursor-col-resize select-none",
          "transition-colors hover:bg-conn-accent/40",
          dragging && "bg-conn-accent/60",
        )}
        title={t("sidebar.resizeHint")}
      />
    </aside>
  );
}

function EmptyConnections({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <div className="mt-6 flex flex-col items-center px-3 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full border border-dashed border-border text-muted-foreground">
        <Database className="h-5 w-5" />
      </div>
      <div className="mt-3 text-sm font-medium">{t("sidebar.noConnections")}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t("sidebar.noConnectionsHint")}
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground shadow-sm transition-opacity hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("sidebar.newConnection")}
      </button>
    </div>
  );
}

function AddConnectionMenu() {
  const t = useT();
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const refreshFolders = useConnections((s) => s.refreshFolders);
  const openDockerDiscover = useDockerDiscover((s) => s.setOpen);

  const newConnection = () =>
    openOrFocus(
      (tab) => tab.kind.kind === "new-connection",
      () => ({
        label: t("sidebar.newConnection"),
        kind: { kind: "new-connection" },
      }),
    );

  const newFolder = async () => {
    const name = await appPrompt(t("sidebar.newFolderPrompt"));
    if (!name || !name.trim()) return;
    try {
      await ipc.folders.create({ name: name.trim() });
      await refreshFolders();
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    }
  };

  const items: ContextEntry[] = [
    {
      icon: <Plug className="h-3.5 w-3.5" />,
      label: t("sidebar.newConnection"),
      onClick: newConnection,
    },
    {
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("sidebar.newFolder"),
      onClick: newFolder,
    },
    { separator: true },
    {
      icon: <Container className="h-3.5 w-3.5" />,
      label: t("sidebar.dockerDetect"),
      onClick: () => openDockerDiscover(true),
    },
  ];
  const menu = useContextMenu(items);
  return (
    <>
      <button
        type="button"
        onClick={(e) => menu.openAt(e)}
        className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t("sidebar.addMenuTitle")}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {menu.element}
    </>
  );
}

/** Tree area with a context menu in the empty space: right-click on a spot
 *  without a connection/folder offers "New connection" / "New folder" / "Import".
 *  Context menus on the nodes themselves (ConnectionNode/FolderNode) call
 *  stopPropagation, so they don't conflict. */
function SidebarTreeArea({ children }: { children: React.ReactNode }) {
  const t = useT();
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const refreshFolders = useConnections((s) => s.refreshFolders);
  const refresh = useConnections((s) => s.refresh);
  const openDockerDiscover = useDockerDiscover((s) => s.setOpen);

  const newConnection = () =>
    openOrFocus(
      (tab) => tab.kind.kind === "new-connection",
      () => ({
        label: t("sidebar.newConnection"),
        kind: { kind: "new-connection" },
      }),
    );

  const newFolder = async () => {
    const name = await appPrompt(t("sidebar.newFolderPrompt"));
    if (!name || !name.trim()) return;
    try {
      await ipc.folders.create({ name: name.trim() });
      await refreshFolders();
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    }
  };

  const runImport = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [
          {
            name: t("sidebar.filterConnectionsName"),
            extensions: ["bmconn", "json", "ncx", "xml"],
          },
        ],
      });
      if (!path || Array.isArray(path)) return;
      const payload = await ipc.portability.importParse(path);
      if (payload.connections.length === 0) {
        void appAlert(t("welcome.fileHasNoConnections"));
        return;
      }
      const ok = await appConfirm(
        t("welcome.confirmImport", {
          count: payload.connections.length,
          folders: "",
        }),
      );
      if (!ok) return;
      await ipc.portability.importApply(payload);
      await refresh();
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    }
  };

  const menu = useContextMenu([
    {
      icon: <Plug className="h-3.5 w-3.5" />,
      label: t("sidebar.newConnection"),
      onClick: newConnection,
    },
    {
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: t("sidebar.newFolder"),
      onClick: newFolder,
    },
    { separator: true },
    {
      icon: <Upload className="h-3.5 w-3.5" />,
      label: t("sidebar.importFile"),
      onClick: runImport,
    },
    {
      icon: <Container className="h-3.5 w-3.5" />,
      label: t("sidebar.dockerDetect"),
      onClick: () => openDockerDiscover(true),
    },
  ]);

  return (
    <div
      className="flex-1 overflow-y-auto px-3 pb-2"
      onContextMenu={menu.openAt}
    >
      {children}
      {menu.element}
    </div>
  );
}

function NewFolderButton() {
  const refreshFolders = useConnections((s) => s.refreshFolders);
  const t = useT();
  const run = async () => {
    const name = await appPrompt(t("sidebar.newFolderPrompt"));
    if (!name || !name.trim()) return;
    try {
      await ipc.folders.create({ name: name.trim() });
      await refreshFolders();
    } catch (e) {
      void appAlert(t("common.failure", { error: String(e) }));
    }
  };
  return (
    <button
      type="button"
      onClick={() => void run()}
      className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={t("sidebar.newFolderTitle")}
    >
      <FolderIcon className="h-3.5 w-3.5" />
    </button>
  );
}

function ImportConnectionsButton() {
  const refresh = useConnections((s) => s.refresh);
  const t = useT();

  const run = async () => {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [
          {
            name: t("sidebar.filterConnectionsName"),
            extensions: ["bmconn", "json", "ncx", "xml"],
          },
        ],
      });
      if (!path || Array.isArray(path)) return;
      const payload = await ipc.portability.importParse(path);
      const count = payload.connections.length;
      if (count === 0) {
        void appAlert(t("welcome.fileHasNoConnections"));
        return;
      }
      const folders = payload.folders.length
        ? t("welcome.foldersSuffix", { n: payload.folders.length })
        : "";
      const ok = await appConfirm(
        t("welcome.confirmImport", { count, folders }),
      );
      if (!ok) return;
      const applied = await ipc.portability.importApply(payload);
      void appAlert(t("welcome.imported", { count: applied }));
      await refresh();
    } catch (e) {
      void appAlert(t("welcome.importFailed", { error: String(e) }));
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={t("sidebar.importTitle")}
    >
      <Upload className="h-3.5 w-3.5" />
    </button>
  );
}

function ZoomIndicator() {
  const zoom = useUiZoom((s) => s.zoom);
  const zoomIn = useUiZoom((s) => s.zoomIn);
  const zoomOut = useUiZoom((s) => s.zoomOut);
  const reset = useUiZoom((s) => s.zoomReset);
  const pct = Math.round(zoom * 100);
  const t = useT();
  return (
    <div className="flex items-center rounded-md border border-border/40">
      <button
        type="button"
        onClick={zoomOut}
        className="grid h-6 w-5 place-items-center text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("sidebar.zoomOutTitle")}
      >
        −
      </button>
      <button
        type="button"
        onClick={reset}
        className="min-w-[36px] px-1 font-mono text-[10px] tabular-nums text-muted-foreground hover:text-foreground"
        title={t("sidebar.zoomResetTitle", { pct })}
      >
        {pct}%
      </button>
      <button
        type="button"
        onClick={zoomIn}
        className="grid h-6 w-5 place-items-center text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("sidebar.zoomInTitle")}
      >
        +
      </button>
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="mt-2 grid gap-1.5 px-1.5">
      {[40, 70, 50, 60].map((w, i) => (
        <div
          key={i}
          className="h-6 animate-pulse rounded bg-muted/50"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}
