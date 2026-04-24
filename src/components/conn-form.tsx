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
import type { ConnectionDraft, SshTunnelConfig, TlsMode, Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useTabs } from "@/state/tabs";

interface ConnFormProps {
  tabId: string;
  editingId?: Uuid;
}

type TestState = null | "loading" | "ok" | "err";

export function ConnForm({ tabId, editingId }: ConnFormProps) {
  const t = useT();
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

  // When the driver changes, adjust sensible defaults (port + user).
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
      // sqlite: clear fields that don't apply; host becomes file path.
      setSshEnabled(false);
    }
  };

  // SSH tunnel V2: password + private key. Secrets persist in the keyring.
  type SshAuthMethod = "password" | "key";
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState("");
  const [sshAuth, setSshAuth] = useState<SshAuthMethod>("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");

  // Jump hosts — optional chain traversed before the final SSH gateway.
  // Each hop mirrors SshTunnelConfig; secrets (password/passphrase) are
  // typed locally and shipped as one JSON blob to the backend.
  interface JumpHop {
    host: string;
    port: number;
    user: string;
    auth: SshAuthMethod;
    password: string;
    keyPath: string;
    keyPassphrase: string;
  }
  const [sshJumps, setSshJumps] = useState<JumpHop[]>([]);
  const newJump = (): JumpHop => ({
    host: "",
    port: 22,
    user: "",
    auth: "password",
    password: "",
    keyPath: "",
    keyPassphrase: "",
  });
  const updateJump = (idx: number, patch: Partial<JumpHop>) =>
    setSshJumps((xs) => xs.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  const removeJump = (idx: number) =>
    setSshJumps((xs) => xs.filter((_, i) => i !== idx));

  // HTTP CONNECT proxy — alternative transport for the DB socket.
  // Mutually exclusive with SSH on the backend.
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState(3128);
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");

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
        // Passwords/passphrases live in the keyring — empty placeholder
        // means "keep current value". User types to overwrite.
        setSshPassword("");
        setSshKeyPassphrase("");
      }
      if (p.http_proxy) {
        setProxyEnabled(true);
        setProxyHost(p.http_proxy.host);
        setProxyPort(p.http_proxy.port);
        setProxyUser(p.http_proxy.user ?? "");
        setProxyPassword("");
      }
      if (p.ssh_jump_hosts && p.ssh_jump_hosts.length > 0) {
        setSshJumps(
          p.ssh_jump_hosts.map((h): JumpHop => ({
            host: h.host,
            port: h.port,
            user: h.user,
            auth: h.private_key_path ? "key" : "password",
            password: "",
            keyPath: h.private_key_path ?? "",
            keyPassphrase: "",
          })),
        );
      }
    });
  }, [editingId]);

  useEffect(() => {
    const label =
      name.trim() ||
      (editingId ? t("connForm.editTitle") : t("sidebar.newConnection"));
    patchTab(tabId, { label, accentColor: color });
  }, [name, color, tabId, editingId, patchTab, t]);

  const jumpHostsPayload: SshTunnelConfig[] = sshEnabled
    ? sshJumps
        .filter((j) => j.host.trim() && j.user.trim())
        .map((j) => ({
          host: j.host.trim(),
          port: j.port,
          user: j.user.trim(),
          password: null,
          private_key_path:
            j.auth === "key" && j.keyPath.trim() ? j.keyPath.trim() : null,
          private_key_passphrase: null,
        }))
    : [];

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
            // The backend re-injects from the keyring on open if null.
            password: null,
            private_key_path:
              sshAuth === "key" && sshKeyPath.trim()
                ? sshKeyPath.trim()
                : null,
            private_key_passphrase: null,
          }
        : null,
    ssh_jump_hosts: jumpHostsPayload,
    http_proxy:
      proxyEnabled && proxyHost.trim()
        ? {
            host: proxyHost.trim(),
            port: proxyPort,
            user: proxyUser.trim() || null,
            // Password: null = keep keyring, backend re-injects.
            password: null,
          }
        : null,
  };

  // Secrets blob for the jump chain, aligned to jumpHostsPayload. On
  // create we always send (empty array if no jumps). On update: null =
  // keep keyring, empty string = clear, JSON string = overwrite. We send
  // JSON whenever the user typed anything; otherwise null (keep).
  const sshJumpsSecretsPayload: string | null = (() => {
    if (!sshEnabled || jumpHostsPayload.length === 0) {
      return editingId ? "" : null;
    }
    const anyTyped = sshJumps.some(
      (j) => j.password || j.keyPassphrase,
    );
    if (!editingId || anyTyped) {
      return JSON.stringify(
        sshJumps
          .filter((j) => j.host.trim() && j.user.trim())
          .map((j) => ({
            password: j.auth === "password" ? j.password || null : null,
            key_passphrase: j.auth === "key" ? j.keyPassphrase || null : null,
          })),
      );
    }
    return null;
  })();

  const valid =
    name.trim().length > 0 &&
    host.trim().length > 0 &&
    (driver === "sqlite" || user.trim().length > 0);

  // Convention for SSH secrets:
  // - create: send typed value (or null)
  // - update: null = leave keyring alone; "" = delete; "value" = overwrite
  const sshPwdPayload = sshEnabled && sshAuth === "password"
    ? (sshPassword || (editingId ? null : null))
    : (editingId ? "" : null);
  const sshKeyPassPayload = sshEnabled && sshAuth === "key"
    ? (sshKeyPassphrase || (editingId ? null : null))
    : (editingId ? "" : null);
  const proxyPwdPayload = proxyEnabled
    ? (proxyPassword || (editingId ? null : null))
    : (editingId ? "" : null);

  const handleTest = async () => {
    setTest("loading");
    setTestMsg(t("connForm.testing"));
    try {
      // Test uses the typed value directly (doesn't go through the keyring).
      const testJumpsBlob = sshEnabled && jumpHostsPayload.length > 0
        ? JSON.stringify(
            sshJumps
              .filter((j) => j.host.trim() && j.user.trim())
              .map((j) => ({
                password: j.auth === "password" ? j.password || null : null,
                key_passphrase: j.auth === "key" ? j.keyPassphrase || null : null,
              })),
          )
        : null;
      await ipc.connections.test(
        draft,
        password || null,
        sshEnabled && sshAuth === "password" ? sshPassword || null : null,
        sshEnabled && sshAuth === "key" ? sshKeyPassphrase || null : null,
        testJumpsBlob,
        proxyEnabled ? proxyPassword || null : null,
      );
      setTest("ok");
      setTestMsg(t("connForm.testOk"));
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
            sshJumpsSecretsPayload,
            proxyPwdPayload,
          )
        : await ipc.connections.create(
            draft,
            password || null,
            sshPwdPayload,
            sshKeyPassPayload,
            sshJumpsSecretsPayload,
            proxyPwdPayload,
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
            {editingId ? t("connForm.editTitle") : t("connForm.newTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("connForm.subtitle")}
          </p>
        </div>
      </header>

      <div className="grid gap-5">
        <Section title={t("connForm.sectionIdentity")}>
          <Field label={t("connForm.name")}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("connForm.namePlaceholder")}
              className={INPUT}
              autoFocus
            />
          </Field>
          <Field label={t("connForm.color")}>
            <ColorPicker value={color} onChange={setColor} />
          </Field>
        </Section>

        <Section title={t("connForm.sectionServer")}>
          <Field label={t("connForm.driver")}>
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
              <Field label={t("connForm.sqliteFile")}>
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
                    {t("connForm.choose")}
                  </button>
                </div>
              </Field>
              <Field
                label={
                  editingId
                    ? t("connForm.sqlitePasswordEdit")
                    : t("connForm.sqlitePasswordNew")
                }
              >
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("connForm.sqlitePasswordPlaceholder")}
                  className={INPUT}
                />
              </Field>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_140px] gap-3">
                <Field label={t("connForm.host")}>
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
                    placeholder={t("connForm.hostPlaceholder")}
                    className={INPUT}
                  />
                </Field>
                <Field label={t("connForm.port")}>
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
                <Field label={t("connForm.user")}>
                  <input
                    type="text"
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    className={INPUT}
                  />
                </Field>
                <Field
                  label={
                    editingId
                      ? t("connForm.passwordEdit")
                      : t("connForm.password")
                  }
                >
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={INPUT}
                  />
                </Field>
              </div>

              <Field label={t("connForm.defaultDb")}>
                <input
                  type="text"
                  value={defaultDb}
                  onChange={(e) => setDefaultDb(e.target.value)}
                  placeholder={t("connForm.defaultDbPlaceholder")}
                  className={INPUT}
                />
              </Field>

              <Field label={t("connForm.tls")}>
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
                          ? t("connForm.tlsOff")
                          : m === "preferred"
                            ? t("connForm.tlsPreferred")
                            : t("connForm.tlsRequired")}
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
          title={t("connForm.sectionSsh")}
          subtitle={sshEnabled ? undefined : t("connForm.optional")}
        >
          <label className="mb-3 inline-flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sshEnabled}
              onChange={(e) => setSshEnabled(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>{t("connForm.sshToggle")}</span>
          </label>
          {sshEnabled && (
            <>
              {/* Jump hosts (optional, ordered) ------------------------------ */}
              {sshJumps.length > 0 && (
                <div className="mb-2 grid gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("connForm.sshJumpsHeading")}
                  </div>
                  {sshJumps.map((hop, idx) => (
                    <div
                      key={idx}
                      className="grid gap-2 rounded-md border border-border bg-card p-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t("connForm.sshJumpIndex", { n: idx + 1 })}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeJump(idx)}
                          className="text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          {t("connForm.sshJumpRemove")}
                        </button>
                      </div>
                      <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
                        <input
                          type="text"
                          value={hop.host}
                          onChange={(e) =>
                            updateJump(idx, { host: e.target.value })
                          }
                          placeholder={t("connForm.sshHostPlaceholder")}
                          className={INPUT}
                        />
                        <input
                          type="number"
                          value={hop.port}
                          onChange={(e) =>
                            updateJump(idx, {
                              port: Number(e.target.value) || 22,
                            })
                          }
                          className="w-20 rounded-md border border-border bg-background px-2 py-2 text-sm"
                          min={1}
                          max={65535}
                        />
                        <input
                          type="text"
                          value={hop.user}
                          onChange={(e) =>
                            updateJump(idx, { user: e.target.value })
                          }
                          placeholder={t("connForm.sshUserPlaceholder")}
                          className={INPUT}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="inline-flex rounded-md border border-border p-0.5">
                          {(["password", "key"] as SshAuthMethod[]).map((m) => (
                            <button
                              type="button"
                              key={m}
                              onClick={() => updateJump(idx, { auth: m })}
                              className={cn(
                                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                                hop.auth === m
                                  ? "bg-conn-accent text-conn-accent-foreground"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {m === "password"
                                ? t("connForm.sshAuthPassword")
                                : t("connForm.sshAuthKey")}
                            </button>
                          ))}
                        </div>
                        {hop.auth === "password" ? (
                          <input
                            type="password"
                            value={hop.password}
                            onChange={(e) =>
                              updateJump(idx, { password: e.target.value })
                            }
                            placeholder={
                              editingId
                                ? t("connForm.sshPasswordKeepPlaceholder")
                                : "••••••••"
                            }
                            className="flex-1 rounded-md border border-border bg-background px-2 py-2 text-sm"
                          />
                        ) : (
                          <>
                            <input
                              type="text"
                              value={hop.keyPath}
                              onChange={(e) =>
                                updateJump(idx, { keyPath: e.target.value })
                              }
                              placeholder={t("connForm.sshKeyPlaceholder")}
                              className="flex-1 rounded-md border border-border bg-background px-2 py-2 font-mono text-[11px]"
                            />
                            <input
                              type="password"
                              value={hop.keyPassphrase}
                              onChange={(e) =>
                                updateJump(idx, {
                                  keyPassphrase: e.target.value,
                                })
                              }
                              placeholder={t("connForm.passphrase")}
                              className="w-40 rounded-md border border-border bg-background px-2 py-2 text-sm"
                            />
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setSshJumps((xs) => [...xs, newJump()])}
                className="mb-1 self-start rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {t("connForm.sshJumpAdd")}
              </button>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label={t("connForm.sshHost")}>
                  <input
                    type="text"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder={t("connForm.sshHostPlaceholder")}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                  />
                </Field>
                <Field label={t("connForm.port")}>
                  <input
                    type="number"
                    value={sshPort}
                    onChange={(e) => setSshPort(Number(e.target.value) || 22)}
                    className="w-24 rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                  />
                </Field>
              </div>
              <Field label={t("connForm.sshUser")}>
                <input
                  type="text"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  placeholder={t("connForm.sshUserPlaceholder")}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                />
              </Field>
              <Field label={t("connForm.sshAuth")}>
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
                      {m === "password"
                        ? t("connForm.sshAuthPassword")
                        : t("connForm.sshAuthKey")}
                    </button>
                  ))}
                </div>
              </Field>
              {sshAuth === "password" ? (
                <Field label={t("connForm.sshPassword")}>
                  <input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={
                      editingId
                        ? t("connForm.sshPasswordKeepPlaceholder")
                        : "••••••••"
                    }
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                  />
                </Field>
              ) : (
                <>
                  <Field label={t("connForm.sshKeyPath")}>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder={t("connForm.sshKeyPlaceholder")}
                        className="flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const picked = await openDialog({
                              multiple: false,
                              directory: false,
                              title: t("connForm.pickKeyTitle"),
                              filters: [
                                {
                                  name: t("connForm.keyFilter"),
                                  extensions: ["", "pem", "key", "ppk"],
                                },
                                {
                                  name: t("connForm.allFilesFilter"),
                                  extensions: ["*"],
                                },
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
                        title={t("connForm.browseTitle")}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        {t("connForm.browse")}
                      </button>
                    </div>
                  </Field>
                  <Field label={t("connForm.passphrase")}>
                    <input
                      type="password"
                      value={sshKeyPassphrase}
                      onChange={(e) => setSshKeyPassphrase(e.target.value)}
                      placeholder={
                        editingId
                          ? t("connForm.passphraseKeepPlaceholder")
                          : t("connForm.passphraseNewPlaceholder")
                      }
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                    />
                  </Field>
                </>
              )}
              <div className="text-[11px] text-muted-foreground">
                {t("connForm.sshNote")}
              </div>
            </>
          )}
        </Section>
        )}

        {driver !== "sqlite" && (
        <Section
          title={t("connForm.sectionProxy")}
          subtitle={proxyEnabled ? undefined : t("connForm.optional")}
        >
          <label className="mb-3 inline-flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={proxyEnabled}
              onChange={(e) => setProxyEnabled(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>{t("connForm.proxyToggle")}</span>
          </label>
          {proxyEnabled && (
            <>
              {sshEnabled && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                  {t("connForm.proxyAndSshConflict")}
                </div>
              )}
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label={t("connForm.proxyHost")}>
                  <input
                    type="text"
                    value={proxyHost}
                    onChange={(e) => setProxyHost(e.target.value)}
                    placeholder={t("connForm.proxyHostPlaceholder")}
                    className={INPUT}
                  />
                </Field>
                <Field label={t("connForm.port")}>
                  <input
                    type="number"
                    value={proxyPort}
                    onChange={(e) =>
                      setProxyPort(Number(e.target.value) || 3128)
                    }
                    className="w-24 rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
                  />
                </Field>
              </div>
              <Field label={t("connForm.proxyUser")}>
                <input
                  type="text"
                  value={proxyUser}
                  onChange={(e) => setProxyUser(e.target.value)}
                  placeholder={t("connForm.proxyUserPlaceholder")}
                  className={INPUT}
                />
              </Field>
              <Field label={t("connForm.proxyPassword")}>
                <input
                  type="password"
                  value={proxyPassword}
                  onChange={(e) => setProxyPassword(e.target.value)}
                  placeholder={
                    editingId
                      ? t("connForm.proxyPasswordKeepPlaceholder")
                      : "••••••••"
                  }
                  className={INPUT}
                />
              </Field>
              <div className="text-[11px] text-muted-foreground">
                {t("connForm.proxyNote")}
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
          {t("connForm.cancel")}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={!valid || test === "loading"}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("connForm.test")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!valid || saving}
          className="rounded-md bg-conn-accent px-4 py-2 text-sm font-medium text-conn-accent-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving
            ? t("connForm.saving")
            : editingId
              ? t("connForm.saveEdit")
              : t("connForm.saveNew")}
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
    <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
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
  const t = useT();
  const colorInputRef = useRef<HTMLInputElement>(null);
  // A value that doesn't match any preset is a custom color — shown
  // as an active swatch with the "custom" icon.
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
      {/* Custom color preview — only shown when one is active. */}
      {customValue && (
        <button
          type="button"
          onClick={() => colorInputRef.current?.click()}
          className="h-7 w-7 scale-110 rounded-md border-2 border-foreground"
          style={{ backgroundColor: customValue }}
          title={t("connForm.customColorTitle", { hex: customValue })}
        />
      )}
      {/* "Other color" button — opens the OS-native picker. */}
      <button
        type="button"
        onClick={() => colorInputRef.current?.click()}
        className={cn(
          "relative grid h-7 w-7 place-items-center overflow-hidden rounded-md border-2 border-border hover:bg-accent",
        )}
        title={t("connForm.otherColor")}
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
        title={t("connForm.noColor")}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
