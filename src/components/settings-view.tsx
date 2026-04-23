import { Check, ChevronDown, Copy, Download, ExternalLink, Eye, EyeOff, Keyboard, Monitor, Moon, Palette, Plug, Server, Sparkles, Sun, Upload } from "lucide-react";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { MODEL_CATALOG, parseModelKey, providerMeta, PROVIDERS, type ProviderId } from "@/lib/ai/catalog";
import { ShortcutsPanel } from "@/components/shortcuts-panel";
import { useAiAgent } from "@/state/ai-agent";
import { appConfirm } from "@/state/app-dialog";
import { useI18n, useT, type Lang, type TKey } from "@/state/i18n";
import { DARK_PRESETS, LIGHT_PRESETS, useTheme } from "@/state/theme";
import { ipc } from "@/lib/ipc";
import type { McpStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const LANGS: Array<{ value: Lang; label: string; flag: string }> = [
  { value: "pt-BR", label: "Português (Brasil)", flag: "🇧🇷" },
  { value: "en", label: "English", flag: "🇺🇸" },
];

type TabId = "appearance" | "ai" | "mcp" | "connections" | "shortcuts";

const TABS: Array<{ id: TabId; labelKey: TKey; icon: React.ReactNode }> = [
  { id: "appearance", labelKey: "settingsNav.appearance", icon: <Palette className="h-4 w-4" /> },
  { id: "ai", labelKey: "settingsNav.ai", icon: <Sparkles className="h-4 w-4" /> },
  { id: "mcp", labelKey: "settingsNav.mcp", icon: <Server className="h-4 w-4" /> },
  { id: "connections", labelKey: "settingsNav.connections", icon: <Plug className="h-4 w-4" /> },
  { id: "shortcuts", labelKey: "settingsNav.shortcuts", icon: <Keyboard className="h-4 w-4" /> },
];

export function SettingsView() {
  const t = useT();
  const [tab, setTab] = useState<TabId>("appearance");
  const active = TABS.find((x) => x.id === tab) ?? TABS[0];

  return (
    <div className="flex h-full overflow-hidden">
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar px-2 py-4">
        <h1 className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("sidebar.settings")}
        </h1>
        {TABS.map(({ id, labelKey, icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
              tab === id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <span className="grid h-4 w-4 place-items-center">{icon}</span>
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-8 py-8">
          <h2 className="mb-6 flex items-center gap-2 text-lg font-semibold">
            {active.icon}
            {t(active.labelKey)}
          </h2>
          {tab === "appearance" && <AppearancePanel />}
          {tab === "ai" && <AiAgentPanel />}
          {tab === "mcp" && <McpPanel />}
          {tab === "connections" && <ConnectionsPortabilityPanel />}
          {tab === "shortcuts" && <ShortcutsPanel />}
        </div>
      </main>
    </div>
  );
}

function AppearancePanel() {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);

  const toggle = useTheme((s) => s.toggle);
  const setToggle = useTheme((s) => s.setToggle);
  const darkPreset = useTheme((s) => s.darkPreset);
  const lightPreset = useTheme((s) => s.lightPreset);
  const setDarkPreset = useTheme((s) => s.setDarkPreset);
  const setLightPreset = useTheme((s) => s.setLightPreset);
  const customDarkBg = useTheme((s) => s.customDarkBg);
  const customLightBg = useTheme((s) => s.customLightBg);
  const setCustomDarkBg = useTheme((s) => s.setCustomDarkBg);
  const setCustomLightBg = useTheme((s) => s.setCustomLightBg);

  return (
    <div className="flex flex-col gap-8">
      {/* Language */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("appearance.language")}
        </h3>
        <div className="grid gap-1">
          {LANGS.map((l) => (
            <OptionRow
              key={l.value}
              selected={l.value === lang}
              onClick={() => setLang(l.value)}
            >
              <span className="text-lg leading-none">{l.flag}</span>
              <span className="flex-1 text-sm">{l.label}</span>
              <code className="text-[10px] text-muted-foreground">{l.value}</code>
            </OptionRow>
          ))}
        </div>
      </div>

      {/* Mode (system / light / dark) */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("appearance.mode")}
        </h3>
        <div className="grid grid-cols-3 gap-2">
          <ModeButton
            active={toggle === "system"}
            onClick={() => setToggle("system")}
            icon={<Monitor className="h-4 w-4" />}
            label={t("appearance.modeSystem")}
          />
          <ModeButton
            active={toggle === "light"}
            onClick={() => setToggle("light")}
            icon={<Sun className="h-4 w-4" />}
            label={t("appearance.modeLight")}
          />
          <ModeButton
            active={toggle === "dark"}
            onClick={() => setToggle("dark")}
            icon={<Moon className="h-4 w-4" />}
            label={t("appearance.modeDark")}
          />
        </div>
      </div>

      {/* Dark flavor */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("appearance.darkFlavor")}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {DARK_PRESETS.map((p) => (
            <PresetCard
              key={p.id}
              active={darkPreset === p.id}
              onClick={() => setDarkPreset(p.id)}
              name={p.name}
              tokens={p.tokens}
            />
          ))}
          <PresetCard
            active={darkPreset === "custom-dark"}
            onClick={() => setDarkPreset("custom-dark")}
            name={t("appearance.presetCustomDark")}
            tokens={null}
            customHex={customDarkBg}
          />
        </div>
        {darkPreset === "custom-dark" && (
          <CustomColorRow
            label={t("appearance.customBase")}
            value={customDarkBg}
            onChange={setCustomDarkBg}
          />
        )}
      </div>

      {/* Light flavor */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("appearance.lightFlavor")}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {LIGHT_PRESETS.map((p) => (
            <PresetCard
              key={p.id}
              active={lightPreset === p.id}
              onClick={() => setLightPreset(p.id)}
              name={p.name}
              tokens={p.tokens}
            />
          ))}
          <PresetCard
            active={lightPreset === "custom-light"}
            onClick={() => setLightPreset("custom-light")}
            name={t("appearance.presetCustomLight")}
            tokens={null}
            customHex={customLightBg}
          />
        </div>
        {lightPreset === "custom-light" && (
          <CustomColorRow
            label={t("appearance.customBase")}
            value={customLightBg}
            onChange={setCustomLightBg}
          />
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 rounded-md border px-4 py-3 text-sm transition-colors",
        active
          ? "border-conn-accent bg-conn-accent/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PresetCard({
  active,
  onClick,
  name,
  tokens,
  customHex,
}: {
  active: boolean;
  onClick: () => void;
  name: string;
  tokens: {
    background: string;
    foreground: string;
    card: string;
    connAccent: string;
  } | null;
  customHex?: string;
}) {
  // Swatch with samples of the 4 main tokens. For custom-*, uses the
  // hex for bg and derives an accent (doesn't pull the full preset here
  // to avoid heavy computation on every card render).
  const bg = tokens?.background ?? customHex ?? "#888";
  const fg = tokens?.foreground ?? (customHex && isDark(customHex) ? "#eee" : "#222");
  const accent = tokens?.connAccent ?? "oklch(0.6 0.15 250)";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex flex-col gap-2 rounded-md border p-3 text-left transition-colors",
        active
          ? "border-conn-accent ring-1 ring-conn-accent/40"
          : "border-border hover:bg-accent/30",
      )}
    >
      <div
        className="flex h-16 items-center justify-between gap-2 rounded-sm border border-border/60 px-2 py-1.5"
        style={{ background: bg, color: fg }}
      >
        <span className="font-mono text-[11px]">Aa</span>
        <span
          className="h-3 w-3 rounded-full"
          style={{ background: accent }}
        />
      </div>
      <span className="text-xs font-medium">{name}</span>
      {active && (
        <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-conn-accent" />
      )}
    </button>
  );
}

function CustomColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="mt-3 flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
      />
      <code className="font-mono text-xs">{value}</code>
    </label>
  );
}

function isDark(hex: string): boolean {
  const s = hex.replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Approximate luma (Rec. 709) — only to decide if contrast needs light or dark fg.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}


function AiAgentPanel() {
  const t = useT();
  const apiKeys = useAiAgent((s) => s.apiKeys);
  const setApiKey = useAiAgent((s) => s.setApiKey);
  const modelSel = useAiAgent((s) => s.modelKey);
  const setModelKey = useAiAgent((s) => s.setModelKey);

  // Which provider is being edited — default: the one of the current model.
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
        {t("settings.ai.intro")}
      </p>

      {/* Provider selector — select único */}
      <div className="grid gap-1.5">
        <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("settings.ai.providerLabel")}
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
            {t("settings.ai.getKey")} <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <ApiKeyInput
          value={keyValue}
          placeholder={meta.keyPlaceholder}
          onSave={(k) => setApiKey(activeProvider, k)}
        />

        <div className="mt-3">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("settings.ai.modelIdLabel")}
          </label>
          <ModelCombobox
            provider={activeProvider}
            value={modelDraft}
            onChange={setModelDraft}
            onCommit={commitModel}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("settings.ai.modelHint")}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t("settings.ai.activeModel")}</span>
        <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono">
          {modelSel || t("settings.ai.none")}
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
  const t = useT();
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
        title={show ? t("common.hide") : t("common.show")}
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
        {saved ? <Check className="h-3.5 w-3.5 text-conn-accent" /> : t("common.save")}
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
  const t = useT();
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
          placeholder={t("settings.ai.modelPlaceholder")}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded-md border border-border px-2 py-1.5 text-muted-foreground hover:bg-accent"
          title={t("settings.ai.suggestions")}
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
          {t("settings.ai.use")}
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
  const t = useT();
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
        {t("settings.mcp.intro")}
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
          {running ? t("settings.mcp.stop") : t("settings.mcp.start")}
        </button>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("settings.mcp.port")}
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
          {running ? t("common.running") : t("common.stopped")}
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
              {t("settings.mcp.urlLabel")}
            </span>
            <code className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
              {url}
            </code>
          </div>

          <div className="grid gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("settings.mcp.tokenLabel")}
            </span>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                {token}
              </code>
              <button
                type="button"
                onClick={() => copy(token, "token")}
                className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent"
                title={t("settings.mcp.copyToken")}
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
                {t("settings.mcp.configLabel")}
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
                {t("settings.mcp.copyInline")}
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
  const t = useT();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const exportAll = async (includePasswords: boolean) => {
    setExporting(true);
    setMsg(null);
    try {
      const payload = await ipc.portability.export(includePasswords);
      const path = await saveDialog({
        defaultPath: t("settings.portability.defaultFilename", {
          date: new Date().toISOString().slice(0, 10),
        }),
        filters: [{ name: "BaseMaster", extensions: ["bmconn", "json"] }],
      });
      if (!path) return;
      const json = JSON.stringify(payload, null, 2);
      const bytes = new TextEncoder().encode(json);
      await invoke("save_file", { path, data: Array.from(bytes) });
      setMsg({
        kind: "ok",
        text: t("settings.portability.exported", {
          count: payload.connections.length,
          path,
        }),
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
            name: t("settings.portability.filterName"),
            extensions: ["bmconn", "json", "ncx", "xml"],
          },
        ],
      });
      if (!path || Array.isArray(path)) return;
      const payload = await ipc.portability.importParse(path);
      const count = payload.connections.length;
      if (count === 0) {
        setMsg({ kind: "err", text: t("settings.portability.noConnections") });
        return;
      }
      const folders = payload.folders.length
        ? t("settings.portability.foldersSuffix", { n: payload.folders.length })
        : "";
      const ok = await appConfirm(
        t("settings.portability.confirmImport", { count, folders }),
      );
      if (!ok) return;
      const applied = await ipc.portability.importApply(payload);
      setMsg({
        kind: "ok",
        text: t("settings.portability.imported", { count: applied }),
      });
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
        {t("settings.portability.intro", { bmconn: ".bmconn", ncx: ".ncx" })}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void exportAll(false)}
          disabled={exporting}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs hover:bg-accent disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {t("settings.portability.exportNoPasswords")}
        </button>
        <button
          type="button"
          onClick={async () => {
            const ok = await appConfirm(t("settings.portability.confirmPasswords"));
            if (ok) void exportAll(true);
          }}
          disabled={exporting}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-400 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {t("settings.portability.exportWithPasswords")}
        </button>
      </div>

      <button
        type="button"
        onClick={() => void runImport()}
        disabled={importing}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-conn-accent px-3 py-2 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        <Upload className="h-3.5 w-3.5" />
        {t("settings.portability.importFile")}
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
