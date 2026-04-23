import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRightLeft,
  Container,
  Database,
  ExternalLink,
  FileText,
  History,
  Plug,
  Plus,
  Save,
  Settings as SettingsIcon,
  Sparkles,
  Table as TableIcon,
  X,
} from "lucide-react";

import { ask } from "@tauri-apps/plugin-dialog";

import { useContextMenu, type ContextEntry } from "@/hooks/use-context-menu";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAiAgent } from "@/state/ai-agent";
import { appPrompt } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useDockerDiscover } from "@/state/docker-discover";
import { useSidebarSelection } from "@/state/sidebar-selection";
import { useActiveInfo } from "@/state/active-info";
import { useI18n, useT } from "@/state/i18n";
import { useTabState } from "@/state/tab-state";
import { useTabs, type Tab, type TabKind } from "@/state/tabs";

/** Altura aproximada do tab-bar (h-10 = 40px). Mouseup abaixo disso
 *  dispara o tear-off; acima permanece como click normal. Com margem. */
const TAB_BAR_HEIGHT_PX = 40;
const TEAR_OFF_MARGIN_PX = 8;

interface TabBarProps {
  className?: string;
}

export function TabBar({ className }: TabBarProps) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const setActive = useTabs((s) => s.setActive);
  const close = useTabs((s) => s.close);
  const t = useT();

  const connectionIdOf = (tab: Tab): string | null => {
    const k = tab.kind;
    if (
      k.kind === "edit-connection" ||
      k.kind === "query" ||
      k.kind === "table"
    ) {
      return k.connectionId;
    }
    return null;
  };

  /** Confirms if there are dirty tabs among the close candidates. Returns
   *  `true` if ok to proceed. ASYNC because Tauri exposes confirm/ask as
   *  an IPC command, not sync JS. */
  const confirmDirty = async (candidates: Tab[]): Promise<boolean> => {
    const dirtyTabs = candidates.filter((t) => t.dirty);
    if (dirtyTabs.length === 0) return true;
    const names = dirtyTabs.map((tb) => `• ${tb.label}`).join("\n");
    const msg =
      dirtyTabs.length === 1
        ? t("tabs.closeDirtyOneMsg", { name: dirtyTabs[0].label })
        : t("tabs.closeDirtyManyMsg", {
            count: dirtyTabs.length,
            list: names,
          });
    try {
      return await ask(msg, {
        title: t("tabs.closeDirtyTitle"),
        kind: "warning",
        okLabel: t("tabs.closeDirtyOk"),
        cancelLabel: t("tabs.closeDirtyCancel"),
      });
    } catch (e) {
      console.error("[tab-bar] ask() falhou:", e);
      // Fail-safe: if the dialog doesn't open, do NOT close silently.
      return false;
    }
  };

  // CRITICAL: read directly via getState() to avoid stale closures.
  const safeClose = async (id: string) => {
    const currentTabs = useTabs.getState().tabs;
    const tab = currentTabs.find((t) => t.id === id);
    if (tab && !(await confirmDirty([tab]))) return;
    useTabs.getState().close(id);
  };
  const safeCloseMany = async (predicate: (t: Tab) => boolean) => {
    const currentTabs = useTabs.getState().tabs;
    const affected = currentTabs.filter(predicate);
    if (affected.length === 0) return;
    if (!(await confirmDirty(affected))) return;
    useTabs.getState().closeMany(predicate);
  };

  return (
    <div
      className={cn(
        "flex h-10 items-stretch border-b border-border bg-chrome text-chrome-foreground",
        className,
      )}
    >
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const connId = connectionIdOf(tab);
          return (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              onClick={() => setActive(tab.id)}
              onClose={() => void safeClose(tab.id)}
              onDetach={() => detachTab(tab, () => close(tab.id))}
              onCloseAll={() => void safeCloseMany(() => true)}
              onCloseOthers={() =>
                void safeCloseMany((o) => o.id !== tab.id)
              }
              onCloseSameConn={
                connId
                  ? () =>
                      void safeCloseMany(
                        (o) => connectionIdOf(o) === connId,
                      )
                  : undefined
              }
            />
          );
        })}
      </div>
      <NewTabButton />
      <AiToggleButton />
    </div>
  );
}

function AiToggleButton() {
  const open = useAiAgent((s) => s.panelOpen);
  const toggle = useAiAgent((s) => s.togglePanel);
  const t = useT();
  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "grid w-10 shrink-0 place-items-center border-l border-border transition-colors",
        open
          ? "bg-conn-accent/10 text-conn-accent hover:bg-conn-accent/15"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      title={t("tabs.aiAgentTitle")}
    >
      <Sparkles className="h-3.5 w-3.5" />
    </button>
  );
}

/** "+" button at the end of the tab bar. Instead of opening a fixed tab
 *  (welcome), shows a context menu with options based on the connection/
 *  schema currently focused in the sidebar. Navicat-style. */
function NewTabButton() {
  const t = useT();
  const open = useTabs((s) => s.open);
  const openOrFocus = useTabs((s) => s.openOrFocus);
  const sidebarSel = useSidebarSelection((s) => s.selected);
  const connections = useConnections((s) => s.connections);

  // Figures out the focused connection+schema. Priority: sidebar selection.
  let focusConnId: string | null = null;
  let focusSchema: string | null = null;
  if (sidebarSel) {
    focusConnId = sidebarSel.connectionId;
    if ("schema" in sidebarSel && sidebarSel.schema) {
      focusSchema = sidebarSel.schema;
    }
  }
  const focusConn = focusConnId
    ? connections.find((c) => c.id === focusConnId)
    : null;
  const accent = focusConn?.color ?? null;

  const openNewQuery = () => {
    if (!focusConn) {
      open({ label: t("tabs.welcome"), kind: { kind: "welcome" } });
      return;
    }
    open({
      label: t("tree.newQuery"),
      kind: {
        kind: "query",
        connectionId: focusConn.id,
        schema: focusSchema ?? focusConn.default_database ?? undefined,
      },
      accentColor: focusConn.color,
    });
  };

  const openNewTable = () => {
    if (!focusConn || !focusSchema) return;
    useTabs.getState().open({
      label: t("newTable.tabLabel", { schema: focusSchema }),
      kind: {
        kind: "new-table",
        connectionId: focusConn.id,
        schema: focusSchema,
      },
      accentColor: focusConn.color,
    });
  };

  const openCreateDatabase = async () => {
    if (!focusConn) return;
    const name = await appPrompt(
      focusConn.driver === "postgres"
        ? t("tabs.newDatabasePromptPg")
        : t("tabs.newDatabasePromptMysql"),
    );
    if (!name || !name.trim()) return;
    const keyword = focusConn.driver === "postgres" ? "SCHEMA" : "DATABASE";
    const quote = focusConn.driver === "postgres" ? '"' : "`";
    const q = `${quote}${name.trim().replace(new RegExp(quote, "g"), quote + quote)}${quote}`;
    const sql = `CREATE ${keyword} IF NOT EXISTS ${q};`;
    open({
      label: `CREATE ${keyword}`,
      kind: {
        kind: "query",
        connectionId: focusConn.id,
        initialSql: sql,
        autoRun: true,
      },
      accentColor: focusConn.color,
    });
  };

  const openWelcome = () => {
    openOrFocus(
      (tab) => tab.kind.kind === "welcome",
      () => ({ label: t("tabs.welcome"), kind: { kind: "welcome" } }),
    );
  };
  const openNewConnection = () => {
    openOrFocus(
      (tab) => tab.kind.kind === "new-connection",
      () => ({
        label: t("sidebar.newConnection"),
        kind: { kind: "new-connection" },
      }),
    );
  };
  const openDockerDiscover = () => {
    useDockerDiscover.getState().setOpen(true);
  };

  const items: ContextEntry[] = [];
  if (focusConn) {
    items.push({
      icon: <FileText className="h-3.5 w-3.5" />,
      label: `${t("tree.newQuery")} · ${focusConn.name}`,
      onClick: openNewQuery,
    });
    items.push({
      icon: <TableIcon className="h-3.5 w-3.5" />,
      label: focusSchema
        ? `${t("tree.newTable")} · ${focusSchema}`
        : t("tree.newTable"),
      disabled: !focusSchema,
      onClick: openNewTable,
    });
    items.push({
      icon: <Database className="h-3.5 w-3.5" />,
      label:
        focusConn.driver === "postgres"
          ? t("tabs.newDatabaseLabelPg")
          : t("tabs.newDatabaseLabelMysql"),
      onClick: openCreateDatabase,
    });
    items.push({ separator: true });
  } else {
    items.push({
      icon: <FileText className="h-3.5 w-3.5" />,
      label: t("tree.newQuery"),
      disabled: true,
      onClick: () => {},
    });
    items.push({ separator: true });
  }
  items.push({
    icon: <Plug className="h-3.5 w-3.5" />,
    label: t("sidebar.newConnection"),
    onClick: openNewConnection,
  });
  items.push({
    icon: <Container className="h-3.5 w-3.5" />,
    label: t("sidebar.dockerDetect"),
    onClick: openDockerDiscover,
  });
  items.push({
    icon: <FileText className="h-3.5 w-3.5" />,
    label: t("tabs.dataImportMenu"),
    onClick: () => {
      useTabs.getState().open({
        label: t("tabs.dataImportLabel"),
        kind: {
          kind: "data-import",
          connectionId: focusConnId ?? undefined,
          schema: focusSchema ?? undefined,
        },
      });
    },
  });
  items.push({
    icon: <Sparkles className="h-3.5 w-3.5" />,
    label: t("tabs.welcome"),
    onClick: openWelcome,
  });

  const menu = useContextMenu(items);

  return (
    <>
      <button
        type="button"
        onClick={(e) => menu.openAt(e)}
        style={
          accent
            ? ({ "--conn-accent": accent } as React.CSSProperties)
            : undefined
        }
        className="grid w-10 place-items-center border-l border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={t("tabs.newTab")}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {menu.element}
    </>
  );
}

function iconFor(kind: TabKind) {
  switch (kind.kind) {
    case "welcome":
      return Sparkles;
    case "new-connection":
    case "edit-connection":
      return Plug;
    case "query":
      return FileText;
    case "table":
      return TableIcon;
    case "settings":
      return SettingsIcon;
    case "tables-list":
      return TableIcon;
    case "saved-queries-list":
      return Save;
    case "data-transfer":
      return ArrowRightLeft;
    case "sql-dump":
      return FileText;
    case "sql-import":
      return FileText;
    case "query-history":
      return History;
    case "processes":
      return Database;
    case "data-import":
      return FileText;
    case "new-table":
      return Plus;
    case "users":
      return Database;
  }
}

function TabItem({
  tab,
  active,
  onClick,
  onClose,
  onDetach,
  onCloseAll,
  onCloseOthers,
  onCloseSameConn,
}: {
  tab: Tab;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onDetach: () => void;
  onCloseAll: () => void;
  onCloseOthers: () => void;
  onCloseSameConn?: () => void;
}) {
  const Icon = iconFor(tab.kind);
  const accent = tab.accentColor;

  const detachable = tab.kind.kind === "table" || tab.kind.kind === "query";
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  // Drag-out estilo Chrome: mousedown + mousemove mostra o ghost seguindo
  // o cursor. No mouseup, se o cursor estiver abaixo do tab-bar, dispara
  // detach at current position (user chooses where the window spawns). If
  // still in the tab-bar, it's a normal click, nothing happens.
  // Esc cancela.
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragStartRef.current;
      if (!d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      // Only start the ghost after 4px to avoid flickering on clicks.
      if (moved > 4) setGhost({ x: e.clientX, y: e.clientY });
    };
    const onUp = (e: MouseEvent) => {
      const d = dragStartRef.current;
      setDragging(false);
      setGhost(null);
      dragStartRef.current = null;
      if (!d || !detachable) return;
      // Don't fire if the user barely moved the mouse (was a click).
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved < 6) return;
      // Dentro do tab-bar = cancela (futuramente: reorder).
      if (e.clientY <= TAB_BAR_HEIGHT_PX + TEAR_OFF_MARGIN_PX) return;
      // Outside: tear-off at the cursor's screen position.
      detachTabAt(tab, e.screenX, e.screenY);
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDragging(false);
        setGhost(null);
        dragStartRef.current = null;
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging, detachable, tab, onClose]);

  const menuItems: ContextEntry[] = [
    {
      icon: <ExternalLink className="h-3.5 w-3.5" />,
      label: t("tabs.openInNewWindow"),
      disabled: !detachable,
      onClick: onDetach,
    },
    { separator: true },
    {
      icon: <X className="h-3.5 w-3.5" />,
      label: t("tabs.closeTab"),
      variant: "destructive",
      onClick: onClose,
    },
    {
      icon: <X className="h-3.5 w-3.5" />,
      label: t("tabs.closeOthers"),
      onClick: onCloseOthers,
    },
    ...(onCloseSameConn
      ? [
          {
            icon: <X className="h-3.5 w-3.5" />,
            label: t("tabs.closeSameConn"),
            onClick: onCloseSameConn,
          } as ContextEntry,
        ]
      : []),
    {
      icon: <X className="h-3.5 w-3.5" />,
      label: t("tabs.closeAll"),
      variant: "destructive",
      onClick: onCloseAll,
    },
  ];
  const menu = useContextMenu(menuItems);

  return (
    <div
      onClick={onClick}
      onContextMenu={menu.openAt}
      onMouseDown={(e) => {
        if (e.button !== 0 || !detachable) return;
        dragStartRef.current = { x: e.clientX, y: e.clientY };
        setDragging(true);
      }}
      style={
        accent ? ({ "--conn-accent": accent } as React.CSSProperties) : undefined
      }
      className={cn(
        "group relative flex min-w-[140px] max-w-[220px] cursor-pointer items-center gap-2 border-r border-border px-3 text-sm transition-colors",
        active
          ? "bg-conn-accent/15 text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        dragging && "opacity-60",
      )}
    >
      {active && (
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-conn-accent"
          aria-hidden
        />
      )}
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {tab.kind.kind === "welcome" ? t("tabs.welcome") : tab.label}
        {tab.dirty && <span className="ml-1 text-conn-accent">•</span>}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "ml-auto grid h-5 w-5 place-items-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground",
          active ? "opacity-60" : "opacity-0",
          "group-hover:opacity-100",
        )}
        title={t("tabs.closeTab")}
      >
        <X className="h-3 w-3" />
      </button>
      {menu.element}
      {ghost &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: ghost.x - 70,
              top: ghost.y - 14,
              pointerEvents: "none",
              zIndex: 9999,
            }}
            className={cn(
              "flex min-w-[140px] max-w-[220px] items-center gap-2 overflow-hidden rounded-md border px-3 py-1.5 text-sm shadow-2xl",
              "bg-popover text-popover-foreground",
              "opacity-95",
              accent ? "border-conn-accent/60" : "border-border",
            )}
          >
            {accent && (
              <span
                className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
                style={{ backgroundColor: accent }}
                aria-hidden
              />
            )}
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {tab.kind.kind === "welcome" ? t("tabs.welcome") : tab.label}
            </span>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Tear-off: serializa o payload da aba no localStorage (compartilhado
 *  entre janelas Tauri na mesma origem) + abre WebviewWindow nova apontando
 *  to the same index.html. The detached window reads its own label and loads
 *  o payload. Depois, fecha a aba local. */
function detachTab(tab: Tab, onAfter: () => void) {
  detachTabAt(tab, undefined, undefined);
  onAfter();
}

/** Variante que posiciona a nova janela em coords de tela (drag-out). */
function detachTabAt(tab: Tab, screenX?: number, screenY?: number) {
  const label = `detached-${tab.id}`;
  const payload = buildDetachPayload(tab, label);
  if (!payload) return;
  // Transfere state persistido pro key do detached window (o tabId
  // that the detached window will use is the label). Remove from the source so we don't
  // poluir se a aba for reaberta no main com novo id.
  useTabState.getState().move(tab.id, label, true);
  try {
    window.localStorage.setItem(`${label}:payload`, JSON.stringify(payload));
  } catch (e) {
    console.error("detachTab: localStorage falhou", e);
    return;
  }
  // Shift slightly above-left of the cursor so the window spawns
  // under the user's hand, not clipped by the monitor's edge.
  const offsetX = 20;
  const offsetY = 20;
  const wx = screenX != null ? Math.max(0, screenX - offsetX) : undefined;
  const wy = screenY != null ? Math.max(0, screenY - offsetY) : undefined;
  ipc.window
    .openDetached(label, "", `${payload.displayLabel} · BaseMaster`, wx, wy)
    .catch((e) => {
      console.error("openDetachedWindow:", e);
      alert(
        useI18n.getState().t("tabs.openWindowFailed", { error: String(e) }),
      );
    });
}

/** Builds the kind-specific payload for the tab, pulling live state from the
 *  editor quando for query (active-info). */
function buildDetachPayload(tab: Tab, label: string) {
  if (tab.kind.kind === "table") {
    return {
      kind: "table" as const,
      connectionId: tab.kind.connectionId,
      schema: tab.kind.schema,
      table: tab.kind.table,
      accentColor: tab.accentColor ?? null,
      label,
      displayLabel: tab.label,
    };
  }
  if (tab.kind.kind === "query") {
    const live = useActiveInfo.getState().byTab[tab.id];
    const sql = live?.editorSql ?? "";
    const schema = live?.editorSchema ?? tab.kind.schema;
    return {
      kind: "query" as const,
      connectionId: tab.kind.connectionId,
      schema,
      initialSql: sql,
      accentColor: tab.accentColor ?? null,
      label,
      displayLabel: tab.label,
    };
  }
  return null;
}
