import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Key,
  Loader2,
  Pencil,
  Plus,
  Undo2,
  X,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import type {
  Column,
  ColumnType,
  ForeignKeyInfo,
  IndexInfo,
  TableOptions,
  Uuid,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Combobox } from "@/components/ui/combobox";
import { columnTypeOptions } from "@/lib/column-types";
import { appConfirm } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";
import { useSchemaCache } from "@/state/schema-cache";
import { useTableViewBridge } from "@/state/table-view-bridge";

interface StructurePaneProps {
  connectionId: Uuid;
  schema: string;
  table: string;
  /** If true, enters edit mode on mount. */
  initialEdit?: boolean;
  /** tabId do TableView pai — registra bridge pra edit remoto (Ctrl+D). */
  tabId?: string;
}

export function StructurePane({
  connectionId,
  schema,
  table,
  initialEdit = false,
  tabId,
}: StructurePaneProps) {
  const t = useT();
  const cols = useSchemaCache(
    (s) => s.caches[connectionId]?.columns[schema]?.[table],
  );
  const ensureColumns = useSchemaCache((s) => s.ensureColumns);
  const invalidate = useSchemaCache((s) => s.invalidateSchema);
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  const [fks, setFks] = useState<ForeignKeyInfo[] | null>(null);
  const [options, setOptions] = useState<TableOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const driver = useConnections(
    (s) => s.connections.find((c) => c.id === connectionId)?.driver,
  );
  const typeOptions = useMemo(() => columnTypeOptions(driver), [driver]);

  const [editing, setEditing] = useState(false);
  const autoEditTriggeredRef = useRef(false);
  const [draftCols, setDraftCols] = useState<DraftColumn[] | null>(null);
  const [draftIdx, setDraftIdx] = useState<DraftIndex[] | null>(null);
  const [draftFks, setDraftFks] = useState<DraftForeignKey[] | null>(null);
  const [draftOpts, setDraftOpts] = useState<DraftOptions | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StructureTab>("columns");

  useEffect(() => {
    if (!cols) {
      ensureColumns(connectionId, schema, table).catch((e) =>
        console.error("ensureColumns:", e),
      );
    }
  }, [connectionId, schema, table, cols, ensureColumns]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      ipc.db.listIndexes(connectionId, schema, table),
      ipc.db.listForeignKeys(connectionId, schema, table),
      ipc.db.tableOptions(connectionId, schema, table),
    ])
      .then(([idx, fk, opts]) => {
        if (cancelled) return;
        setIndexes(idx);
        setFks(fk);
        setOptions(opts);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, table]);

  const startEdit = () => {
    if (!cols) return;
    setDraftCols(cols.map(columnToDraft));
    setDraftIdx((indexes ?? []).map(indexToDraft));
    setDraftFks((fks ?? []).map(fkToDraft));
    setDraftOpts(optionsToDraft(options));
    setEditing(true);
    setApplyError(null);
  };

  // Auto-enter edit mode quando `initialEdit=true` — espera cols/indexes/fks
  // carregarem antes de disparar, pra evitar draft vazio.
  useEffect(() => {
    if (!initialEdit || autoEditTriggeredRef.current) return;
    if (!cols || indexes == null || fks == null || options == null) return;
    autoEditTriggeredRef.current = true;
    startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEdit, cols, indexes, fks, options]);

  // Register startEdit so Ctrl+D works even when the tab is already open.
  useEffect(() => {
    if (!tabId) return;
    useTableViewBridge.getState().registerEdit(tabId, startEdit);
    return () => {
      useTableViewBridge.getState().unregisterEdit(tabId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, cols, indexes, fks, options]);
  const discardEdit = () => {
    setDraftCols(null);
    setDraftIdx(null);
    setDraftFks(null);
    setDraftOpts(null);
    setEditing(false);
    setApplyError(null);
    if (activeTab === "sql") setActiveTab("columns");
  };

  const ddl = useMemo(() => {
    if (!cols || !draftCols || !draftIdx || !draftFks || !draftOpts) return "";
    return generateAlterDdl(schema, table, {
      origCols: cols,
      origIdx: indexes ?? [],
      origFks: fks ?? [],
      origOpts: options ?? {},
      draftCols,
      draftIdx,
      draftFks,
      draftOpts,
    });
  }, [
    cols,
    indexes,
    fks,
    options,
    draftCols,
    draftIdx,
    draftFks,
    draftOpts,
    schema,
    table,
  ]);

  const handleApply = async () => {
    if (!ddl) return;
    const ok = await appConfirm(t("structure.applyAlter", { ddl }));
    if (!ok) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await ipc.db.runQuery(connectionId, ddl, schema);
      const err = res.results.find((r) => r.kind === "error");
      if (err && err.kind === "error") {
        setApplyError(err.message);
        return;
      }
      // Invalidate the schema cache (forces columns to be re-described).
      invalidate(connectionId, schema);
      ensureColumns(connectionId, schema, table).catch(() => {});
      // Reload indexes/fks/opts — they may have changed now.
      const [idx, fk, opts] = await Promise.all([
        ipc.db.listIndexes(connectionId, schema, table),
        ipc.db.listForeignKeys(connectionId, schema, table),
        ipc.db.tableOptions(connectionId, schema, table),
      ]);
      setIndexes(idx);
      setFks(fk);
      setOptions(opts);
      setEditing(false);
      setDraftCols(null);
      setDraftIdx(null);
      setDraftFks(null);
      setDraftOpts(null);
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <StructureTabs
        active={activeTab}
        onChange={setActiveTab}
        editing={editing}
        canEdit={!!cols}
        applying={applying}
        canApply={!!ddl}
        onStartEdit={startEdit}
        onDiscardEdit={discardEdit}
        onApply={handleApply}
      />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {activeTab === "columns" && (
          <>
            {!cols ? (
              <Spinner label={t("structure.loadingColumns")} />
            ) : editing && draftCols ? (
              <ColumnsEditor
                draft={draftCols}
                onChange={setDraftCols}
                typeOptions={typeOptions}
              />
            ) : (
              <ColumnsTable columns={cols} />
            )}
          </>
        )}

        {activeTab === "indexes" && (
          <>
            {loading && !indexes ? (
              <Spinner label={t("structure.loadingIndexes")} />
            ) : error ? (
              <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {error}
              </div>
            ) : editing && draftIdx && cols ? (
              <IndexesEditor
                draft={draftIdx}
                onChange={setDraftIdx}
                allColumns={cols.map((c) => c.name)}
              />
            ) : indexes && indexes.length > 0 ? (
              <IndexesTable indexes={indexes} />
            ) : (
              <EmptyState label={t("structure.noIndexes")} />
            )}
          </>
        )}

        {activeTab === "foreign_keys" && (
          <>
            {loading && !fks ? (
              <Spinner label={t("structure.loadingFks")} />
            ) : editing && draftFks && cols ? (
              <ForeignKeysEditor
                draft={draftFks}
                onChange={setDraftFks}
                allColumns={cols.map((c) => c.name)}
                connectionId={connectionId}
                currentSchema={schema}
              />
            ) : fks && fks.length > 0 ? (
              <ForeignKeysTable fks={fks} />
            ) : (
              <EmptyState label={t("structure.noFks")} />
            )}
          </>
        )}
        {activeTab === "checks" && (
          <ComingSoon
            title={t("structure.checksTitle")}
            hint={t("structure.soon.checks")}
          />
        )}
        {activeTab === "triggers" && (
          <ComingSoon
            title={t("structure.triggersTitle")}
            hint={t("structure.soon.triggers")}
          />
        )}
        {activeTab === "options" && (
          <>
            {loading && !options ? (
              <Spinner label={t("structure.loadingOptions")} />
            ) : editing && draftOpts ? (
              <OptionsEditor draft={draftOpts} onChange={setDraftOpts} />
            ) : options ? (
              <OptionsTable opts={options} />
            ) : (
              <EmptyState label={t("structure.noOptions")} />
            )}
          </>
        )}

        {activeTab === "sql" && (
          <>
            {!editing ? (
              <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
                {t("structure.sqlEmpty")}
              </div>
            ) : !ddl ? (
              <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
                {t("structure.sqlNoChanges")}
              </div>
            ) : (
              <>
                <pre className="rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
                  {ddl}
                </pre>
                {applyError && (
                  <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
                    {applyError}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type StructureTab =
  | "columns"
  | "indexes"
  | "foreign_keys"
  | "checks"
  | "triggers"
  | "options"
  | "sql";

function StructureTabs({
  active,
  onChange,
  editing,
  canEdit,
  applying,
  canApply,
  onStartEdit,
  onDiscardEdit,
  onApply,
}: {
  active: StructureTab;
  onChange: (t: StructureTab) => void;
  editing: boolean;
  canEdit: boolean;
  applying: boolean;
  canApply: boolean;
  onStartEdit: () => void;
  onDiscardEdit: () => void;
  onApply: () => void;
}) {
  const t = useT();
  const tabs: Array<{ id: StructureTab; label: string; only?: "edit" }> = [
    { id: "columns", label: t("structure.tabs.columns") },
    { id: "indexes", label: t("structure.tabs.indexes") },
    { id: "foreign_keys", label: t("structure.tabs.foreign_keys") },
    { id: "checks", label: t("structure.tabs.checks") },
    { id: "triggers", label: t("structure.tabs.triggers") },
    { id: "options", label: t("structure.tabs.options") },
    { id: "sql", label: t("structure.tabs.sql"), only: "edit" },
  ];
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card/20 px-3 py-2">
      {tabs
        .filter((t) => !t.only || (t.only === "edit" && editing))
        .map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              "rounded-full px-3 py-0.5 text-[11px] font-medium transition-colors",
              active === t.id
                ? "bg-conn-accent text-conn-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      <div className="ml-auto flex items-center gap-1">
        {!editing ? (
          <button
            type="button"
            onClick={onStartEdit}
            disabled={!canEdit}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            title={t("structure.editTitle")}
          >
            <Pencil className="h-3 w-3" />
            {t("structure.edit")}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onDiscardEdit}
              disabled={applying}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <Undo2 className="h-3 w-3" />
              {t("common.discard")}
            </button>
            <button
              type="button"
              onClick={onApply}
              disabled={applying || !canApply}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applying ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              {t("common.apply")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ComingSoon({ title, hint }: { title: string; hint: string }) {
  const t = useT();
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md text-center">
        <div className="mb-2 text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
        <div className="mt-4 inline-block rounded-full border border-border bg-card px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("common.comingSoon")}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="grid h-24 place-items-center text-xs italic text-muted-foreground">
      {label}
    </div>
  );
}

function ColumnsTable({ columns }: { columns: Column[] }) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <Th className="w-[24px]"></Th>
            <Th>{t("structure.colName")}</Th>
            <Th>{t("structure.colType")}</Th>
            <Th className="w-[60px]">{t("structure.colNull")}</Th>
            <Th>{t("structure.colDefault")}</Th>
            <Th>{t("structure.colExtra")}</Th>
            <Th>{t("structure.colComment")}</Th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="border-t border-border hover:bg-accent/20">
              <Td className="text-conn-accent">
                {c.is_primary_key && (
                  <Key className="h-3 w-3" aria-label="primary key" />
                )}
              </Td>
              <Td className="font-medium">{c.name}</Td>
              <Td className="font-mono text-[11px] text-muted-foreground">
                {formatType(c.column_type)}
              </Td>
              <Td>
                {c.nullable ? (
                  <span className="text-muted-foreground">YES</span>
                ) : (
                  <span className="text-foreground">NO</span>
                )}
              </Td>
              <Td className="font-mono text-[11px] text-muted-foreground">
                {c.default ?? <span className="opacity-40">—</span>}
              </Td>
              <Td className="text-[11px] text-muted-foreground">
                {c.is_auto_increment ? "auto_increment" : ""}
              </Td>
              <Td className="text-[11px] text-muted-foreground">
                {c.comment ?? ""}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IndexesTable({ indexes }: { indexes: IndexInfo[] }) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <Th>{t("structure.colName")}</Th>
            <Th>{t("structure.colColumns")}</Th>
            <Th className="w-[80px]">{t("structure.colKind")}</Th>
            <Th className="w-[80px]">{t("structure.colUnique")}</Th>
            <Th className="w-[80px]">{t("structure.colPk")}</Th>
          </tr>
        </thead>
        <tbody>
          {indexes.map((i) => (
            <tr key={i.name} className="border-t border-border hover:bg-accent/20">
              <Td className="font-medium">{i.name}</Td>
              <Td className="font-mono text-[11px] text-muted-foreground">
                {i.columns.join(", ")}
              </Td>
              <Td className="text-[11px] text-muted-foreground">
                {i.index_type ?? ""}
              </Td>
              <Td>
                {i.unique ? (
                  <span className="text-emerald-500">{t("structure.yes")}</span>
                ) : (
                  <span className="text-muted-foreground">{t("structure.no")}</span>
                )}
              </Td>
              <Td>
                {i.is_primary ? (
                  <span className="inline-flex items-center gap-1 text-conn-accent">
                    <Key className="h-3 w-3" />
                    {t("structure.yes")}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t("structure.no")}</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={cn("px-3 py-1.5 text-left font-medium", className)}>
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={cn("px-3 py-1.5", className)}>{children}</td>;
}

function Spinner({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      {label ?? t("common.loading")}
    </div>
  );
}

/** Editable representation of a column. `originalName === null` means
 *  a new column (didn't exist in the table yet). */
interface DraftColumn {
  uid: string;
  originalName: string | null;
  name: string;
  rawType: string;
  nullable: boolean;
  default: string | null;
  comment: string;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
}

let nextUid = 1;
function newUid() {
  return `col-${nextUid++}`;
}

function columnToDraft(c: Column): DraftColumn {
  return {
    uid: newUid(),
    originalName: c.name,
    name: c.name,
    rawType: formatType(c.column_type),
    nullable: c.nullable,
    default: c.default ?? null,
    comment: c.comment ?? "",
    isPrimaryKey: c.is_primary_key,
    isAutoIncrement: c.is_auto_increment,
  };
}

function ColumnsEditor({
  draft,
  onChange,
  typeOptions,
}: {
  draft: DraftColumn[];
  onChange: (next: DraftColumn[]) => void;
  typeOptions: string[];
}) {
  const t = useT();
  const update = (uid: string, patch: Partial<DraftColumn>) => {
    onChange(draft.map((c) => (c.uid === uid ? { ...c, ...patch } : c)));
  };
  const remove = (uid: string) => {
    onChange(draft.filter((c) => c.uid !== uid));
  };
  const addColumn = () => {
    onChange([
      ...draft,
      {
        uid: newUid(),
        originalName: null,
        name: "",
        rawType: "VARCHAR(255)",
        nullable: true,
        default: null,
        comment: "",
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
    ]);
  };

  return (
    <div className="rounded-md border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <Th className="w-[24px]"></Th>
              <Th className="min-w-[140px]">{t("structure.colName")}</Th>
              <Th className="min-w-[160px]">{t("structure.colType")}</Th>
              <Th className="w-[70px]">{t("structure.colNull")}</Th>
              <Th className="min-w-[120px]">{t("structure.colDefault")}</Th>
              <Th className="w-[60px]">AI</Th>
              <Th className="w-[60px]">{t("structure.colPk")}</Th>
              <Th className="min-w-[140px]">{t("structure.colComment")}</Th>
              <Th className="w-[32px]"></Th>
            </tr>
          </thead>
          <tbody>
            {draft.map((c) => (
              <tr
                key={c.uid}
                className={cn(
                  "border-t border-border",
                  c.originalName === null && "bg-emerald-500/5",
                )}
              >
                <Td className="text-muted-foreground">
                  {c.originalName === null ? (
                    <Plus
                      className="h-3 w-3 text-emerald-500"
                      aria-label={t("structure.newBadge")}
                    />
                  ) : c.isPrimaryKey ? (
                    <Key className="h-3 w-3 text-conn-accent" />
                  ) : null}
                </Td>
                <Td>
                  <Input
                    value={c.name}
                    onChange={(v) => update(c.uid, { name: v })}
                    placeholder={t("structure.placeholderName")}
                  />
                </Td>
                <Td>
                  <Combobox
                    value={c.rawType}
                    options={typeOptions}
                    onChange={(v) => update(c.uid, { rawType: v })}
                    placeholder="VARCHAR(255)"
                    mono
                  />
                </Td>
                <Td>
                  <input
                    type="checkbox"
                    checked={c.nullable}
                    onChange={(e) =>
                      update(c.uid, { nullable: e.target.checked })
                    }
                    className="h-3 w-3"
                  />
                </Td>
                <Td>
                  <Input
                    value={c.default ?? ""}
                    onChange={(v) =>
                      update(c.uid, { default: v === "" ? null : v })
                    }
                    placeholder={t("structure.placeholderNoDefault")}
                    mono
                  />
                </Td>
                <Td>
                  <input
                    type="checkbox"
                    checked={c.isAutoIncrement}
                    onChange={(e) =>
                      update(c.uid, { isAutoIncrement: e.target.checked })
                    }
                    className="h-3 w-3"
                  />
                </Td>
                <Td>
                  <input
                    type="checkbox"
                    checked={c.isPrimaryKey}
                    onChange={(e) =>
                      update(c.uid, { isPrimaryKey: e.target.checked })
                    }
                    className="h-3 w-3"
                  />
                </Td>
                <Td>
                  <Input
                    value={c.comment}
                    onChange={(v) => update(c.uid, { comment: v })}
                    placeholder={t("structure.placeholderDash")}
                  />
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => remove(c.uid)}
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                    title={t("structure.removeColumn")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={addColumn}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("structure.addColumn")}
        </button>
      </div>
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40",
        mono && "font-mono text-[11px]",
      )}
    />
  );
}

interface DraftBundle {
  origCols: readonly Column[];
  origIdx: readonly IndexInfo[];
  origFks: readonly ForeignKeyInfo[];
  origOpts: Partial<TableOptions>;
  draftCols: readonly DraftColumn[];
  draftIdx: readonly DraftIndex[];
  draftFks: readonly DraftForeignKey[];
  draftOpts: DraftOptions;
}

/** Gera o ALTER TABLE completo (cols + indexes + FKs + options). */
function generateAlterDdl(
  schemaName: string,
  tableName: string,
  b: DraftBundle,
): string {
  const actions: string[] = [];

  // --- FKs primeiro (drops): precisa cair antes de alterar colunas referenciadas.
  const draftFkByOrig = new Map<string, DraftForeignKey>();
  for (const d of b.draftFks) {
    if (d.originalName) draftFkByOrig.set(d.originalName, d);
  }
  for (const fk of b.origFks) {
    const kept = draftFkByOrig.get(fk.name);
    if (!kept) {
      actions.push(`  DROP FOREIGN KEY \`${fk.name}\``);
    } else if (fkChanged(fk, kept)) {
      // change → drop + re-add afterwards
      actions.push(`  DROP FOREIGN KEY \`${fk.name}\``);
    }
  }

  // --- Colunas
  const colOriginalByName = new Map(b.origCols.map((c) => [c.name, c]));
  const draftColByOriginal = new Map<string, DraftColumn>();
  for (const d of b.draftCols) {
    if (d.originalName) draftColByOriginal.set(d.originalName, d);
  }
  for (const c of b.origCols) {
    if (!draftColByOriginal.has(c.name)) {
      actions.push(`  DROP COLUMN \`${c.name}\``);
    }
  }
  for (const d of b.draftCols) {
    if (!d.name.trim()) continue;
    if (d.originalName === null) {
      actions.push(`  ADD COLUMN ${renderColumnDef(d)}`);
    } else {
      const orig = colOriginalByName.get(d.originalName);
      if (!orig) continue;
      if (!columnChanged(orig, d)) continue;
      if (d.name !== d.originalName) {
        actions.push(
          `  CHANGE COLUMN \`${d.originalName}\` ${renderColumnDef(d)}`,
        );
      } else {
        actions.push(`  MODIFY COLUMN ${renderColumnDef(d)}`);
      }
    }
  }

  // --- PK diff
  const origPk = b.origCols.filter((c) => c.is_primary_key).map((c) => c.name);
  const draftPk = b.draftCols
    .filter((c) => c.isPrimaryKey && c.name.trim())
    .map((c) => c.name);
  const pkChanged =
    origPk.length !== draftPk.length ||
    origPk.some((n, i) => n !== draftPk[i]);
  if (pkChanged) {
    if (origPk.length > 0) actions.push("  DROP PRIMARY KEY");
    if (draftPk.length > 0) {
      const list = draftPk.map((n) => `\`${n}\``).join(", ");
      actions.push(`  ADD PRIMARY KEY (${list})`);
    }
  }

  // --- Indexes (excludes PK, which is handled above)
  const origIdxByName = new Map(
    b.origIdx.filter((i) => !i.is_primary).map((i) => [i.name, i]),
  );
  const draftIdxByOrig = new Map<string, DraftIndex>();
  for (const d of b.draftIdx) {
    if (d.originalName) draftIdxByOrig.set(d.originalName, d);
  }
  for (const [name] of origIdxByName) {
    if (!draftIdxByOrig.has(name)) {
      actions.push(`  DROP INDEX \`${name}\``);
    }
  }
  for (const d of b.draftIdx) {
    if (d.columns.length === 0 || !d.name.trim()) continue;
    if (d.originalName === null) {
      actions.push(renderIndexAdd(d));
    } else {
      const orig = origIdxByName.get(d.originalName);
      if (!orig) continue;
      if (!indexChanged(orig, d)) continue;
      // MySQL has no ALTER INDEX — drop + add.
      actions.push(`  DROP INDEX \`${d.originalName}\``);
      actions.push(renderIndexAdd(d));
    }
  }

  // --- FKs re-add (alteradas ou novas)
  for (const d of b.draftFks) {
    if (d.columns.length === 0 || !d.refTable.trim()) continue;
    const orig = d.originalName
      ? b.origFks.find((f) => f.name === d.originalName) ?? null
      : null;
    if (orig === null) {
      actions.push(renderFkAdd(d));
    } else if (fkChanged(orig, d)) {
      actions.push(renderFkAdd(d));
    }
  }

  // --- Table options (all together at the end)
  const optActions = diffTableOptions(b.origOpts, b.draftOpts);
  actions.push(...optActions);

  if (actions.length === 0) return "";
  return `ALTER TABLE \`${schemaName}\`.\`${tableName}\`\n${actions.join(",\n")};`;
}

function renderIndexAdd(d: DraftIndex): string {
  const kind = d.unique ? "UNIQUE " : "";
  const typeSuffix =
    d.indexType && d.indexType !== "BTREE" ? ` USING ${d.indexType}` : "";
  const cols = d.columns.map((c) => `\`${c}\``).join(", ");
  return `  ADD ${kind}INDEX \`${d.name}\` (${cols})${typeSuffix}`;
}

function indexChanged(orig: IndexInfo, d: DraftIndex): boolean {
  if (orig.name !== d.name) return true;
  if (!!orig.unique !== d.unique) return true;
  if ((orig.index_type ?? "BTREE") !== d.indexType) return true;
  if (orig.columns.length !== d.columns.length) return true;
  for (let i = 0; i < orig.columns.length; i++) {
    if (orig.columns[i] !== d.columns[i]) return true;
  }
  return false;
}

function renderFkAdd(d: DraftForeignKey): string {
  const cols = d.columns.map((c) => `\`${c}\``).join(", ");
  const refCols = d.refColumns.map((c) => `\`${c}\``).join(", ");
  const refTable = d.refSchema
    ? `\`${d.refSchema}\`.\`${d.refTable}\``
    : `\`${d.refTable}\``;
  const parts = [
    `  ADD CONSTRAINT \`${d.name}\` FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})`,
  ];
  if (d.onDelete && d.onDelete !== "RESTRICT" && d.onDelete !== "NO ACTION") {
    parts[0] += ` ON DELETE ${d.onDelete}`;
  }
  if (d.onUpdate && d.onUpdate !== "RESTRICT" && d.onUpdate !== "NO ACTION") {
    parts[0] += ` ON UPDATE ${d.onUpdate}`;
  }
  return parts[0];
}

function fkChanged(orig: ForeignKeyInfo, d: DraftForeignKey): boolean {
  if (orig.name !== d.name) return true;
  if (orig.columns.join(",") !== d.columns.join(",")) return true;
  if ((orig.ref_schema ?? "") !== (d.refSchema ?? "")) return true;
  if (orig.ref_table !== d.refTable) return true;
  if (orig.ref_columns.join(",") !== d.refColumns.join(",")) return true;
  if ((orig.on_delete ?? "RESTRICT") !== (d.onDelete || "RESTRICT")) return true;
  if ((orig.on_update ?? "RESTRICT") !== (d.onUpdate || "RESTRICT")) return true;
  return false;
}

function diffTableOptions(
  orig: Partial<TableOptions>,
  draft: DraftOptions,
): string[] {
  const parts: string[] = [];
  const add = (kv: string) => parts.push(`  ${kv}`);
  if ((orig.engine ?? "") !== draft.engine && draft.engine) {
    add(`ENGINE = ${draft.engine}`);
  }
  if (
    (orig.charset ?? "") !== draft.charset &&
    draft.charset
  ) {
    add(`DEFAULT CHARSET = ${draft.charset}`);
  }
  if (
    (orig.collation ?? "") !== draft.collation &&
    draft.collation
  ) {
    add(`COLLATE = ${draft.collation}`);
  }
  if (
    (orig.row_format ?? "") !== draft.rowFormat &&
    draft.rowFormat
  ) {
    add(`ROW_FORMAT = ${draft.rowFormat}`);
  }
  const draftAi = draft.autoIncrement.trim();
  if (draftAi && String(orig.auto_increment ?? "") !== draftAi) {
    add(`AUTO_INCREMENT = ${draftAi}`);
  }
  if ((orig.comment ?? "") !== draft.comment) {
    add(`COMMENT = '${draft.comment.replace(/'/g, "''")}'`);
  }
  return parts;
}

function renderColumnDef(d: DraftColumn): string {
  const parts: string[] = [`\`${d.name}\``, d.rawType.trim()];
  parts.push(d.nullable ? "NULL" : "NOT NULL");
  if (d.default !== null) {
    // Keeps user-typed — if it's CURRENT_TIMESTAMP/a function, no quotes.
    const isFunc = /^(CURRENT_TIMESTAMP|NULL|TRUE|FALSE|\d)/i.test(
      d.default.trim(),
    );
    parts.push(
      `DEFAULT ${isFunc ? d.default : `'${d.default.replace(/'/g, "''")}'`}`,
    );
  }
  if (d.isAutoIncrement) parts.push("AUTO_INCREMENT");
  if (d.comment) {
    parts.push(`COMMENT '${d.comment.replace(/'/g, "''")}'`);
  }
  return parts.join(" ");
}

function columnChanged(orig: Column, d: DraftColumn): boolean {
  if (orig.name !== d.name) return true;
  if (formatType(orig.column_type) !== d.rawType.trim()) return true;
  if (orig.nullable !== d.nullable) return true;
  if ((orig.default ?? null) !== (d.default ?? null)) return true;
  if ((orig.comment ?? "") !== d.comment) return true;
  if (orig.is_auto_increment !== d.isAutoIncrement) return true;
  // PK is handled separately via DROP/ADD PK.
  return false;
}

function formatType(t: ColumnType): string {
  switch (t.kind) {
    case "integer":
      return `${t.bits === 8 ? "TINYINT" : t.bits === 16 ? "SMALLINT" : t.bits === 24 ? "MEDIUMINT" : t.bits === 32 ? "INT" : "BIGINT"}${t.unsigned ? " UNSIGNED" : ""}`;
    case "decimal":
      return `DECIMAL(${t.precision},${t.scale})`;
    case "float":
      return "FLOAT";
    case "double":
      return "DOUBLE";
    case "boolean":
      return "BOOL";
    case "text":
      return t.max_len ? `VARCHAR(${t.max_len})` : "TEXT";
    case "blob":
      return t.max_len ? `VARBINARY(${t.max_len})` : "BLOB";
    case "json":
      return "JSON";
    case "date":
      return "DATE";
    case "time":
      return "TIME";
    case "date_time":
      return "DATETIME";
    case "timestamp":
      return "TIMESTAMP";
    case "enum":
      return `ENUM(${t.values.join(", ")})`;
    case "set":
      return `SET(${t.values.join(", ")})`;
    case "other":
      return t.raw;
  }
}

// =============================================================================
// Indexes editor
// =============================================================================

interface DraftIndex {
  uid: string;
  originalName: string | null;
  name: string;
  columns: string[];
  unique: boolean;
  indexType: string; // BTREE | HASH | FULLTEXT | SPATIAL
}

const INDEX_TYPES = ["BTREE", "HASH", "FULLTEXT", "SPATIAL"];

function indexToDraft(i: IndexInfo): DraftIndex {
  return {
    uid: newUid(),
    originalName: i.is_primary ? null : i.name, // PK editada via coluna PK
    name: i.name,
    columns: [...i.columns],
    unique: i.unique,
    indexType: i.index_type ?? "BTREE",
  };
}

function IndexesEditor({
  draft,
  onChange,
  allColumns,
}: {
  draft: DraftIndex[];
  onChange: (next: DraftIndex[]) => void;
  allColumns: string[];
}) {
  const t = useT();
  const update = (uid: string, patch: Partial<DraftIndex>) => {
    onChange(draft.map((x) => (x.uid === uid ? { ...x, ...patch } : x)));
  };
  const remove = (uid: string) => onChange(draft.filter((x) => x.uid !== uid));
  const addIdx = () =>
    onChange([
      ...draft,
      {
        uid: newUid(),
        originalName: null,
        name: `idx_${draft.length + 1}`,
        columns: [],
        unique: false,
        indexType: "BTREE",
      },
    ]);

  // Filters PRIMARY out of the display.
  const visible = draft.filter((d) => d.name.toLowerCase() !== "primary");

  return (
    <div className="rounded-md border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <Th className="min-w-[140px]">{t("structure.colName")}</Th>
              <Th className="min-w-[200px]">{t("structure.colColumns")}</Th>
              <Th className="w-[80px]">{t("structure.colKind")}</Th>
              <Th className="w-[60px]">{t("structure.colUnique")}</Th>
              <Th className="w-[32px]"></Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <tr
                key={i.uid}
                className={cn(
                  "border-t border-border",
                  i.originalName === null && "bg-emerald-500/5",
                )}
              >
                <Td>
                  <Input
                    value={i.name}
                    onChange={(v) => update(i.uid, { name: v })}
                  />
                </Td>
                <Td>
                  <ColumnMultiSelect
                    value={i.columns}
                    options={allColumns}
                    onChange={(v) => update(i.uid, { columns: v })}
                  />
                </Td>
                <Td>
                  <Select
                    value={i.indexType}
                    onChange={(v) => update(i.uid, { indexType: v })}
                    options={INDEX_TYPES}
                  />
                </Td>
                <Td>
                  <input
                    type="checkbox"
                    checked={i.unique}
                    onChange={(e) =>
                      update(i.uid, { unique: e.target.checked })
                    }
                    className="h-3 w-3"
                  />
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => remove(i.uid)}
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={addIdx}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("structure.addIndex")}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Foreign Keys editor
// =============================================================================

interface DraftForeignKey {
  uid: string;
  originalName: string | null;
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

const FK_ACTIONS = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"];

function fkToDraft(f: ForeignKeyInfo): DraftForeignKey {
  return {
    uid: newUid(),
    originalName: f.name,
    name: f.name,
    columns: [...f.columns],
    refSchema: f.ref_schema ?? "",
    refTable: f.ref_table,
    refColumns: [...f.ref_columns],
    onUpdate: f.on_update ?? "RESTRICT",
    onDelete: f.on_delete ?? "RESTRICT",
  };
}

function ForeignKeysEditor({
  draft,
  onChange,
  allColumns,
  connectionId,
  currentSchema,
}: {
  draft: DraftForeignKey[];
  onChange: (next: DraftForeignKey[]) => void;
  allColumns: string[];
  connectionId: Uuid;
  currentSchema: string;
}) {
  const t = useT();
  const cache = useSchemaCache((s) => s.caches[connectionId]);
  const ensureSnapshot = useSchemaCache((s) => s.ensureSnapshot);
  const ensureColumns = useSchemaCache((s) => s.ensureColumns);

  // Available schemas + tables of the ref schema (cache-backed — ensure
  // if needed when the user switches).
  const schemas = useMemo(
    () => (cache?.schemas ?? []).map((s) => s.name),
    [cache?.schemas],
  );

  const update = (uid: string, patch: Partial<DraftForeignKey>) => {
    onChange(draft.map((x) => (x.uid === uid ? { ...x, ...patch } : x)));
  };
  const remove = (uid: string) => onChange(draft.filter((x) => x.uid !== uid));
  const addFk = () =>
    onChange([
      ...draft,
      {
        uid: newUid(),
        originalName: null,
        name: `fk_${draft.length + 1}`,
        columns: [],
        refSchema: currentSchema,
        refTable: "",
        refColumns: [],
        onUpdate: "RESTRICT",
        onDelete: "RESTRICT",
      },
    ]);

  // When the user picks a ref schema, ensure the snapshot is loaded
  // (tables + columns) so autocomplete works.
  const handleRefSchema = (uid: string, newSchema: string) => {
    update(uid, { refSchema: newSchema, refTable: "", refColumns: [] });
    if (newSchema) {
      ensureSnapshot(connectionId, newSchema).catch(() => {});
    }
  };
  const handleRefTable = (uid: string, newTable: string, refSchema: string) => {
    update(uid, { refTable: newTable, refColumns: [] });
    if (refSchema && newTable) {
      ensureColumns(connectionId, refSchema, newTable).catch(() => {});
    }
  };

  return (
    <div className="rounded-md border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <Th className="min-w-[140px]">{t("structure.colName")}</Th>
              <Th className="min-w-[160px]">{t("structure.colColumns")}</Th>
              <Th className="w-[110px]">{t("structure.colRefSchema")}</Th>
              <Th className="min-w-[140px]">{t("structure.colRefTable")}</Th>
              <Th className="min-w-[180px]">{t("structure.colRefColumns")}</Th>
              <Th className="w-[110px]">{t("structure.colOnDelete")}</Th>
              <Th className="w-[110px]">{t("structure.colOnUpdate")}</Th>
              <Th className="w-[32px]"></Th>
            </tr>
          </thead>
          <tbody>
            {draft.map((f) => {
              const refSchemaName = f.refSchema || currentSchema;
              const refTables =
                cache?.tables[refSchemaName]?.map((t) => t.name) ?? [];
              const refTableColumns =
                cache?.columns[refSchemaName]?.[f.refTable]?.map(
                  (c) => c.name,
                ) ?? [];
              return (
              <tr
                key={f.uid}
                className={cn(
                  "border-t border-border",
                  f.originalName === null && "bg-emerald-500/5",
                )}
              >
                <Td>
                  <Input
                    value={f.name}
                    onChange={(v) => update(f.uid, { name: v })}
                  />
                </Td>
                <Td>
                  <ColumnMultiSelect
                    value={f.columns}
                    options={allColumns}
                    onChange={(v) => update(f.uid, { columns: v })}
                  />
                </Td>
                <Td>
                  <Select
                    value={refSchemaName}
                    onChange={(v) => handleRefSchema(f.uid, v)}
                    options={schemas.length > 0 ? schemas : [currentSchema]}
                  />
                </Td>
                <Td>
                  {refTables.length > 0 ? (
                    <Select
                      value={f.refTable}
                      onChange={(v) =>
                        handleRefTable(f.uid, v, refSchemaName)
                      }
                      options={["", ...refTables]}
                    />
                  ) : (
                    // Fallback to manual typing if the schema didn't
                    // load tables (e.g., just created or empty cache).
                    <Input
                      value={f.refTable}
                      onChange={(v) =>
                        handleRefTable(f.uid, v, refSchemaName)
                      }
                      placeholder={t("structure.placeholderRefTable")}
                      mono
                    />
                  )}
                </Td>
                <Td>
                  {refTableColumns.length > 0 ? (
                    <ColumnMultiSelect
                      value={f.refColumns}
                      options={refTableColumns}
                      onChange={(v) => update(f.uid, { refColumns: v })}
                    />
                  ) : (
                    <Input
                      value={f.refColumns.join(",")}
                      onChange={(v) =>
                        update(f.uid, {
                          refColumns: v
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder={t("structure.placeholderRefColumns")}
                      mono
                    />
                  )}
                </Td>
                <Td>
                  <Select
                    value={f.onDelete}
                    onChange={(v) => update(f.uid, { onDelete: v })}
                    options={FK_ACTIONS}
                  />
                </Td>
                <Td>
                  <Select
                    value={f.onUpdate}
                    onChange={(v) => update(f.uid, { onUpdate: v })}
                    options={FK_ACTIONS}
                  />
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => remove(f.uid)}
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={addFk}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("structure.addFk")}
        </button>
      </div>
    </div>
  );
}

function ForeignKeysTable({ fks }: { fks: ForeignKeyInfo[] }) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-card/40 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <Th>{t("structure.colName")}</Th>
            <Th>{t("structure.colColumns")}</Th>
            <Th>{t("structure.colReferences")}</Th>
            <Th className="w-[110px]">{t("structure.colOnDelete")}</Th>
            <Th className="w-[110px]">{t("structure.colOnUpdate")}</Th>
          </tr>
        </thead>
        <tbody>
          {fks.map((f) => (
            <tr key={f.name} className="border-t border-border hover:bg-accent/20">
              <Td className="font-medium">{f.name}</Td>
              <Td className="font-mono text-[11px] text-muted-foreground">
                {f.columns.join(", ")}
              </Td>
              <Td className="font-mono text-[11px] text-muted-foreground">
                {f.ref_schema ? `${f.ref_schema}.${f.ref_table}` : f.ref_table}
                <span className="text-muted-foreground/60">
                  {" ("}
                  {f.ref_columns.join(", ")})
                </span>
              </Td>
              <Td className="text-[11px] text-muted-foreground">
                {f.on_delete ?? "RESTRICT"}
              </Td>
              <Td className="text-[11px] text-muted-foreground">
                {f.on_update ?? "RESTRICT"}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// Options editor
// =============================================================================

interface DraftOptions {
  engine: string;
  charset: string;
  collation: string;
  rowFormat: string;
  autoIncrement: string;
  comment: string;
}

const MYSQL_ENGINES = ["InnoDB", "MyISAM", "MEMORY", "ARCHIVE", "CSV"];
const MYSQL_CHARSETS = ["utf8mb4", "utf8mb3", "latin1", "ascii"];
const ROW_FORMATS = ["DEFAULT", "DYNAMIC", "COMPACT", "COMPRESSED", "REDUNDANT", "FIXED"];

function optionsToDraft(o: TableOptions | null): DraftOptions {
  return {
    engine: o?.engine ?? "",
    charset: o?.charset ?? "",
    collation: o?.collation ?? "",
    rowFormat: o?.row_format ?? "",
    autoIncrement:
      o?.auto_increment != null ? String(o.auto_increment) : "",
    comment: o?.comment ?? "",
  };
}

function OptionsEditor({
  draft,
  onChange,
}: {
  draft: DraftOptions;
  onChange: (next: DraftOptions) => void;
}) {
  const t = useT();
  const update = (patch: Partial<DraftOptions>) =>
    onChange({ ...draft, ...patch });
  return (
    <div className="grid max-w-xl gap-3 rounded-md border border-border p-4 text-xs">
      <Field label={t("structure.colEngine")}>
        <Select
          value={draft.engine}
          onChange={(v) => update({ engine: v })}
          options={MYSQL_ENGINES}
          allowEmpty
        />
      </Field>
      <Field label={t("structure.colCharset")}>
        <Select
          value={draft.charset}
          onChange={(v) => update({ charset: v })}
          options={MYSQL_CHARSETS}
          allowEmpty
        />
      </Field>
      <Field label={t("structure.colCollation")}>
        <Input
          value={draft.collation}
          onChange={(v) => update({ collation: v })}
          placeholder={t("structure.placeholderCollation")}
          mono
        />
      </Field>
      <Field label={t("structure.colRowFormat")}>
        <Select
          value={draft.rowFormat}
          onChange={(v) => update({ rowFormat: v })}
          options={ROW_FORMATS}
          allowEmpty
        />
      </Field>
      <Field label={t("structure.colAutoIncrement")}>
        <Input
          value={draft.autoIncrement}
          onChange={(v) => update({ autoIncrement: v })}
          placeholder={t("structure.placeholderNextValue")}
          mono
        />
      </Field>
      <Field label={t("structure.colComment")}>
        <Input
          value={draft.comment}
          onChange={(v) => update({ comment: v })}
          placeholder={t("structure.placeholderDash")}
        />
      </Field>
    </div>
  );
}

function OptionsTable({ opts }: { opts: TableOptions }) {
  const t = useT();
  const rows: Array<[string, string | number | null | undefined]> = [
    [t("structure.colEngine"), opts.engine],
    [t("structure.colCharset"), opts.charset],
    [t("structure.colCollation"), opts.collation],
    [t("structure.colRowFormat"), opts.row_format],
    [t("structure.colAutoIncrement"), opts.auto_increment ?? null],
    [t("structure.colComment"), opts.comment],
  ];
  return (
    <div className="max-w-xl overflow-hidden rounded-md border border-border">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-border first:border-t-0">
              <Td className="w-[140px] text-muted-foreground">{k}</Td>
              <Td className="font-mono text-[11px]">
                {v != null && String(v) !== "" ? (
                  String(v)
                ) : (
                  <span className="opacity-40">—</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <label className="grid grid-cols-[120px_1fr] items-center gap-3">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
  allowEmpty,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  allowEmpty?: boolean;
}) {
  const t = useT();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
    >
      {allowEmpty && <option value="">{t("structure.selectDefault")}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/** Input estilo "tag" pra multi-select de colunas. Checkbox dropdown leve.
 *  Dropdown vai pro document.body via portal — escapa overflow:hidden dos
 *  containers de tabela. */
function ColumnMultiSelect({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const toggle = (name: string) => {
    if (value.includes(name)) onChange(value.filter((n) => n !== name));
    else onChange([...value, name]);
  };

  const onOpen = () => {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-left text-xs hover:border-conn-accent"
      >
        <span className="flex-1 truncate font-mono text-[11px]">
          {value.length > 0 ? value.join(", ") : (
            <span className="text-muted-foreground">{t("structure.placeholderChoose")}</span>
          )}
        </span>
        <span className="text-[9px] text-muted-foreground">▾</span>
      </button>
      {open && rect &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[9998]"
              onClick={() => setOpen(false)}
              onContextMenu={(e) => {
                e.preventDefault();
                setOpen(false);
              }}
            />
            <div
              className="fixed z-[9999] max-h-60 min-w-[180px] overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
              style={{
                top: rect.bottom + 4,
                left: rect.left,
                width: Math.max(180, rect.width),
              }}
            >
              {options.length === 0 ? (
                <div className="px-2 py-1 text-[11px] italic text-muted-foreground">
                  {t("structure.placeholderNoColumns")}
                </div>
              ) : (
                options.map((o) => (
                  <label
                    key={o}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      checked={value.includes(o)}
                      onChange={() => toggle(o)}
                      className="h-3 w-3"
                    />
                    <span className="flex-1 truncate font-mono text-[11px]">
                      {o}
                    </span>
                  </label>
                ))
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
