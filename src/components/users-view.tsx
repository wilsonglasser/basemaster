import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  KeyRound,
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
import { appPrompt } from "@/state/app-dialog";
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

// MySQL privileges válidos ON *.* (server-wide).
const MYSQL_GLOBAL_PRIVS = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "INDEX", "ALTER",
  "CREATE TEMPORARY TABLES", "LOCK TABLES", "REFERENCES", "CREATE VIEW",
  "SHOW VIEW", "CREATE ROUTINE", "ALTER ROUTINE", "EXECUTE", "EVENT", "TRIGGER",
  "RELOAD", "SHUTDOWN", "PROCESS", "FILE", "SHOW DATABASES", "SUPER",
  "REPLICATION SLAVE", "REPLICATION CLIENT", "CREATE USER", "CREATE TABLESPACE",
  "GRANT OPTION",
] as const;

// Subconjunto que faz sentido ON `db`.* (sem privilégios server-wide).
const MYSQL_DB_PRIVS = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "INDEX", "ALTER",
  "CREATE TEMPORARY TABLES", "LOCK TABLES", "REFERENCES", "CREATE VIEW",
  "SHOW VIEW", "CREATE ROUTINE", "ALTER ROUTINE", "EXECUTE", "EVENT", "TRIGGER",
  "GRANT OPTION",
] as const;

// Atributos de role no Postgres (o "global" do PG não é GRANT e sim ALTER ROLE).
const PG_ATTRS = [
  "SUPERUSER", "CREATEDB", "CREATEROLE", "LOGIN", "REPLICATION", "BYPASSRLS",
] as const;

const PG_DB_PRIVS = ["CONNECT", "CREATE", "TEMPORARY"] as const;

function eqSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// `ALL PRIVILEGES` expande pra lista concreta (menos GRANT OPTION, que vem de WITH GRANT OPTION).
function expandAll(set: Set<string>, all: readonly string[]) {
  if (set.delete("ALL PRIVILEGES") || set.delete("ALL")) {
    for (const p of all) if (p !== "GRANT OPTION") set.add(p);
  }
}

interface MysqlGrants {
  global: Set<string>;
  perDb: Map<string, Set<string>>;
}

// Parseia a saída de SHOW GRANTS FOR em conjuntos de privilégios global / por-database.
// Grants a nível de tabela (`db`.`t`) são ignorados — fora do escopo do editor.
function parseMysqlGrants(lines: string[]): MysqlGrants {
  const global = new Set<string>();
  const perDb = new Map<string, Set<string>>();
  for (const line of lines) {
    const m = line.match(/^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\s/i);
    if (!m) continue;
    const withGrant = /WITH\s+GRANT\s+OPTION/i.test(line);
    const set = new Set<string>();
    // Remove listas de coluna (só aparecem a nível de tabela, mas é defensivo).
    for (const raw of m[1].replace(/\([^)]*\)/g, "").split(",")) {
      const priv = raw.trim().toUpperCase();
      if (priv && priv !== "USAGE") set.add(priv);
    }
    if (withGrant) set.add("GRANT OPTION");

    const target = m[2].replace(/`/g, "");
    if (target === "*.*") {
      expandAll(set, MYSQL_GLOBAL_PRIVS);
      for (const p of set) global.add(p);
    } else if (target.endsWith(".*")) {
      expandAll(set, MYSQL_DB_PRIVS);
      perDb.set(target.slice(0, -2), set);
    }
  }
  return { global, perDb };
}

// Diff de privilégios num alvo (MySQL): emite GRANT/REVOKE só do que mudou.
// GRANT OPTION é tratado via cláusula WITH GRANT OPTION, não como priv normal.
function mysqlGrantDiff(
  userRef: string,
  target: string,
  orig: Set<string>,
  next: Set<string>,
): string[] {
  const stmts: string[] = [];
  const origGO = orig.has("GRANT OPTION");
  const nextGO = next.has("GRANT OPTION");
  const toGrant = [...next].filter((p) => p !== "GRANT OPTION" && !orig.has(p));
  const toRevoke = [...orig].filter((p) => p !== "GRANT OPTION" && !next.has(p));
  if (toGrant.length || (nextGO && !origGO)) {
    const clause = toGrant.length ? toGrant.join(", ") : "USAGE";
    stmts.push(
      `GRANT ${clause} ON ${target} TO ${userRef}${nextGO ? " WITH GRANT OPTION" : ""};`,
    );
  }
  if (toRevoke.length) {
    stmts.push(`REVOKE ${toRevoke.join(", ")} ON ${target} FROM ${userRef};`);
  }
  if (origGO && !nextGO) {
    stmts.push(`REVOKE GRANT OPTION ON ${target} FROM ${userRef};`);
  }
  return stmts;
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
  const [editing, setEditing] = useState<UserRow | null>(null);

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
    const pw = await appPrompt(t("users.newPasswordPrompt", { name: u.name }));
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
                        onClick={() => setEditing(u)}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        title={t("users.editPermissions")}
                      >
                        <KeyRound className="h-3 w-3" />
                        {t("users.permsBtn")}
                      </button>
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

      {editing && (
        <EditUserDialog
          connectionId={connectionId}
          driver={conn?.driver ?? "mysql"}
          user={editing}
          onClose={() => setEditing(null)}
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

function EditUserDialog({
  connectionId,
  driver,
  user,
  onClose,
}: {
  connectionId: Uuid;
  driver: string;
  user: UserRow;
  onClose: () => void;
}) {
  const t = useT();
  const requestApproval = useApproval((s) => s.requestApproval);
  const isPg = driver === "postgres";
  const userRef = `${quoteLit(user.name)}@${quoteLit(user.host ?? "%")}`;
  const globalList = isPg ? PG_ATTRS : MYSQL_GLOBAL_PRIVS;
  const dbPrivList = isPg ? PG_DB_PRIVS : MYSQL_DB_PRIVS;

  const [tab, setTab] = useState<"global" | "db">("global");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [globalOrig, setGlobalOrig] = useState<Set<string>>(new Set());
  const [globalCur, setGlobalCur] = useState<Set<string>>(new Set());

  const [dbList, setDbList] = useState<string[]>([]);
  const [mysqlPerDb, setMysqlPerDb] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  const [selectedDb, setSelectedDb] = useState("");
  const [dbOrig, setDbOrig] = useState<Set<string>>(new Set());
  const [dbCur, setDbCur] = useState<Set<string>>(new Set());
  const [dbLoading, setDbLoading] = useState(false);

  const fetchRows = useCallback(
    async (sql: string): Promise<Value[][]> => {
      const batch = await ipc.db.runQuery(connectionId, sql, null);
      const first = batch.results[0];
      if (!first) throw new Error(t("users.noResult"));
      if (first.kind === "error") throw new Error(first.message);
      if (first.kind !== "select") throw new Error(t("users.unexpectedResult"));
      return first.rows;
    },
    [connectionId, t],
  );

  // Carrega privilégios globais + lista de databases ao abrir.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (isPg) {
          const rows = await fetchRows(
            `SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ${quoteLit(user.name)}`,
          );
          const r = rows[0] ?? [];
          const g = new Set<string>();
          PG_ATTRS.forEach((attr, i) => {
            if (valueText(r[i]) === "true") g.add(attr);
          });
          const dbs = (
            await fetchRows(
              "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
            )
          ).map((row) => valueText(row[0]));
          if (!alive) return;
          setGlobalOrig(g);
          setGlobalCur(new Set(g));
          setDbList(dbs);
        } else {
          const lines = (await fetchRows(`SHOW GRANTS FOR ${userRef}`)).map(
            (r) => valueText(r[0]),
          );
          const parsed = parseMysqlGrants(lines);
          const dbs = (await fetchRows("SHOW DATABASES"))
            .map((r) => valueText(r[0]))
            .filter(
              (d) =>
                ![
                  "information_schema",
                  "performance_schema",
                  "mysql",
                  "sys",
                ].includes(d),
            );
          if (!alive) return;
          setGlobalOrig(parsed.global);
          setGlobalCur(new Set(parsed.global));
          setMysqlPerDb(parsed.perDb);
          setDbList(dbs);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchRows, isPg, user.name, userRef]);

  // Ao trocar de database, carrega os privilégios daquele db.
  useEffect(() => {
    if (!selectedDb) return;
    let alive = true;
    (async () => {
      if (!isPg) {
        const s = mysqlPerDb.get(selectedDb) ?? new Set<string>();
        setDbOrig(new Set(s));
        setDbCur(new Set(s));
        return;
      }
      setDbLoading(true);
      try {
        const checks = PG_DB_PRIVS.map(
          (p) =>
            `has_database_privilege(${quoteLit(user.name)}, ${quoteLit(selectedDb)}, '${p}')`,
        ).join(", ");
        const r = (await fetchRows(`SELECT ${checks}`))[0] ?? [];
        const s = new Set<string>();
        PG_DB_PRIVS.forEach((p, i) => {
          if (valueText(r[i]) === "true") s.add(p);
        });
        if (!alive) return;
        setDbOrig(new Set(s));
        setDbCur(new Set(s));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setDbLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedDb, isPg, mysqlPerDb, fetchRows, user.name]);

  const toggle = (cur: Set<string>, set: (s: Set<string>) => void, p: string) => {
    const n = new Set(cur);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    set(n);
  };

  const buildStatements = (): string[] => {
    const stmts: string[] = [];
    if (!eqSet(globalOrig, globalCur)) {
      if (isPg) {
        const clause = PG_ATTRS.map((a) =>
          globalCur.has(a) ? a : `NO${a}`,
        ).join(" ");
        stmts.push(
          `ALTER ROLE ${quoteIdent("postgres", user.name)} WITH ${clause};`,
        );
      } else {
        stmts.push(...mysqlGrantDiff(userRef, "*.*", globalOrig, globalCur));
      }
    }
    if (selectedDb && !eqSet(dbOrig, dbCur)) {
      if (isPg) {
        const roleRef = quoteIdent("postgres", user.name);
        const dbRef = quoteIdent("postgres", selectedDb);
        for (const p of PG_DB_PRIVS) {
          if (dbCur.has(p) && !dbOrig.has(p))
            stmts.push(`GRANT ${p} ON DATABASE ${dbRef} TO ${roleRef};`);
          else if (!dbCur.has(p) && dbOrig.has(p))
            stmts.push(`REVOKE ${p} ON DATABASE ${dbRef} FROM ${roleRef};`);
        }
      } else {
        const target = `\`${selectedDb.replace(/`/g, "``")}\`.*`;
        stmts.push(...mysqlGrantDiff(userRef, target, dbOrig, dbCur));
      }
    }
    return stmts;
  };

  const dirty =
    !eqSet(globalOrig, globalCur) ||
    (!!selectedDb && !eqSet(dbOrig, dbCur));

  const save = async () => {
    const stmts = buildStatements();
    if (stmts.length === 0) return;
    const ok = await requestApproval({
      kind: "sql",
      title: t("users.editTitle", { name: user.name }),
      description: t("users.editDesc"),
      sql: stmts.join("\n"),
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      for (const s of stmts) await ipc.db.runQuery(connectionId, s, null);
      // Reflete o estado aplicado como novo baseline.
      setGlobalOrig(new Set(globalCur));
      if (selectedDb) {
        setDbOrig(new Set(dbCur));
        if (!isPg) {
          const m = new Map(mysqlPerDb);
          m.set(selectedDb, new Set(dbCur));
          setMysqlPerDb(m);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const activeList = tab === "global" ? globalList : dbPrivList;
  const activeCur = tab === "global" ? globalCur : dbCur;
  const activeSet = tab === "global" ? setGlobalCur : setDbCur;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-[560px] max-w-[94vw] flex-col rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <KeyRound className="h-4 w-4 text-conn-accent" />
          <span className="text-sm font-semibold">
            {t("users.editTitle", { name: user.name })}
          </span>
          {user.host && (
            <span className="font-mono text-[11px] text-muted-foreground">
              @{user.host}
            </span>
          )}
        </header>

        <div className="flex items-center gap-1 border-b border-border px-3 pt-2">
          {(["global", "db"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                "rounded-t-md px-3 py-1.5 text-xs font-medium",
                tab === k
                  ? "border-b-2 border-conn-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "global"
                ? isPg
                  ? t("users.tabAttrs")
                  : t("users.tabGlobal")
                : t("users.tabPerDb")}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && (
            <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {loading ? (
            <div className="grid h-32 place-items-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {tab === "db" && (
                <div className="mb-3 grid gap-1">
                  <span className="text-xs text-muted-foreground">
                    {t("users.selectDb")}
                  </span>
                  <input
                    list="edituser-dblist"
                    value={selectedDb}
                    onChange={(e) => setSelectedDb(e.target.value)}
                    placeholder={t("users.selectDbPlaceholder")}
                    className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
                  />
                  <datalist id="edituser-dblist">
                    {dbList.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </div>
              )}

              {tab === "db" && !selectedDb ? (
                <div className="grid h-24 place-items-center text-xs italic text-muted-foreground">
                  {t("users.pickDbHint")}
                </div>
              ) : dbLoading ? (
                <div className="grid h-24 place-items-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {activeList.map((p) => (
                    <label
                      key={p}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/40"
                    >
                      <input
                        type="checkbox"
                        checked={activeCur.has(p)}
                        onChange={() => toggle(activeCur, activeSet, p)}
                        className="h-3.5 w-3.5 accent-conn-accent"
                      />
                      <span className="font-mono text-[11px]">{p}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          {dirty && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              {t("users.unsaved")}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            {t("users.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading || !dirty}
            className="inline-flex items-center gap-1 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("users.savePerms")}
          </button>
        </footer>
      </div>
    </div>
  );
}
