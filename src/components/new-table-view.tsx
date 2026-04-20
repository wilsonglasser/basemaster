import { useState } from "react";
import { Loader2, Plus, Table as TableIcon, Trash2 } from "lucide-react";

import { ipc } from "@/lib/ipc";
import type { Uuid } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";
import { useTabs } from "@/state/tabs";

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
  length: string;
  nullable: boolean;
  default: string;
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

interface Props {
  tabId: string;
  connectionId: Uuid;
  schema: string;
}

export function NewTableView({ tabId, connectionId, schema }: Props) {
  const t = useT();
  const invalidate = useSchemaCache((s) => s.invalidateSchema);
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const closeTab = useTabs((s) => s.close);
  const patchTab = useTabs((s) => s.patch);
  const openTab = useTabs((s) => s.open);

  const [name, setName] = useState("");
  const [engine, setEngine] = useState<string>("InnoDB");
  const [charset, setCharset] = useState("utf8mb4");
  const [comment, setComment] = useState("");
  const [cols, setCols] = useState<ColumnDraft[]>([
    {
      ...emptyColumn(),
      name: "id",
      type: "BIGINT",
      nullable: false,
      autoIncrement: true,
      primaryKey: true,
    },
  ]);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const addCol = () => setCols((c) => [...c, emptyColumn()]);
  const removeCol = (i: number) =>
    setCols((c) => c.filter((_, idx) => idx !== i));
  const patchCol = (i: number, patch: Partial<ColumnDraft>) =>
    setCols((c) =>
      c.map((col, idx) => (idx === i ? { ...col, ...patch } : col)),
    );

  const sql = buildCreateSql(schema, name, cols, engine, charset, comment);

  // Atualiza o label da aba com o nome digitado.
  const updateTabLabel = (n: string) => {
    const lbl = n.trim()
      ? t("newTable.tabLabelNamed", { name: n.trim() })
      : t("newTable.tabLabel", { schema });
    patchTab(tabId, { label: lbl });
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t("newTable.errNameRequired"));
      return;
    }
    if (cols.filter((c) => c.name.trim()).length === 0) {
      setError(t("newTable.errColumnRequired"));
      return;
    }
    setApplying(true);
    setError(null);
    try {
      await ipc.db.runQuery(connectionId, sql, schema);
      invalidate(connectionId, schema);
      ensureSnapshot(connectionId, schema).catch(() => {});
      // Fecha a aba de criação e abre a tabela recém-criada em Estrutura.
      closeTab(tabId);
      openTab({
        label: name.trim(),
        kind: {
          kind: "table",
          connectionId,
          schema,
          table: name.trim(),
          initialView: "structure",
          initialEdit: true,
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/30 px-4">
        <TableIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("newTable.title", { schema })}</h2>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {t("newTable.hint")}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-5xl">
          <div className="mb-3 grid grid-cols-[1fr_auto_auto] gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                updateTabLabel(e.target.value);
              }}
              placeholder={t("newTable.namePlaceholder")}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
              autoFocus
            />
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              title={t("newTable.engineTitle")}
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
              placeholder={t("newTable.charsetPlaceholder")}
              className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              title={t("newTable.charsetTitle")}
            />
          </div>

          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("newTable.commentPlaceholder")}
            className="mb-3 w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground"
          />

          <div className="rounded-md border border-border">
            <div className="grid grid-cols-[1.5fr_1fr_0.8fr_auto_auto_auto_auto_1fr_auto] items-center gap-1 border-b border-border bg-card/40 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>{t("newTable.colName")}</span>
              <span>{t("newTable.colType")}</span>
              <span>{t("newTable.colSize")}</span>
              <span title={t("newTable.nullTitle")}>NULL</span>
              <span title={t("newTable.pkTitle")}>PK</span>
              <span title={t("newTable.uqTitle")}>UQ</span>
              <span title={t("newTable.aiTitle")}>AI</span>
              <span>{t("newTable.colDefaultComment")}</span>
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
              {t("newTable.addColumn")}
            </button>
          </div>

          <div className="mt-3">
            <button
              type="button"
              onClick={() => setPreviewOpen((o) => !o)}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              {previewOpen ? t("newTable.toggleSqlHide") : t("newTable.toggleSqlShow")}
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
      </div>

      <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-border bg-card/30 px-4">
        <button
          type="button"
          onClick={() => closeTab(tabId)}
          disabled={applying}
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {t("newTable.cancel")}
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
          {t("newTable.create")}
        </button>
      </footer>
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
        placeholder={t("newTable.placeholderName")}
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
          placeholder={t("newTable.placeholderDefault")}
          className="w-24 rounded border border-border bg-background px-1 py-1 font-mono text-xs"
        />
        <input
          type="text"
          value={col.comment}
          onChange={(e) => onChange({ comment: e.target.value })}
          placeholder={t("newTable.placeholderComment")}
          className="flex-1 rounded border border-border bg-background px-1 py-1 text-xs"
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
        title={t("newTable.removeColumnTitle")}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
