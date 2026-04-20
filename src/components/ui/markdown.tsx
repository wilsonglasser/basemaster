import { isValidElement, useState, type ReactNode } from "react";
import { Check, Copy, Play } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useQueryTabBridge } from "@/state/query-tab-bridge";
import { useTabs } from "@/state/tabs";

import "highlight.js/styles/github-dark.css";

interface Props {
  text: string;
  className?: string;
}

export function Markdown({ text, className }: Props) {
  return (
    <div className={cn("md-body", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          code({ className, children, ...rest }) {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
            // Inline code: sem className (não veio de fenced block).
            const inline = !className;
            if (inline) {
              return (
                <code
                  className={cn(
                    "rounded bg-muted/60 px-1 py-[1px] font-mono text-[11px]",
                    className,
                  )}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            const text = extractText(children).replace(/\n$/, "");
            return (
              <CodeBlock
                text={text}
                language={lang}
                rawClass={className}
                highlighted={children}
              />
            );
          },
          a({ href, children, ...rest }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-conn-accent underline-offset-2 hover:underline"
                {...rest}
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-xs">
                  {children}
                </table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-muted/40">{children}</thead>;
          },
          th({ children }) {
            return (
              <th className="border-b border-border px-2 py-1 text-left font-medium">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="border-b border-border/40 px-2 py-1 align-top">
                {children}
              </td>
            );
          },
          ul({ children }) {
            return <ul className="ml-4 list-disc space-y-0.5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="ml-4 list-decimal space-y-0.5">{children}</ol>;
          },
          p({ children }) {
            return <p className="leading-relaxed">{children}</p>;
          },
          h1({ children }) {
            return <h1 className="mt-2 text-sm font-semibold">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mt-2 text-sm font-semibold">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mt-1.5 text-[13px] font-semibold">{children}</h3>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Extrai texto puro de uma árvore React — necessário pra `copy` e `run`
 *  depois que o rehype-highlight envelopa o conteúdo em spans de token. */
function extractText(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText(
      (node.props as { children?: ReactNode } | null)?.children,
    );
  }
  return "";
}

function CodeBlock({
  text,
  language,
  rawClass,
  highlighted,
}: {
  text: string;
  language: string;
  rawClass?: string;
  /** Children JSX já highlighted (spans coloridos) — renderiza direto. */
  highlighted: ReactNode;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1000);
  };

  const isSql = /^sql$/i.test(language);

  const runInActiveOrNewTab = () => {
    // Prioridade: se a aba ativa é query, append no editor.
    const tabs = useTabs.getState();
    const active = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (active?.kind.kind === "query") {
      const bridge = useQueryTabBridge.getState();
      const setter = bridge.setters[active.id];
      if (setter) {
        // Precisa do sql atual pra append; lemos de tab-state.
        void import("@/state/tab-state").then(({ useTabState }) => {
          const cur = useTabState.getState().queryOf(active.id)?.sql ?? "";
          setter(cur ? `${cur}\n\n${text}` : text);
        });
        return;
      }
    }
    // Senão, abre aba nova na conexão mais recente ativa.
    const firstActiveId = [...useConnections.getState().active][0] ?? null;
    const connId =
      firstActiveId ??
      (active && "connectionId" in active.kind
        ? (active.kind as { connectionId?: string }).connectionId
        : undefined);
    if (!connId) {
      alert(t("markdown.noActiveConnection"));
      return;
    }
    tabs.open({
      label: t("markdown.aiQueryLabel"),
      kind: { kind: "query", connectionId: connId, initialSql: text },
    });
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-border bg-muted/30">
      <div className="flex items-center justify-between border-b border-border/60 bg-card/40 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{language || t("markdown.code")}</span>
        <div className="flex items-center gap-1">
          {isSql && (
            <button
              type="button"
              onClick={runInActiveOrNewTab}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] normal-case text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("markdown.editorTitle")}
            >
              <Play className="h-3 w-3 fill-current" />
              {t("markdown.editorLabel")}
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] normal-case text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("markdown.copyTitle")}
          >
            {copied ? (
              <Check className="h-3 w-3 text-conn-accent" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            {copied ? t("markdown.copied") : t("markdown.copy")}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-relaxed">
        <code className={rawClass}>{highlighted}</code>
      </pre>
    </div>
  );
}
