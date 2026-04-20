/** Parse de DSN estilo URL: `postgres://`, `postgresql://`, `mysql://`,
 *  `mariadb://`. Suporta senha com encoding URL. */
export interface ParsedDsn {
  driver: "postgres" | "mysql";
  host: string;
  port: number;
  user: string;
  password: string | null;
  database: string | null;
}

const PROTO_RE =
  /^(postgres|postgresql|mysql|mariadb):\/\//i;

export function isDsn(input: string): boolean {
  return PROTO_RE.test(input.trim());
}

export function parseDsn(input: string): ParsedDsn | null {
  const trimmed = input.trim();
  if (!PROTO_RE.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const proto = url.protocol.replace(":", "").toLowerCase();
  const driver: "postgres" | "mysql" =
    proto === "mysql" || proto === "mariadb" ? "mysql" : "postgres";

  const defaultPort = driver === "postgres" ? 5432 : 3306;
  const port = url.port ? Number(url.port) : defaultPort;
  if (!Number.isFinite(port)) return null;

  const host = url.hostname || "localhost";
  const user = decodeURIComponent(url.username || "");
  const password = url.password ? decodeURIComponent(url.password) : null;
  const db = url.pathname.replace(/^\//, "");

  return {
    driver,
    host,
    port,
    user,
    password,
    database: db ? decodeURIComponent(db) : null,
  };
}
