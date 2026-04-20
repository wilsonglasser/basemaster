import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  User as UserIcon,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { Uuid, Value } from "@/lib/types";
import { useApproval } from "@/state/ai-approval";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";

interface Props {
  connectionId: Uuid;
}

interface UserRow {
  name: string;
  host?: string;
  /** PG: superuser/createdb. MySQL: locked. */
  flags: string[];
}

function valueText(v: Value): string {
  if (v.type === "null") return "";
  if (v.type === "bool") return String(v.value);
  if (v.type === "bytes") {
    // MySQL costuma devolver colunas de information_schema/mysql.user
    // como VARBINARY mesmo sendo texto — decodamos como UTF-8.
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(
        new Uint8Array(v.value),
      );
    } catch {
      return "";
    }
  }
  if ("value" in v) return String(v.value);
  return "";
}

function quoteIdent(driver: string | undefined, name: string): string {
  return driver === "postgres"
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, "``")}\``;
}
function quoteLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function UsersView({ connectionId }: Props) {
  const t = useT();
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );
  const connActive = useConnections((s) => s.active.has(connectionId));
  const openConn = useConnections((s) => s.open);
  const requestApproval = useApproval((s) => s.requestApproval);

  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!conn) return;
    setLoading(true);
    setError(null);
    try {
      if (!connActive) await openConn(connectionId);
      const isPg = conn.driver === "postgres";
      const sql = isPg
        ? "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb FROM pg_roles ORDER BY rolname"
        : "SELECT User, Host, account_locked FROM mysql.user ORDER BY User, Host";
      const batch = await ipc.db.runQuery(connectionId, sql, null);
      const first = batch.results[0];
      if (!first) throw new Error(t("users.noResult"));
      if (first.kind === "error") throw new Error(first.message);
      if (first.kind !== "select") throw new Error(t("users.unexpectedResult"));

      const rows: UserRow[] = first.rows.map((r) => {
        if (isPg) {
          const name = valueText(r[0]);
          const canLogin = valueText(r[1]) === "true";
          const superu = valueText(r[2]) === "true";
          const createdb = valueText(r[3]) === "true";
          const flags: string[] = [];
          if (superu) flags.push("SUPERUSER");
          if (createdb) flags.push("CREATEDB");
          if (!canLogin) flags.push("NOLOGIN");
          return { name, flags };
        }
        const name = valueText(r[0]);
        const host = valueText(r[1]);
        const locked = valueText(r[2]).toUpperCase() === "Y";
        const flags: string[] = [];
        if (locked) flags.push("LOCKED");
        return { name, host, flags };
      });
      setUsers(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [conn, connectionId, connActive, openConn]);

  useEffect(() => {
    void load();
  }, [load]);

  const createUser = async (
    name: string,
    password: string,
    host: string,
  ) => {
    if (!conn) return;
    const isPg = conn.driver === "postgres";
    const sql = isPg
      ? `CREATE ROLE ${quoteIdent("postgres", name)} LOGIN PASSWORD ${quoteLit(password)};`
      : `CREATE USER ${quoteLit(name)}@${quoteLit(host || "%")} IDENTIFIED BY ${quoteLit(password)};`;
    await requestApproval({
      kind: "sql",
      title: t("users.createTitle", { name }),
      description: t("users.createDesc"),
      sql,
    }).then((ok) => {
      if (!ok) throw new Error("user_denied");
    });
    await ipc.db.runQuery(connectionId, sql, null);
    await load();
  };

  const dropUser = async (u: UserRow) => {
    if (!conn) return;
    const isPg = conn.driver === "postgres";
    const sql = isPg
      ? `DROP ROLE ${quoteIdent("postgres", u.name)};`
      : `DROP USER ${quoteLit(u.name)}@${quoteLit(u.host ?? "%")};`;
    const ok = await requestApproval({
      kind: "sql",
      title: t("users.deleteTitle", {
        name: u.name,
        host: u.host ? `@${u.host}` : "",
      }),
      description: t("users.deleteDesc"),
      sql,
    });
    if (!ok) return;
    await ipc.db.runQuery(connectionId, sql, null);
    await load();
  };

  const changePassword = async (u: UserRow) => {
    if (!conn) return;
    const pw = window.prompt(t("users.newPasswordPrompt", { name: u.name }));
    if (!pw) return;
    const isPg = conn.driver === "postgres";
    const sql = isPg
      ? `ALTER ROLE ${quoteIdent("postgres", u.name)} WITH PASSWORD ${quoteLit(pw)};`
      : `ALTER USER ${quoteLit(u.name)}@${quoteLit(u.host ?? "%")} IDENTIFIED BY ${quoteLit(pw)};`;
    const ok = await requestApproval({
      kind: "sql",
      title: t("users.changePasswordTitle", { name: u.name }),
      description: t("users.changePasswordDesc"),
      sql,
    });
    if (!ok) return;
    await ipc.db.runQuery(connectionId, sql, null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 items-center gap-3 border-b border-border bg-card/30 px-3">
        <UserIcon className="h-4 w-4 text-conn-accent" />
        <span className="text-sm font-medium">{t("users.title")}</span>
        {conn && (
          <span className="text-xs text-muted-foreground">
            {conn.name} · {conn.driver}
          </span>
        )}

        <button
          type="button"
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-conn-accent px-2 py-1 text-[11px] text-conn-accent-foreground hover:opacity-90"
        >
          <Plus className="h-3 w-3" />
          {t("users.newUser")}
        </button>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          title={t("users.reload")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="h-3.5 w-3.5" />
              {error}
            </div>
          </div>
        ) : !users ? (
          <div className="grid h-full place-items-center text-xs text-muted-foreground">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "—"}
          </div>
        ) : users.length === 0 ? (
          <div className="grid h-full place-items-center text-xs italic text-muted-foreground">
            {t("users.noUsers")}
          </div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-card/90 backdrop-blur">
              <tr>
                <th className="border-b border-border px-3 py-1.5 text-left font-medium">
                  {t("users.colUser")}
                </th>
                {conn?.driver !== "postgres" && (
                  <th className="border-b border-border px-3 py-1.5 text-left font-medium">
                    {t("users.colHost")}
                  </th>
                )}
                <th className="border-b border-border px-3 py-1.5 text-left font-medium">
                  {t("users.colFlags")}
                </th>
                <th className="w-32 border-b border-border px-3 py-1.5 text-left font-medium">
                  {t("users.colActions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => (
                <tr key={`${u.name}@${u.host ?? ""}:${i}`} className="hover:bg-accent/30">
                  <td className="border-b border-border/40 px-3 py-1 font-medium">
                    {u.name}
                  </td>
                  {conn?.driver !== "postgres" && (
                    <td className="border-b border-border/40 px-3 py-1 font-mono text-[11px] text-muted-foreground">
                      {u.host}
                    </td>
                  )}
                  <td className="border-b border-border/40 px-3 py-1">
                    <div className="flex flex-wrap gap-1">
                      {u.flags.map((f) => (
                        <span
                          key={f}
                          className={cn(
                            "rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono",
                            f === "SUPERUSER" && "bg-amber-500/20 text-amber-600 dark:text-amber-400",
                            f === "LOCKED" && "bg-destructive/20 text-destructive",
                          )}
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="border-b border-border/40 px-3 py-1">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void changePassword(u)}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        title={t("users.changePassword")}
                      >
                        <Shield className="h-3 w-3" />
                        {t("users.passwordBtn")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void dropUser(u)}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                        title={t("users.deleteUser")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateUserDialog
          driver={conn?.driver ?? "mysql"}
          onClose={() => setCreating(false)}
          onCreate={async (name, pw, host) => {
            try {
              await createUser(name, pw, host);
              setCreating(false);
            } catch (e) {
              if (String(e).includes("user_denied")) {
                setCreating(false);
              } else {
                alert(t("users.failure", { error: String(e) }));
              }
            }
          }}
        />
      )}
    </div>
  );
}

function CreateUserDialog({
  driver,
  onClose,
  onCreate,
}: {
  driver: string;
  onClose: () => void;
  onCreate: (name: string, password: string, host: string) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("%");
  const [busy, setBusy] = useState(false);
  const isPg = driver === "postgres";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-border px-4 py-3 text-sm font-semibold">
          {t("users.dialogTitle")}
        </header>
        <div className="grid gap-3 px-4 py-4">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t("users.fieldName")}</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          {!isPg && (
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">{t("users.fieldHost")}</span>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t("users.fieldHostPlaceholder")}
                className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
              />
            </label>
          )}
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t("users.fieldPassword")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            {t("users.cancel")}
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!name.trim() || !password) return;
              setBusy(true);
              await onCreate(name.trim(), password, host.trim() || "%");
              setBusy(false);
            }}
            disabled={busy || !name.trim() || !password}
            className="rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t("users.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}
