import { Check, ChevronDown, Copy, Download, ExternalLink, Eye, EyeOff, Globe, Keyboard, Moon, Plug, Server, Sparkles, Sun, Upload } from "lucide-react";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { useTheme, type Theme } from "@/hooks/use-theme";
import { MODEL_CATALOG, parseModelKey, providerMeta, PROVIDERS, type ProviderId } from "@/lib/ai/catalog";
import { ShortcutsPanel } from "@/components/shortcuts-panel";
import { useAiAgent } from "@/state/ai-agent";
import { useI18n, useT, type Lang } from "@/state/i18n";
import { ipc } from "@/lib/ipc";
import type { McpStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const LANGS: Array<{ value: Lang; label: string; flag: string }> = [
  { value: "pt-BR", label: "Português (Brasil)", flag: "🇧🇷" },
  { value: "en", label: "English", flag: "🇺🇸" },
];

const THEMES: Array<{ value: Theme; labelKey: "themeLight" | "themeDark" }> = [
  { value: "light", labelKey: "themeLight" },
  { value: "dark", labelKey: "themeDark" },
];

export function SettingsView() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);
  const { theme, setTheme } = useTheme();

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="mb-6 text-lg font-semibold">
          {t("sidebar.settings")}
        </h1>

        <Section
          icon={<Globe className="h-4 w-4" />}
          title={t("sidebar.language")}
        >
          <div className="grid gap-1">
            {LANGS.map((l) => (
              <OptionRow
                key={l.value}
                selected={l.value === lang}
                onClick={() => setLang(l.value)}
              >
                <span className="text-lg leading-none">{l.flag}</span>
                <span className="flex-1 text-sm">{l.label}</span>
                <code className="text-[10px] text-muted-foreground">
                  {l.value}
                </code>
              </OptionRow>
            ))}
          </div>
        </Section>

        <Section
          icon={<Plug className="h-4 w-4" />}
          title="Conexões (import/export)"
        >
          <ConnectionsPortabilityPanel />
        </Section>

        <Section
          icon={<Keyboard className="h-4 w-4" />}
          title="Atalhos de teclado"
        >
          <ShortcutsPanel />
        </Section>

        <Section
          icon={<Sparkles className="h-4 w-4" />}
          title="Agente de IA"
        >
          <AiAgentPanel />
        </Section>

        <Section
          icon={<Server className="h-4 w-4" />}
          title="MCP server"
        >
          <McpPanel />
        </Section>

        <Section
          icon={theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          title={t("sidebar.toggleTheme")}
        >
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map((th) => (
              <button
                key={th.value}
                type="button"
                onClick={() => setTheme(th.value)}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-md border px-4 py-3 text-sm transition-colors",
                  theme === th.value
                    ? "border-conn-accent bg-conn-accent/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {th.value === "light" ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
                {t(`sidebar.${th.labelKey}`)}
              </button>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function AiAgentPanel() {
  const apiKeys = useAiAgent((s) => s.apiKeys);
  const setApiKey = useAiAgent((s) => s.setApiKey);
  const modelSel = useAiAgent((s) => s.modelKey);
  const setModelKey = useAiAgent((s) => s.setModelKey);

  // Qual provider tá em edição — default: o do modelo atual.
  const currentParsed = parseModelKey(modelSel);
  const [activeProvider, setActiveProvider] = useState<ProviderId>(
    currentParsed?.provider ?? "anthropic",
  );
  const meta = providerMeta(activeProvider);
  const currentModel =
    currentParsed?.provider === activeProvider
      ? currentParsed.modelId
      : "";

  const [modelDraft, setModelDraft] = useState(currentModel);
  useEffect(() => {
    setModelDraft(currentModel);
  }, [currentModel]);

  const commitModel = () => {
    const trimmed = modelDraft.trim();
    if (!trimmed) return;
    setModelKey(`${activeProvider}:${trimmed}`);
  };

  const keyValue = apiKeys[activeProvider] ?? "";

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Escolha o provider, cole a API key e informe o model ID (com
        autocomplete). Chaves ficam só no localStorage deste app.
      </p>

      {/* Provider selector — select único */}
      <div className="grid gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Provider
        </label>
        <select
          value={activeProvider}
          onChange={(e) => setActiveProvider(e.target.value as ProviderId)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {apiKeys[p.id] ? " ✓" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Key + model pro provider selecionado */}
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="mb-3 flex items-center justify-between text-xs">
          <span className="font-medium">{meta.name}</span>
          <a
            href={meta.keysUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            obter chave <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <ApiKeyInput
          value={keyValue}
          placeholder={meta.keyPlaceholder}
          onSave={(k) => setApiKey(activeProvider, k)}
        />

        <div className="mt-3">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Model ID
          </label>
          <ModelCombobox
            provider={activeProvider}
            value={modelDraft}
            onChange={setModelDraft}
            onCommit={commitModel}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Use um dos sugeridos ou digite qualquer ID que o provider aceite
            (modelos novos funcionam sem atualizar o app).
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>Modelo ativo:</span>
        <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono">
          {modelSel || "nenhum"}
        </code>
      </div>
    </div>
  );
}

function ApiKeyInput({
  value,
  placeholder,
  onSave,
}: {
  value: string;
  placeholder: string;
  onSave: (k: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = draft !== value;
  const save = () => {
    onSave(draft.trim() || null);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1000);
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        type={show ? "text" : "password"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent"
        title={show ? "Ocultar" : "Mostrar"}
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={save}
        disabled={!dirty}
        className={cn(
          "rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-40",
          dirty
            ? "border-conn-accent bg-conn-accent/10 hover:bg-conn-accent/20"
            : "border-border",
        )}
      >
        {saved ? <Check className="h-3.5 w-3.5 text-conn-accent" /> : "Salvar"}
      </button>
    </div>
  );
}

function ModelCombobox({
  provider,
  value,
  onChange,
  onCommit,
}: {
  provider: ProviderId;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(
    () => MODEL_CATALOG.filter((m) => m.provider === provider),
    [provider],
  );
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return suggestions;
    return suggestions.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q),
    );
  }, [suggestions, value]);

  return (
    <div className="relative">
      <div className="flex gap-1.5">
        <input
          type="text"
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
              setOpen(false);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="gpt-4o, claude-sonnet-4-6, …"
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-md border border-border px-2 py-1.5 text-muted-foreground hover:bg-accent"
          title="Sugestões"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            onCommit();
            setOpen(false);
          }}
          className="rounded-md border border-conn-accent bg-conn-accent/10 px-3 py-1.5 text-xs text-foreground hover:bg-conn-accent/20"
        >
          Usar
        </button>
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {filtered.map((m) => (
            <button
              key={m.modelId}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(m.modelId);
                setOpen(false);
                // auto-commit ao escolher da lista
                setTimeout(onCommit, 0);
              }}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
            >
              <span className="truncate">
                <span className="font-medium">{m.label}</span>
                {m.hint && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    {m.hint}
                  </span>
                )}
              </span>
              <code className="shrink-0 text-[10px] text-muted-foreground">
                {m.modelId}
              </code>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function McpPanel() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [port, setPort] = useState<number>(7424);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "config" | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc.mcp
      .status()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.port) setPort(s.port);
      })
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    setLoading(true);
    setErr(null);
    try {
      const next = status?.running
        ? await ipc.mcp.stop()
        : await ipc.mcp.start(port);
      setStatus(next);
      if (next.port) setPort(next.port);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  function copy(value: string, kind: "token" | "config") {
    void navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1200);
  }

  const running = !!status?.running;
  const token = status?.token ?? null;
  const activePort = status?.port ?? port;
  const url = `http://127.0.0.1:${activePort}/mcp`;
  const configJson = token
    ? JSON.stringify(
        {
          mcpServers: {
            basemaster: {
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Expõe as conexões do BaseMaster como um servidor MCP local (127.0.0.1).
        Clientes de IA externos podem listar schemas, descrever tabelas e
        rodar queries usando o token abaixo.
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={loading}
          className={cn(
            "rounded-md border px-4 py-1.5 text-sm transition-colors disabled:opacity-50",
            running
              ? "border-conn-accent bg-conn-accent/10 text-foreground hover:bg-conn-accent/20"
              : "border-border hover:bg-accent",
          )}
        >
          {running ? "Parar" : "Iniciar"}
        </button>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Porta
          <input
            type="number"
            min={1024}
            max={65535}
            value={port}
            disabled={running}
            onChange={(e) => setPort(Number(e.target.value) || 7424)}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
          />
        </label>

        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]",
            running
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              running ? "bg-green-500" : "bg-muted-foreground/50",
            )}
          />
          {running ? "rodando" : "parado"}
        </span>
      </div>

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {err}
        </div>
      )}

      {running && token && (
        <>
          <div className="grid gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              URL
            </span>
            <code className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
              {url}
            </code>
          </div>

          <div className="grid gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Token
            </span>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                {token}
              </code>
              <button
                type="button"
                onClick={() => copy(token, "token")}
                className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent"
                title="Copiar token"
              >
                {copied === "token" ? (
                  <Check className="h-3.5 w-3.5 text-conn-accent" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Config de cliente (Claude Desktop, etc.)
              </span>
              <button
                type="button"
                onClick={() => copy(configJson, "config")}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {copied === "config" ? (
                  <Check className="h-3 w-3 text-conn-accent" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                copiar
              </button>
            </div>
            <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed">
              {configJson}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}

function ConnectionsPortabilityPanel() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const exportAll = async (includePasswords: boolean) => {
    setExporting(true);
    setMsg(null);
    try {
      const payload = await ipc.portability.export(includePasswords);
      const path = await saveDialog({
        defaultPath: `basemaster-conexoes-${new Date()
          .toISOString()
          .slice(0, 10)}.bmconn`,
        filters: [{ name: "BaseMaster", extensions: ["bmconn", "json"] }],
      });
      if (!path) return;
      const json = JSON.stringify(payload, null, 2);
      const bytes = new TextEncoder().encode(json);
      await invoke("save_file", { path, data: Array.from(bytes) });
      setMsg({
        kind: "ok",
        text: `${payload.connections.length} conexão(ões) exportada(s) pra ${path}`,
      });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setExporting(false);
    }
  };

  const runImport = async () => {
    setImporting(true);
    setMsg(null);
    try {
      const path = await openDialog({
        multiple: false,
        filters: [
          {
            name: "Conexões",
            extensions: ["bmconn", "json", "ncx", "xml"],
          },
        ],
      });
      if (!path || Array.isArray(path)) return;
      const payload = await ipc.portability.importParse(path);
      const count = payload.connections.length;
      if (count === 0) {
        setMsg({ kind: "err", text: "Arquivo não contém conexões." });
        return;
      }
      const ok = window.confirm(
        `Importar ${count} conexão(ões)${payload.folders.length ? ` + ${payload.folders.length} pasta(s)` : ""}?`,
      );
      if (!ok) return;
      const applied = await ipc.portability.importApply(payload);
      setMsg({ kind: "ok", text: `${applied} conexão(ões) importada(s).` });
      // Recarrega a lista na sidebar.
      const { useConnections } = await import("@/state/connections");
      await useConnections.getState().refresh();
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Exporta suas conexões em formato{" "}
        <code className="rounded bg-muted/40 px-1">.bmconn</code> (JSON).
        Importa esse formato ou{" "}
        <code className="rounded bg-muted/40 px-1">.ncx</code> do Navicat
        (decripta senhas quando a chave é a padrão; senão vem vazia).
      </p>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void exportAll(false)}
          disabled={exporting}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs hover:bg-accent disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          Exportar (sem senhas)
        </button>
        <button
          type="button"
          onClick={() => {
            const ok = window.confirm(
              "Incluir senhas em TEXTO CLARO no arquivo exportado?\n\n" +
                "Útil pra backup/sync mas qualquer pessoa com acesso ao\n" +
                "arquivo verá as senhas. Recomendado só pra uso pessoal.",
            );
            if (ok) void exportAll(true);
          }}
          disabled={exporting}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-400 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          Exportar (com senhas)
        </button>
      </div>

      <button
        type="button"
        onClick={() => void runImport()}
        disabled={importing}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-conn-accent px-3 py-2 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        <Upload className="h-3.5 w-3.5" />
        Importar arquivo (.bmconn, .json, .ncx)
      </button>

      {msg && (
        <div
          className={cn(
            "rounded-md border p-2 text-xs",
            msg.kind === "ok"
              ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

function OptionRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
        selected
          ? "border-conn-accent bg-conn-accent/10"
          : "border-border hover:bg-accent",
      )}
    >
      {children}
      {selected && <Check className="h-4 w-4 text-conn-accent" />}
    </button>
  );
}
