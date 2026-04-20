/** Sugestões de tipos por driver. Input livre: usuário pode digitar
 *  qualquer outra coisa (inclusive versões parametrizadas). */
const MYSQL_TYPES = [
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "INT",
  "BIGINT",
  "INT UNSIGNED",
  "BIGINT UNSIGNED",
  "DECIMAL(10,2)",
  "FLOAT",
  "DOUBLE",
  "VARCHAR(255)",
  "VARCHAR(1024)",
  "CHAR(36)",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "BOOLEAN",
  "BIT",
  "JSON",
  "BLOB",
  "LONGBLOB",
  "ENUM('a','b')",
  "SET('a','b')",
];

const POSTGRES_TYPES = [
  "SERIAL",
  "BIGSERIAL",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "NUMERIC(10,2)",
  "REAL",
  "DOUBLE PRECISION",
  "VARCHAR(255)",
  "TEXT",
  "CHAR(1)",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "TIME",
  "UUID",
  "JSON",
  "JSONB",
  "BYTEA",
  "INET",
  "CIDR",
];

const SQLITE_TYPES = [
  "INTEGER",
  "INTEGER PRIMARY KEY AUTOINCREMENT",
  "REAL",
  "TEXT",
  "BLOB",
  "NUMERIC",
  "BOOLEAN",
  "DATE",
  "DATETIME",
];

export function columnTypeOptions(driver: string | undefined): string[] {
  if (driver === "postgres") return POSTGRES_TYPES;
  if (driver === "sqlite") return SQLITE_TYPES;
  return MYSQL_TYPES;
}
