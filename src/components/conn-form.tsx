import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FolderOpen,
  Loader2,
  Pipette,
  Plug,
  X,
} from "lucide-react";

import { CONN_COLORS, ipc } from "@/lib/ipc";
import { parseDsn } from "@/lib/dsn";
import type { ConnectionDraft, TlsMode, Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useTabs } from "@/state/tabs";

interface ConnFormProps {
  tabId: string;
  editingId?: Uuid;
}

type TestState = null | "loading" | "ok" | "err";

export function ConnForm({ tabId, editingId }: ConnFormProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(CONN_COLORS[0].hex);
  const [driver, setDriver] = useState<
    "mysql" | "mariadb" | "postgres" | "sqlite"
  >("mysql");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(3306);
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [defaultDb, setDefaultDb] = useState("");
  const [tls, setTls] = useState<TlsMode>("preferred");

  // Quando troca de driver, ajusta defaults sensíveis (porta + user).
  const handleDriverChange = (
    next: "mysql" | "mariadb" | "postgres" | "sqlite",
  ) => {
    setDriver(next);
    if (next === "postgres") {
      if (port === 3306) setPort(5432);
      if (user === "root") setUser("postgres");
    } else if (next === "mysql" || next === "mariadb") {
      if (port === 5432) setPort(3306);
      if (user === "postgres") setUser("root");
    } else {
      // sqlite: zera campos que não se aplicam; host vira file path.
      setSshEnabled(false);
    }
  };

  // SSH tunnel V2: password + private key. Secrets persistem no keyring.
  type SshAuthMethod = "password" | "key";
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState("");
  const [sshAuth, setSshAuth] = useState<SshAuthMethod>("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");

  const [test, setTest] = useState<TestState>(null);
  const [testMsg, setTestMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const upsertLocal = useConnections((s) => s.upsertLocal);
  const refresh = useConnections((s) => s.refresh);
  const closeTab = useTabs((s) => s.close);
  const patchTab = useTabs((s) => s.patch);

  useEffect(() => {
    if (!editingId) return;
    ipc.connections.get(editingId).then((p) => {
      setName(p.name);
      setColor(p.color);
      setDriver(
        p.driver === "postgres"
          ? "postgres"
          : p.driver === "sqlite"
            ? "sqlite"
            : p.driver === "mariadb"
              ? "mariadb"
              : "mysql",
      );
      setHost(p.host);
      setPort(p.port);
      setUser(p.user);
      setDefaultDb(p.default_database ?? "");
      setTls(p.tls);
      if (p.ssh_tunnel) {
        setSshEnabled(true);
        setSshHost(p.ssh_tunnel.host);
        setSshPort(p.ssh_tunnel.port);
        setSshUser(p.ssh_tunnel.user);
        const keyPath = p.ssh_tunnel.private_key_path ?? "";
        setSshKeyPath(keyPath);
        setSshAuth(keyPath ? "key" : "password");
        // Senhas/passphrases ficam no keyring — placeholder em branco
        // indica "manter valor atual". Usuário digita pra sobrescrever.
        setSshPassword("");
        setSshKeyPassphrase("");
      }
    });
  }, [editingId]);

  useEffect(() => {
    const label = name.trim() || (editingId ? "Editar conexão" : "Nova conexão");
    patchTab(tabId, { label, accentColor: color });
  }, [name, color, tabId, editingId, patchTab]);

  const draft: ConnectionDraft = {
    name: name.trim(),
    color,
    driver,
    host: host.trim(),
    port,
    user: user.trim(),
    default_database: defaultDb.trim() || null,
    tls,
    ssh_tunnel:
      sshEnabled && sshHost.trim() && sshUser.trim()
        ? {
            host: sshHost.trim(),
            port: sshPort,
            user: sshUser.trim(),
            // O backend re-injeta do keyring no open se vier null.
            password: null,
            private_key_path:
              sshAuth === "key" && sshKeyPath.trim()
                ? sshKeyPath.trim()
                : null,
            private_key_passphrase: null,
          }
        : null,
  };

  const valid =
    name.trim().length > 0 &&
    host.trim().length > 0 &&
    (driver === "sqlite" || user.trim().length > 0);

  // Convenção pros secrets SSH:
  // - create: manda valor digitado (ou null)
  // - update: null = não mexe no keyring; "" = apaga; "valor" = sobrescreve
  const sshPwdPayload = sshEnabled && sshAuth === "password"
    ? (sshPassword || (editingId ? null : null))
    : (editingId ? "" : null);
  const sshKeyPassPayload = sshEnabled && sshAuth === "key"
    ? (sshKeyPassphrase || (editingId ? null : null))
    : (editingId ? "" : null);

  const handleTest = async () => {
    setTest("loading");
    setTestMsg("Testando…");
    try {
      // Teste usa o valor digitado direto (não passa pelo keyring).
      await ipc.connections.test(
        draft,
        password || null,
        sshEnabled && sshAuth === "password" ? sshPassword || null : null,
        sshEnabled && sshAuth === "key" ? sshKeyPassphrase || null : null,
      );
      setTest("ok");
      setTestMsg("Conectou e respondeu ao ping.");
    } catch (e) {
      setTest("err");
      setTestMsg(String(e));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const profile = editingId
        ? await ipc.connections.update(
            editingId,
            draft,
            password || null,
            sshPwdPayload,
            sshKeyPassPayload,
          )
        : await ipc.connections.create(
            draft,
            password || null,
            sshPwdPayload,
            sshKeyPassPayload,
          );
      upsertLocal(profile);
      await refresh();
      closeTab(tabId);
    } catch (e) {
      setTest("err");
      setTestMsg(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-8 py-8">
      <header className="mb-8 flex items-center gap-3">
        <div
          className="grid h-10 w-10 place-items-center rounded-lg text-white shadow-sm"
          style={{ backgroundColor: color ?? "var(--conn-accent)" }}
        >
          <Plug className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {editingId ? "Editar conexão" : "Nova conexão MySQL"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Senha vai pro Windows Credential Manager.
          </p>
        </div>
      </header>

      <div className="grid gap-5">
        <Section title="Identidade">
          <Field label="Nome">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Local — Sis Regional"
              className={INPUT}
              autoFocus
            />
          </Field>
          <Field label="Cor">
            <ColorPicker value={color} onChange={setColor} />
          </Field>
        </Section>

        <Section title="Servidor">
          <Field label="Driver">
            <div className="inline-flex rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => handleDriverChange("mysql")}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded",
                  driver === "mysql"
                    ? "bg-conn-accent text-conn-accent-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                MySQL
              </button>
              <button
                type="button"
                onClick={() => handleDriverChange("mariadb")}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded",
                  driver === "mariadb"
                    ? "bg-conn-accent text-conn-accent-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                MariaDB
              </button>
              <button
                type="button"
                onClick={() => handleDriverChange("postgres")}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded",
                  driver === "postgres"
                    ? "bg-conn-accent text-conn-accent-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                PostgreSQL
              </button>
              <button
                type="button"
                onClick={() => handleDriverChange("sqlite")}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded",
                  driver === "sqlite"
                    ? "bg-conn-accent text-conn-accent-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                SQLite
              </button>
            </div>
          </Field>
          {driver === "sqlite" ? (
            <>
              <Field label="Arquivo do banco">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="C:\path\to\db.sqlite"
                    className={INPUT}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const p = await openDialog({
                        multiple: false,
                        directory: false,
                        filters: [
                          {
                            name: "SQLite",
                            extensions: [
                              "sqlite",
                              "sqlite3",
                              "db",
                              "db3",
                            ],
                          },
                        ],
                      });
                      if (p && !Array.isArray(p)) setHost(p);
                    }}
                    className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    Escolher…
                  </button>
                </div>
              </Field>
              <Field
                label={
                  editingId
                    ? "Senha (SQLCipher — em branco mantém atual)"
                    : "Senha (SQLCipher — opcional)"
                }
              >
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="deixe em branco se não criptografado"
                  className={INPUT}
                />
              </Field>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_140px] gap-3">
                <Field label="Host">
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => {
                      const v = e.target.value;
                      const parsed = parseDsn(v);
                      if (parsed) {
                        setDriver(parsed.driver);
                        setHost(parsed.host);
                        setPort(parsed.port);
                        if (parsed.user) setUser(parsed.user);
                        if (parsed.password) setPassword(parsed.password);
                        if (parsed.database) setDefaultDb(parsed.database);
                        return;
                      }
                      setHost(v);
                    }}
                    placeholder="localhost ou postgres://user:pass@host:port/db"
                    className={INPUT}
                  />
                </Field>
                <Field label="Porta">
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    className={INPUT}
                    min={1}
                    max={65535}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Usuário">
                  <input
                    type="text"
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    className={INPUT}
                  />
                </Field>
                <Field
                  label={editingId ? "Senha (em branco mantém atual)" : "Senha"}
                >
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={INPUT}
                  />
                </Field>
              </div>

              <Field label="Banco padrão (opcional)">
                <input
                  type="text"
                  value={defaultDb}
                  onChange={(e) => setDefaultDb(e.target.value)}
                  placeholder="ex.: sis_regional"
                  className={INPUT}
                />
              </Field>

              <Field label="TLS">
                <div className="inline-flex items-stretch rounded-md border border-border p-0.5">
                  {(["disabled", "preferred", "required"] as TlsMode[]).map(
                    (m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setTls(m)}
                        className={cn(
                          "rounded px-3 py-1 text-xs font-medium transition-colors",
                          tls === m
                            ? "bg-conn-accent text-conn-accent-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {m === "disabled"
                          ? "Off"
                          : m === "preferred"
                            ? "Preferred"
                            : "Required"}
                      </button>
                    ),
                  )}
                </div>
              </Field>
            </>
          )}
        </Section>

        {driver !== "sqlite" && (
        <Section
          title="SSH Tunnel"
          subtitle={sshEnabled ? undefined : "opcional"}
        >
          <label className="mb-3 inline-flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sshEnabled}
              onChange={(e) => setSshEnabled(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>Conectar via SSH tunnel</span>
          </label>
          {sshEnabled && (
            <>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label="SSH host">
                  <input
                    type="text"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="ssh.example.com"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                  />
                </Field>
                <Field label="Porta">
                  <input
                    type="number"
                    value={sshPort}
                    onChange={(e) => setSshPort(Number(e.target.value) || 22)}
                    className="w-24 rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                  />
                </Field>
              </div>
              <Field label="SSH user">
                <input
                  type="text"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  placeholder="ubuntu"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                />
              </Field>
              <Field label="Autenticação">
                <div className="inline-flex rounded-md border border-border p-0.5">
                  {(["password", "key"] as const).map((m) => (
                    <button
                      type="button"
                      key={m}
                      onClick={() => setSshAuth(m)}
                      className={cn(
                        "rounded px-3 py-1 text-xs font-medium transition-colors",
                        sshAuth === m
                          ? "bg-conn-accent text-conn-accent-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m === "password" ? "Password" : "Private key"}
                    </button>
                  ))}
                </div>
              </Field>
              {sshAuth === "password" ? (
                <Field label="SSH password">
                  <input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={
                      editingId ? "(manter atual — digite pra mudar)" : "••••••••"
                    }
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                  />
                </Field>
              ) : (
                <>
                  <Field label="Private key path">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder="C:\Users\you\.ssh\id_rsa"
                        className="flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const picked = await openDialog({
                              multiple: false,
                              directory: false,
                              title: "Selecione a chave privada SSH",
                              filters: [
                                {
                                  name: "Chave privada",
                                  extensions: ["", "pem", "key", "ppk"],
                                },
                                { name: "Todos os arquivos", extensions: ["*"] },
                              ],
                            });
                            if (typeof picked === "string" && picked) {
                              setSshKeyPath(picked);
                            }
                          } catch (e) {
                            console.error("pick key:", e);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        title="Escolher arquivo"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        Procurar
                      </button>
                    </div>
                  </Field>
                  <Field label="Passphrase (opcional)">
                    <input
                      type="password"
                      value={sshKeyPassphrase}
                      onChange={(e) => setSshKeyPassphrase(e.target.value)}
                      placeholder={
                        editingId
                          ? "(manter atual — digite pra mudar)"
                          : "em branco se a chave não tiver"
                      }
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                    />
                  </Field>
                </>
              )}
              <div className="text-[11px] text-muted-foreground">
                Secrets SSH vão pro keyring do SO (Credential Manager no Windows).
                Host key atualmente é aceito sem verificação (V3 adicionará known_hosts).
              </div>
            </>
          )}
        </Section>
        )}
      </div>

      {test && (
        <div
          className={cn(
            "mt-6 flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            test === "ok" &&
              "border-emerald-500/30 bg-emerald-500/5 text-emerald-400",
            test === "err" &&
              "border-destructive/30 bg-destructive/5 text-destructive",
            test === "loading" && "border-border bg-card text-muted-foreground",
          )}
        >
          {test === "ok" && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
          {test === "err" && <X className="mt-0.5 h-4 w-4 shrink-0" />}
          {test === "loading" && (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          )}
          <div className="flex-1 break-words font-mono text-[12px] leading-relaxed">
            {testMsg}
          </div>
        </div>
      )}

      <footer className="mt-8 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => closeTab(tabId)}
          className="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={!valid || test === "loading"}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Testar
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!valid || saving}
          className="rounded-md bg-conn-accent px-4 py-2 text-sm font-medium text-conn-accent-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Salvando…" : editingId ? "Salvar alterações" : "Criar conexão"}
        </button>
      </footer>
    </div>
  );
}

const INPUT = cn(
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm",
  "placeholder:text-muted-foreground/60",
  "focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40",
);

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/40 p-5">
      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
        {subtitle && (
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            · {subtitle}
          </span>
        )}
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (hex: string | null) => void;
}) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  // Value que não bate com nenhum preset é uma cor custom — mostra
  // como swatch ativo com o ícone "custom".
  const isPreset =
    value != null && CONN_COLORS.some((c) => c.hex === value);
  const customValue = !isPreset && value != null ? value : null;

  return (
    <div className="flex items-center gap-1.5">
      {CONN_COLORS.map((c) => (
        <button
          key={c.hex}
          type="button"
          onClick={() => onChange(c.hex)}
          className={cn(
            "h-7 w-7 rounded-md border-2 transition-transform",
            value === c.hex
              ? "scale-110 border-foreground"
              : "border-transparent hover:scale-105",
          )}
          style={{ backgroundColor: c.hex }}
          title={c.name}
        />
      ))}
      {/* Preview da cor custom — só aparece quando tem uma ativa. */}
      {customValue && (
        <button
          type="button"
          onClick={() => colorInputRef.current?.click()}
          className="h-7 w-7 scale-110 rounded-md border-2 border-foreground"
          style={{ backgroundColor: customValue }}
          title={`Custom · ${customValue}`}
        />
      )}
      {/* Botão "outra cor" — abre o picker nativo do SO. */}
      <button
        type="button"
        onClick={() => colorInputRef.current?.click()}
        className={cn(
          "relative grid h-7 w-7 place-items-center overflow-hidden rounded-md border-2 border-border hover:bg-accent",
        )}
        title="Outra cor"
      >
        <Pipette className="h-3.5 w-3.5 text-muted-foreground" />
        <span
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1"
          style={{
            background:
              "linear-gradient(90deg, #ef4444, #f59e0b, #22c55e, #06b6d4, #8b5cf6)",
          }}
          aria-hidden
        />
      </button>
      <input
        ref={colorInputRef}
        type="color"
        value={value ?? "#3b82f6"}
        onChange={(e) => onChange(e.target.value)}
        className="pointer-events-none absolute h-0 w-0 opacity-0"
        tabIndex={-1}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md border-2 text-muted-foreground",
          value === null
            ? "border-foreground"
            : "border-border hover:bg-accent",
        )}
        title="Sem cor"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
