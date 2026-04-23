import { useState } from "react";
import { Loader2, Plus, Table as TableIcon, Trash2, X } from "lucide-react";

import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useCreateTable } from "@/state/create-table-state";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";

/** Common types. Length/precision becomes a placeholder when not relevant. */
const COLUMN_TYPES = [
  "INT",
  "BIGINT",
  "SMALLINT",
  "TINYINT",
  "VARCHAR",
  "TEXT",
  "LONGTEXT",
  "CHAR",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "BOOLEAN",
  "JSON",
  "BLOB",
  "LONGBLOB",
  "ENUM",
  "UUID",
] as const;

const ENGINES = ["InnoDB", "MyISAM", "MEMORY"] as const;

interface ColumnDraft {
  name: string;
  type: string;
  length: string; // VARCHAR(255), DECIMAL(10,2) — free-form string
  nullable: boolean;
  default: string; // "" = no default; explicit "NULL" accepted
  autoIncrement: boolean;
  primaryKey: boolean;
  unique: boolean;
  comment: string;
}

function emptyColumn(): ColumnDraft {
  return {
    name: "",
    type: "INT",
    length: "",
    nullable: true,
    default: "",
    autoIncrement: false,
    primaryKey: false,
    unique: false,
    comment: "",
  };
}

function buildCreateSql(
  schema: string,
  name: string,
  columns: ColumnDraft[],
  engine: string,
  charset: string,
  comment: string,
): string {
  const quote = (id: string) => `\`${id.replace(/`/g, "``")}\``;
  const pkCols = columns.filter((c) => c.primaryKey && c.name.trim());
  const parts: string[] = [];

  for (const c of columns) {
    if (!c.name.trim()) continue;
    const tname = c.type + (c.length.trim() ? `(${c.length.trim()})` : "");
    let line = `${quote(c.name.trim())} ${tname}`;
    line += c.nullable ? " NULL" : " NOT NULL";
    if (c.default.trim()) {
      // Quoting: reserved words (NULL, CURRENT_TIMESTAMP) unquoted;
      // everything else with ANSI quotes.
      const d = c.default.trim();
      const reserved =
        /^(NULL|CURRENT_TIMESTAMP|CURRENT_DATE|NOW\(\)|TRUE|FALSE)$/i.test(d) ||
        /^-?\d+(\.\d+)?$/.test(d);
      line += reserved ? ` DEFAULT ${d}` : ` DEFAULT '${d.replace(/'/g, "''")}'`;
    }
    if (c.autoIncrement) line += " AUTO_INCREMENT";
    if (c.unique && !c.primaryKey) line += " UNIQUE";
    if (c.comment.trim()) {
      line += ` COMMENT '${c.comment.trim().replace(/'/g, "''")}'`;
    }
    parts.push("  " + line);
  }

  if (pkCols.length > 0) {
    parts.push(
      `  PRIMARY KEY (${pkCols.map((c) => quote(c.name.trim())).join(", ")})`,
    );
  }

  let sql = `CREATE TABLE ${quote(schema)}.${quote(name)} (\n${parts.join(",\n")}\n)`;
  if (engine) sql += ` ENGINE = ${engine}`;
  if (charset.trim()) sql += ` DEFAULT CHARSET = ${charset.trim()}`;
  if (comment.trim())
    sql += ` COMMENT = '${comment.trim().replace(/'/g, "''")}'`;
  return sql + ";";
}

/** Mounted once at the root — reacts to the store. */
export function CreateTableDialog() {
  const t = useT();
  const request = useCreateTable((s) => s.request);
  const close = useCreateTable((s) => s.close);
  const invalidate = useSchemaCache((s) => s.invalidateSchema);
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);

  const [name, setName] = useState("");
  const [engine, setEngine] = useState<string>("InnoDB");
  const [charset, setCharset] = useState("utf8mb4");
  const [comment, setComment] = useState("");
  const [cols, setCols] = useState<ColumnDraft[]>([
    { ...emptyColumn(), name: "id", type: "BIGINT", nullable: false, autoIncrement: true, primaryKey: true },
  ]);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (!request) return null;

  const { connectionId, schema } = request;

  const addCol = () => setCols((c) => [...c, emptyColumn()]);
  const removeCol = (i: number) =>
    setCols((c) => c.filter((_, idx) => idx !== i));
  const patchCol = (i: number, patch: Partial<ColumnDraft>) =>
    setCols((c) =>
      c.map((col, idx) => (idx === i ? { ...col, ...patch } : col)),
    );

  const sql = buildCreateSql(schema, name, cols, engine, charset, comment);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t("createTableDialog.errNameRequired"));
      return;
    }
    if (cols.filter((c) => c.name.trim()).length === 0) {
      setError(t("createTableDialog.errColumnRequired"));
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await ipc.db.runQuery(connectionId, sql, schema);
      invalidate(connectionId, schema);
      ensureSnapshot(connectionId, schema).catch(() => {});
      // Reset state for the next opening.
      setName("");
      setCols([
        {
          ...emptyColumn(),
          name: "id",
          type: "BIGINT",
          nullable: false,
          autoIncrement: true,
          primaryKey: true,
        },
      ]);
      setPreviewOpen(false);
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40"
      onClick={() => !applying && close()}
      style={
        request.color
          ? ({ "--conn-accent": request.color } as React.CSSProperties)
          : undefined
      }
    >
      <div
        className="flex h-[80vh] w-[880px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <TableIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("createTableDialog.title", { schema })}</h2>
          <button
            type="button"
            onClick={close}
            disabled={applying}
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            title={t("createTableDialog.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* Name + quick options */}
          <div className="mb-3 grid grid-cols-[1fr_auto_auto] gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("createTableDialog.namePlaceholder")}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
              autoFocus
            />
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              title={t("createTableDialog.engineTitle")}
            >
              {ENGINES.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={charset}
              onChange={(e) => setCharset(e.target.value)}
              placeholder={t("createTableDialog.charsetPlaceholder")}
              className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              title={t("createTableDialog.charsetTitle")}
            />
          </div>

          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("createTableDialog.commentPlaceholder")}
            className="mb-3 w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground"
          />

          {/* Column table */}
          <div className="rounded-md border border-border">
            <div className="grid grid-cols-[1.5fr_1fr_0.8fr_auto_auto_auto_auto_1fr_auto] items-center gap-1 border-b border-border bg-card/40 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>{t("createTableDialog.colName")}</span>
              <span>{t("createTableDialog.colType")}</span>
              <span>{t("createTableDialog.colSize")}</span>
              <span title={t("createTableDialog.nullTitle")}>NULL</span>
              <span title={t("createTableDialog.pkTitle")}>PK</span>
              <span title={t("createTableDialog.uqTitle")}>UQ</span>
              <span title={t("createTableDialog.aiTitle")}>AI</span>
              <span>{t("createTableDialog.colDefaultComment")}</span>
              <span />
            </div>
            {cols.map((col, i) => (
              <ColumnRow
                key={i}
                col={col}
                onChange={(p) => patchCol(i, p)}
                onRemove={() => removeCol(i)}
              />
            ))}
            <button
              type="button"
              onClick={addCol}
              className="flex w-full items-center gap-1.5 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/30 hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              {t("createTableDialog.addColumn")}
            </button>
          </div>

          {/* SQL preview */}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setPreviewOpen((o) => !o)}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              {previewOpen
                ? t("createTableDialog.toggleSqlHide")
                : t("createTableDialog.toggleSqlShow")}
            </button>
            {previewOpen && (
              <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[10px] text-muted-foreground">
                {sql}
              </pre>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              <pre className="whitespace-pre-wrap break-all font-mono">
                {error}
              </pre>
            </div>
          )}
        </div>

        <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-border px-4">
          <button
            type="button"
            onClick={close}
            disabled={applying}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {t("createTableDialog.cancel")}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={applying || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            {t("createTableDialog.create")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ColumnRow({
  col,
  onChange,
  onRemove,
}: {
  col: ColumnDraft;
  onChange: (p: Partial<ColumnDraft>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const needsLength = /^(VARCHAR|CHAR|DECIMAL|FLOAT|DOUBLE|ENUM)$/.test(col.type);
  return (
    <div className="grid grid-cols-[1.5fr_1fr_0.8fr_auto_auto_auto_auto_1fr_auto] items-center gap-1 border-b border-border/50 px-2 py-1">
      <input
        type="text"
        value={col.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder={t("createTableDialog.placeholderName")}
        className="rounded border border-border bg-background px-2 py-1 font-mono text-xs"
      />
      <select
        value={col.type}
        onChange={(e) => onChange({ type: e.target.value })}
        className="rounded border border-border bg-background px-1 py-1 text-xs"
      >
        {COLUMN_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={col.length}
        onChange={(e) => onChange({ length: e.target.value })}
        placeholder={needsLength ? (col.type === "VARCHAR" ? "255" : "") : "—"}
        disabled={!needsLength}
        className={cn(
          "rounded border border-border bg-background px-1 py-1 text-center font-mono text-xs",
          !needsLength && "opacity-40",
        )}
      />
      <input
        type="checkbox"
        checked={col.nullable}
        onChange={(e) => onChange({ nullable: e.target.checked })}
        className="h-3 w-3 justify-self-center accent-conn-accent"
      />
      <input
        type="checkbox"
        checked={col.primaryKey}
        onChange={(e) =>
          onChange({
            primaryKey: e.target.checked,
            // PK implies NOT NULL — overwrite for consistency.
            nullable: e.target.checked ? false : col.nullable,
          })
        }
        className="h-3 w-3 justify-self-center accent-conn-accent"
      />
      <input
        type="checkbox"
        checked={col.unique}
        onChange={(e) => onChange({ unique: e.target.checked })}
        className="h-3 w-3 justify-self-center accent-conn-accent"
      />
      <input
        type="checkbox"
        checked={col.autoIncrement}
        onChange={(e) => onChange({ autoIncrement: e.target.checked })}
        className="h-3 w-3 justify-self-center accent-conn-accent"
      />
      <div className="flex gap-1">
        <input
          type="text"
          value={col.default}
          onChange={(e) => onChange({ default: e.target.value })}
          placeholder={t("createTableDialog.placeholderDefault")}
          className="w-24 rounded border border-border bg-background px-1 py-1 font-mono text-xs"
        />
        <input
          type="text"
          value={col.comment}
          onChange={(e) => onChange({ comment: e.target.value })}
          placeholder={t("createTableDialog.placeholderComment")}
          className="flex-1 rounded border border-border bg-background px-1 py-1 text-xs"
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
        title={t("createTableDialog.removeColumnTitle")}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
