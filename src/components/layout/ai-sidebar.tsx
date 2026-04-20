import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Markdown } from "@/components/ui/markdown";
import { askAgent } from "@/lib/ai/runner";
import { parseModelKey, providerMeta } from "@/lib/ai/catalog";
import { cn } from "@/lib/utils";
import { useAiAgent, type AiContentBlock, type AiMessage } from "@/state/ai-agent";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

export function AiSidebar() {
  const t = useT();
  const open = useAiAgent((s) => s.panelOpen);
  const width = useAiAgent((s) => s.panelWidth);
  const setPanelWidth = useAiAgent((s) => s.setPanelWidth);
  const setPanelOpen = useAiAgent((s) => s.setPanelOpen);
  const apiKeys = useAiAgent((s) => s.apiKeys);
  const modelKeySel = useAiAgent((s) => s.modelKey);
  const hasAnyKey = Object.values(apiKeys).some((k) => k && k.length > 0);
  const parsed = parseModelKey(modelKeySel);
  const providerLabel = parsed
    ? providerMeta(parsed.provider).name
    : t("aiSidebar.notConfigured");
  const messages = useAiAgent((s) => s.messages);
  const loading = useAiAgent((s) => s.loading);
  const error = useAiAgent((s) => s.error);
  const clear = useAiAgent((s) => s.clear);

  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragStartRef.current;
      if (!d) return;
      // Sidebar direita: arrastar pra esquerda aumenta.
      const delta = d.startX - e.clientX;
      setPanelWidth(d.startWidth + delta);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    const prevCursor = document.body.style.cursor;
    const prevSel = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSel;
    };
  }, [dragging, setPanelWidth]);

  if (!open) return null;

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border bg-card/40"
    >
      <header className="flex h-14 items-center gap-2 border-b border-border px-3">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-conn-accent/10 text-conn-accent">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("aiSidebar.agent")}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {parsed?.modelId
              ? `${providerLabel} · ${parsed.modelId}`
              : providerLabel}
          </div>
        </div>
        <button
          type="button"
          onClick={clear}
          disabled={messages.length === 0 || loading}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          title={t("aiSidebar.clearConversation")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setPanelOpen(false)}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("aiSidebar.closeTitle")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <ContextBadge />

      {!hasAnyKey ? (
        <NoApiKey />
      ) : (
        <>
          <MessageList messages={messages} loading={loading} />
          {error && (
            <div className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          <Composer />
        </>
      )}

      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(e) => {
          e.preventDefault();
          dragStartRef.current = { startX: e.clientX, startWidth: width };
          setDragging(true);
        }}
        onDoubleClick={() => setPanelWidth(380)}
        className={cn(
          "absolute left-0 top-0 h-full w-1 cursor-col-resize select-none",
          "transition-colors hover:bg-conn-accent/40",
          dragging && "bg-conn-accent/60",
        )}
        title={t("aiSidebar.resizeHint")}
      />
    </aside>
  );
}

function ContextBadge() {
  const activeId = useTabs((s) => s.activeId);
  const tabs = useTabs((s) => s.tabs);
  const conns = useConnections((s) => s.connections);
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab) return null;
  const k = tab.kind;
  let connId: string | null = null;
  let extra = "";
  if (k.kind === "table") {
    connId = k.connectionId;
    extra = `${k.schema}.${k.table}`;
  } else if (k.kind === "query") {
    connId = k.connectionId;
    extra = k.schema ?? "query";
  } else if (k.kind === "tables-list" || k.kind === "saved-queries-list") {
    connId = k.connectionId;
    extra = k.schema ?? "";
  }
  if (!connId) return null;
  const conn = conns.find((c) => c.id === connId);
  if (!conn) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: conn.color ?? "currentColor" }}
      />
      <span className="truncate">
        <span className="font-medium text-foreground">{conn.name}</span>
        {extra && <span className="ml-1">· {extra}</span>}
      </span>
    </div>
  );
}

function NoApiKey() {
  const t = useT();
  const openSettings = () => {
    useTabs.getState().openOrFocus(
      (tab) => tab.kind.kind === "settings",
      () => ({ label: t("aiSidebar.settingsLabel"), kind: { kind: "settings" } }),
    );
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-full border border-dashed border-border text-muted-foreground">
        <Bot className="h-5 w-5" />
      </div>
      <div className="text-sm font-medium">{t("aiSidebar.configureApiKey")}</div>
      <p className="text-xs text-muted-foreground">
        {t("aiSidebar.noKeyHint")}
      </p>
      <button
        type="button"
        onClick={openSettings}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
      >
        {t("aiSidebar.openSettings")}
      </button>
    </div>
  );
}

/** Agrupa mensagens visualmente: tool_results vêm em mensagens user
 *  sintéticas mas visualmente pertencem à resposta anterior do assistant. */
interface VisualMessage {
  role: "user" | "assistant";
  id: string;
  texts: string[];
  toolCalls: Array<{
    id: string;
    name: string;
    input: unknown;
    result?: {
      content: string;
      is_error?: boolean;
    };
  }>;
}

function groupMessages(messages: AiMessage[]): VisualMessage[] {
  const out: VisualMessage[] = [];
  for (const m of messages) {
    const texts = m.content
      .filter(
        (b): b is Extract<AiContentBlock, { type: "text" }> =>
          b.type === "text",
      )
      .map((b) => b.text);
    const toolResults = m.content.filter(
      (b): b is Extract<AiContentBlock, { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    const toolUses = m.content.filter(
      (b): b is Extract<AiContentBlock, { type: "tool_use" }> =>
        b.type === "tool_use",
    );

    // User com apenas tool_results → grud no last assistant.
    if (m.role === "user" && toolResults.length > 0 && texts.length === 0) {
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        for (const tr of toolResults) {
          const call = last.toolCalls.find((c) => c.id === tr.tool_use_id);
          if (call) {
            call.result = { content: tr.content, is_error: tr.is_error };
          }
        }
        continue;
      }
    }

    out.push({
      id: m.id,
      role: m.role,
      texts,
      toolCalls: toolUses.map((tu) => ({
        id: tu.id,
        name: tu.name,
        input: tu.input,
      })),
    });
  }
  return out;
}

function MessageList({
  messages,
  loading,
}: {
  messages: AiMessage[];
  loading: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({
      top: ref.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, loading]);

  const visual = useMemo(() => groupMessages(messages), [messages]);

  if (messages.length === 0) {
    return (
      <div
        ref={ref}
        className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground"
      >
        <Sparkles className="h-4 w-4 text-conn-accent" />
        <p>{t("aiSidebar.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-3 py-3">
      <div className="flex flex-col gap-3">
        {visual.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("aiSidebar.thinking")}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: VisualMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        isUser ? "items-end" : "items-start",
      )}
    >
      {message.texts.map((t, i) => (
        <div
          key={i}
          className={cn(
            "max-w-full rounded-md px-3 py-2 text-sm",
            isUser
              ? "bg-conn-accent/10 text-foreground"
              : "bg-muted/60 text-foreground",
          )}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap">{t}</span>
          ) : (
            <Markdown text={t} />
          )}
        </div>
      ))}
      {message.toolCalls.length > 0 && (
        <ToolCallsStrip calls={message.toolCalls} />
      )}
    </div>
  );
}

function ToolCallsStrip({
  calls,
}: {
  calls: VisualMessage["toolCalls"];
}) {
  const t = useT();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1 self-stretch">
      {calls.map((c) => {
        const open = expandedId === c.id;
        const hasError = c.result?.is_error;
        const done = c.result !== undefined;
        return (
          <div
            key={c.id}
            className={cn(
              "rounded-md border text-[11px] transition-colors",
              hasError
                ? "border-destructive/40 bg-destructive/5"
                : "border-border/60 bg-background/30",
            )}
          >
            <button
              type="button"
              onClick={() => setExpandedId(open ? null : c.id)}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-muted-foreground hover:text-foreground"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  hasError
                    ? "bg-destructive"
                    : done
                      ? "bg-green-500"
                      : "bg-conn-accent animate-pulse",
                )}
              />
              <span className="font-mono">{c.name}</span>
              <span className="ml-auto text-[10px] opacity-60">
                {open ? t("aiSidebar.less") : t("aiSidebar.details")}
              </span>
            </button>
            {open && (
              <div className="border-t border-border/40 px-2 py-1">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {t("aiSidebar.input")}
                </div>
                <pre className="mb-1 max-h-32 overflow-auto font-mono leading-tight">
                  {tryStringify(c.input)}
                </pre>
                {c.result && (
                  <>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      {hasError ? t("aiSidebar.errorLabel") : t("aiSidebar.resultLabel")}
                    </div>
                    <pre className="max-h-48 overflow-auto font-mono leading-tight">
                      {c.result.content}
                    </pre>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function Composer() {
  const t = useT();
  const [text, setText] = useState("");
  const loading = useAiAgent((s) => s.loading);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    const v = text.trim();
    if (!v || loading) return;
    setText("");
    await askAgent(v);
  };

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  }, [text]);

  return (
    <div className="border-t border-border p-2">
      <div className="flex items-end gap-2 rounded-md border border-border bg-background px-2 py-1.5 focus-within:border-conn-accent focus-within:ring-1 focus-within:ring-conn-accent/40">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder={t("aiSidebar.composerPlaceholder")}
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          disabled={loading}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={loading || !text.trim()}
          className="grid h-7 w-7 place-items-center rounded-md bg-conn-accent text-conn-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          title={t("aiSidebar.sendTitle")}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
