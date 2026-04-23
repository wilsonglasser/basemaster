import { useState } from "react";
import {
  Filter as FilterIcon,
  FolderPlus,
  Plus,
  X,
} from "lucide-react";

import type {
  Column,
  Filter,
  FilterNode,
  FilterOp,
  GroupOp,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";

interface Props {
  columns: readonly string[];
  /** Metadata das colunas pra habilitar autocomplete de enum/bool etc. */
  columnMeta?: readonly Column[];
  tree: FilterNode;
  onChange: (next: FilterNode) => void;
}

type ValueKind = "none" | "single" | "double" | "csv" | "custom";


/** Kinds per op — label comes from i18n. Stable list for the dropdown. */
const OPS: Array<{ value: FilterOp; kind: ValueKind }> = [
  { value: "eq", kind: "single" },
  { value: "not_eq", kind: "single" },
  { value: "gt", kind: "single" },
  { value: "lt", kind: "single" },
  { value: "gte", kind: "single" },
  { value: "lte", kind: "single" },
  { value: "contains", kind: "single" },
  { value: "not_contains", kind: "single" },
  { value: "begins_with", kind: "single" },
  { value: "not_begins_with", kind: "single" },
  { value: "ends_with", kind: "single" },
  { value: "not_ends_with", kind: "single" },
  { value: "is_null", kind: "none" },
  { value: "is_not_null", kind: "none" },
  { value: "is_empty", kind: "none" },
  { value: "is_not_empty", kind: "none" },
  { value: "between", kind: "double" },
  { value: "not_between", kind: "double" },
  { value: "in", kind: "csv" },
  { value: "not_in", kind: "csv" },
  { value: "custom", kind: "custom" },
];

function opKind(op: FilterOp): ValueKind {
  return OPS.find((o) => o.value === op)?.kind ?? "single";
}

function hintFor(op: FilterOp): "between" | "csv" | "custom" | undefined {
  const k = opKind(op);
  if (k === "double") return "between";
  if (k === "csv") return "csv";
  if (k === "custom") return "custom";
  return undefined;
}

function findMeta(
  meta: readonly Column[] | undefined,
  name: string,
): Column | undefined {
  return meta?.find((c) => c.name === name);
}

function enumValuesOf(col: Column | undefined) {
  if (!col) return undefined;
  if (col.column_type.kind === "enum") return col.column_type.values;
  return undefined;
}

function boolOptionsOf(col: Column | undefined) {
  if (!col) return undefined;
  if (col.column_type.kind === "boolean") return ["1", "0"];
  return undefined;
}

function strValue(text: string) {
  return { type: "string" as const, value: text };
}

function valueAsText(v: Filter["value"]): string {
  if (!v || v.type === "null") return "";
  switch (v.type) {
    case "string":
    case "decimal":
    case "date":
    case "time":
    case "date_time":
    case "timestamp":
      return v.value;
    case "int":
    case "u_int":
    case "float":
      return String(v.value);
    case "bool":
      return v.value ? "1" : "0";
    default:
      return "";
  }
}

/** How many filters (leaves) exist in the tree — used for the badge. */
export function countLeaves(n: FilterNode | null | undefined): number {
  if (!n) return 0;
  if (n.kind === "leaf") return 1;
  return n.children.reduce((acc, c) => acc + countLeaves(c), 0);
}

export function emptyRoot(): FilterNode {
  return { kind: "group", op: "and", children: [] };
}

export function leavesToTree(filters: Filter[]): FilterNode {
  return {
    kind: "group",
    op: "and",
    children: filters.map((f) => ({ kind: "leaf", filter: f })),
  };
}

export function FilterBar({ columns, columnMeta, tree, onChange }: Props) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-border bg-card/20 px-3 py-1.5">
      <FilterIcon className="mt-1.5 h-3 w-3 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <GroupEditor
          node={tree}
          columns={columns}
          columnMeta={columnMeta}
          onChange={onChange}
          isRoot
        />
      </div>
    </div>
  );
}

function GroupEditor({
  node,
  columns,
  columnMeta,
  onChange,
  onRemove,
  isRoot,
}: {
  node: FilterNode;
  columns: readonly string[];
  columnMeta?: readonly Column[];
  onChange: (next: FilterNode) => void;
  onRemove?: () => void;
  isRoot?: boolean;
}) {
  const t = useT();
  if (node.kind !== "group") {
    // Shouldn't happen (GroupEditor called with leaf)
    return null;
  }
  const { op, children } = node;

  const patchChild = (idx: number, next: FilterNode | null) => {
    const newChildren = children.slice();
    if (next === null) newChildren.splice(idx, 1);
    else newChildren[idx] = next;
    onChange({ ...node, children: newChildren });
  };
  const addCondition = () => {
    const newLeaf: FilterNode = {
      kind: "leaf",
      filter: {
        column: columns[0] ?? "",
        op: "eq",
        value: { type: "string", value: "" },
      },
    };
    onChange({ ...node, children: [...children, newLeaf] });
  };
  const addGroup = () => {
    const newGroup: FilterNode = {
      kind: "group",
      op: "and",
      children: [],
    };
    onChange({ ...node, children: [...children, newGroup] });
  };
  const toggleOp = (nextOp: GroupOp) => {
    onChange({ ...node, op: nextOp });
  };

  return (
    <div
      className={cn(
        "rounded-md border p-1.5",
        isRoot
          ? "border-transparent"
          : "border-border/60 bg-background/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <OpToggle op={op} onChange={toggleOp} />
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {children.length === 0 && (
            <span className="text-[11px] italic text-muted-foreground">
              {isRoot ? t("filters.none") : t("filters.emptyGroup")}
            </span>
          )}
          {children.map((child, i) => {
            if (child.kind === "leaf") {
              return (
                <LeafChip
                  key={i}
                  filter={child.filter}
                  columns={columns}
                  columnMeta={columnMeta}
                  onChange={(f) =>
                    patchChild(i, { kind: "leaf", filter: f })
                  }
                  onRemove={() => patchChild(i, null)}
                />
              );
            }
            return (
              <div key={i} className="w-full">
                <GroupEditor
                  node={child}
                  columns={columns}
                  columnMeta={columnMeta}
                  onChange={(next) => patchChild(i, next)}
                  onRemove={() => patchChild(i, null)}
                />
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={addCondition}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("filters.addCondition")}
          >
            <Plus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={addGroup}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("filters.addGroup")}
          >
            <FolderPlus className="h-3 w-3" />
          </button>
          {!isRoot && onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="grid h-4 w-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
              title={t("filters.removeGroup")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
          {isRoot && children.length > 0 && (
            <button
              type="button"
              onClick={() =>
                onChange({ kind: "group", op: "and", children: [] })
              }
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t("filters.clear")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function OpToggle({
  op,
  onChange,
}: {
  op: GroupOp;
  onChange: (next: GroupOp) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(op === "and" ? "or" : "and")}
      className="rounded-full bg-conn-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-conn-accent-foreground transition-opacity hover:opacity-85"
      title="Clique pra alternar AND/OR"
    >
      {op === "and" ? "AND" : "OR"}
    </button>
  );
}

function LeafChip({
  filter,
  columns,
  columnMeta,
  onChange,
  onRemove,
}: {
  filter: Filter;
  columns: readonly string[];
  columnMeta?: readonly Column[];
  onChange: (f: Filter) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [col, setCol] = useState(filter.column);
  const [op, setOp] = useState<FilterOp>(filter.op);
  const [value, setValue] = useState(valueAsText(filter.value));
  const [value2, setValue2] = useState(valueAsText(filter.value2));

  const currentMeta = findMeta(columnMeta, col);
  const enumValues = enumValuesOf(currentMeta);
  const boolOptions = boolOptionsOf(currentMeta);
  const kind = opKind(op);
  const hintKey = hintFor(op);
  const simpleOp = op === "eq" || op === "not_eq";
  const valueOptions = simpleOp ? enumValues ?? boolOptions : undefined;

  const commit = () => {
    if (!col) return;
    const next: Filter =
      kind === "none"
        ? { column: col, op, value: null }
        : kind === "double"
          ? {
              column: col,
              op,
              value: strValue(value),
              value2: strValue(value2),
            }
          : { column: col, op, value: strValue(value) };
    onChange(next);
    setEditing(false);
  };
  const cancel = () => {
    setCol(filter.column);
    setOp(filter.op);
    setValue(valueAsText(filter.value));
    setValue2(valueAsText(filter.value2));
    setEditing(false);
  };

  if (!editing) {
    const fKind = opKind(filter.op);
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "group inline-flex items-center gap-1 rounded-full border border-border bg-accent/40 pl-2 pr-1 py-0.5 text-[11px]",
          "hover:border-conn-accent/60 hover:bg-accent/60",
        )}
      >
        <span className="font-mono text-muted-foreground">{filter.column}</span>
        <span className="text-muted-foreground/80">
          {t(`filters.ops.${filter.op}`)}
        </span>
        {fKind === "double" ? (
          <span className="font-mono">
            {valueAsText(filter.value)} — {valueAsText(filter.value2)}
          </span>
        ) : fKind !== "none" ? (
          <span className="max-w-[160px] truncate font-mono">
            {valueAsText(filter.value)}
          </span>
        ) : null}
        <span
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="grid h-3.5 w-3.5 place-items-center rounded-full text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
        >
          <X className="h-2.5 w-2.5" />
        </span>
      </button>
    );
  }

  const selectCls =
    "rounded bg-popover px-1 text-popover-foreground focus:outline-none";
  const textCls =
    "rounded border border-border bg-background px-1 font-mono focus:border-conn-accent focus:outline-none";

  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-conn-accent/60 bg-card px-1.5 py-0.5 text-[11px]">
      <select
        value={col}
        onChange={(e) => setCol(e.target.value)}
        className={cn(selectCls, "font-mono")}
      >
        {columns.map((c) => (
          <option key={c} value={c} className="bg-popover text-popover-foreground">
            {c}
          </option>
        ))}
      </select>
      <select
        value={op}
        onChange={(e) => setOp(e.target.value as FilterOp)}
        className={selectCls}
      >
        {OPS.map((o) => (
          <option
            key={o.value}
            value={o.value}
            className="bg-popover text-popover-foreground"
          >
            {t(`filters.ops.${o.value}`)}
          </option>
        ))}
      </select>

      {kind === "single" && valueOptions ? (
        <select
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          className={cn(selectCls, "w-28 border border-border font-mono")}
        >
          <option value="" className="bg-popover text-popover-foreground">
            {t("filters.placeholders.choose")}
          </option>
          {valueOptions.map((v) => (
            <option
              key={v}
              value={v}
              className="bg-popover text-popover-foreground"
            >
              {v}
            </option>
          ))}
        </select>
      ) : kind === "single" ? (
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          list={enumValues ? `enum-${col}` : undefined}
          placeholder={hintKey ? t(`filters.hints.${hintKey}`) : undefined}
          className={cn(textCls, "w-32")}
        />
      ) : kind === "double" ? (
        <>
          <input
            type="text"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") cancel();
            }}
            placeholder={t("filters.placeholders.min")}
            className={cn(textCls, "w-20")}
          />
          <span className="text-muted-foreground">…</span>
          <input
            type="text"
            value={value2}
            onChange={(e) => setValue2(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") cancel();
            }}
            placeholder={t("filters.placeholders.max")}
            className={cn(textCls, "w-20")}
          />
        </>
      ) : kind === "csv" ? (
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          placeholder={hintKey ? t(`filters.hints.${hintKey}`) : undefined}
          className={cn(textCls, "w-40")}
        />
      ) : kind === "custom" ? (
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          placeholder={hintKey ? t(`filters.hints.${hintKey}`) : undefined}
          title={t("filters.customTitle")}
          className={cn(textCls, "w-48 border-amber-500/60")}
        />
      ) : null}

      {enumValues && !valueOptions && kind === "single" && (
        <datalist id={`enum-${col}`}>
          {enumValues.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      )}
      <button
        type="button"
        onClick={commit}
        className="rounded-full bg-emerald-500 px-1.5 py-0 text-white hover:opacity-90"
      >
        ok
      </button>
      <button
        type="button"
        onClick={cancel}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
