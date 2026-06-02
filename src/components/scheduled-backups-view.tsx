import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CalendarClock,
  Check,
  Clock,
  Copy,
  FolderOpen,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

import { ipc } from "@/lib/ipc";
import type {
  SchemaInfo,
  ScheduledBackup,
  ScheduledBackupDraft,
  Uuid,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { appAlert, appConfirm } from "@/state/app-dialog";
import { useConnections } from "@/state/connections";
import { useT } from "@/state/i18n";

interface Props {
  connectionId: Uuid;
}

interface Scope {
  schema: string;
  tables?: string[];
}

/** Form state mirrors ScheduledBackupDraft but keeps the cadence split so the
 *  UI can edit "every N minutes" vs "daily at HH:MM" without re-parsing. */
interface FormState {
  name: string;
  kind: "interval" | "daily";
  intervalMinutes: number;
  dailyAt: string;
  destDir: string;
  format: "bmbak" | "sql" | "zip";
  compression: "stored" | "deflate" | "zstd";
  compressionLevel: number;
  content: "structure" | "data" | "both";
  schemas: string[];
  retentionKeepN: string;
  retentionDays: string;
  enabled: boolean;
  acceptSshHosts: boolean;
}

const blankForm = (): FormState => ({
  name: "",
  kind: "daily",
  intervalMinutes: 60,
  dailyAt: "02:00",
  destDir: "",
  format: "bmbak",
  compression: "zstd",
  compressionLevel: 5,
  content: "both",
  schemas: [],
  retentionKeepN: "7",
  retentionDays: "",
  enabled: true,
  acceptSshHosts: false,
});

function formFromBackup(b: ScheduledBackup): FormState {
  let schemas: string[] = [];
  try {
    const scopes = JSON.parse(b.scopes_json || "[]") as Scope[];
    schemas = scopes.map((s) => s.schema).filter(Boolean);
  } catch {
    schemas = [];
  }
  const kind = b.schedule_kind === "interval" ? "interval" : "daily";
  return {
    name: b.name,
    kind,
    intervalMinutes:
      kind === "interval"
        ? Math.max(1, Math.round((Number(b.schedule_expr) || 3600) / 60))
        : 60,
    dailyAt: kind === "daily" ? b.schedule_expr || "02:00" : "02:00",
    destDir: b.dest_dir,
    format: (b.format as FormState["format"]) || "bmbak",
    compression: (b.compression as FormState["compression"]) || "zstd",
    compressionLevel: b.compression_level || 5,
    content: (b.content as FormState["content"]) || "both",
    schemas,
    retentionKeepN: b.retention_keep_n == null ? "" : String(b.retention_keep_n),
    retentionDays: b.retention_days == null ? "" : String(b.retention_days),
    enabled: b.enabled,
    acceptSshHosts: b.accept_ssh_hosts,
  };
}

function draftFromForm(f: FormState): ScheduledBackupDraft {
  const scopes: Scope[] = f.schemas.map((schema) => ({ schema }));
  const keepN = f.retentionKeepN.trim() ? Number(f.retentionKeepN) : null;
  const days = f.retentionDays.trim() ? Number(f.retentionDays) : null;
  return {
    name: f.name.trim(),
    schedule_kind: f.kind,
    schedule_expr:
      f.kind === "interval"
        ? String(Math.max(1, f.intervalMinutes) * 60)
        : f.dailyAt,
    dest_dir: f.destDir.trim(),
    format: f.format,
    compression: f.compression,
    compression_level: f.compressionLevel,
    content: f.content,
    scopes_json: JSON.stringify(scopes),
    retention_keep_n: keepN != null && Number.isFinite(keepN) ? keepN : null,
    retention_days: days != null && Number.isFinite(days) ? days : null,
    enabled: f.enabled,
    accept_ssh_hosts: f.acceptSshHosts,
  };
}

function formatTs(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}

export function ScheduledBackupsView({ connectionId }: Props) {
  const t = useT();
  const conn = useConnections((s) =>
    s.connections.find((c) => c.id === connectionId),
  );

  const [items, setItems] = useState<ScheduledBackup[]>([]);
  const [loading, setLoading] = useState(false);
  const [availSchemas, setAvailSchemas] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<Uuid | "new" | null>(null);
  const [form, setForm] = useState<FormState>(blankForm);
  const [saving, setSaving] = useState(false);
  // Per-schedule OS-scheduler registration state + "run now" in-flight set.
  const [osStatus, setOsStatus] = useState<Record<string, boolean>>({});
  const [runningNow, setRunningNow] = useState<Set<string>>(new Set());

  const loadOsStatuses = useCallback(async (list: ScheduledBackup[]) => {
    const entries = await Promise.all(
      list.map(async (b) => {
        try {
          return [b.id, await ipc.scheduledBackups.osStatus(b.id)] as const;
        } catch {
          return [b.id, false] as const;
        }
      }),
    );
    setOsStatus(Object.fromEntries(entries));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await ipc.scheduledBackups.listByConnection(connectionId);
      setItems(list);
      void loadOsStatuses(list);
    } catch (e) {
      void appAlert(`${t("scheduledBackups.loadFailed")}: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [connectionId, t, loadOsStatuses]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Schemas of the connection are best-effort: needs an open connection. On
  // failure the form falls back to free-typed schema names.
  useEffect(() => {
    let alive = true;
    ipc.db
      .listSchemas(connectionId)
      .then((s: SchemaInfo[]) => {
        if (alive) setAvailSchemas(s.map((x) => x.name));
      })
      .catch(() => {
        if (alive) setAvailSchemas([]);
      });
    return () => {
      alive = false;
    };
  }, [connectionId]);

  const startNew = () => {
    const f = blankForm();
    if (availSchemas.length === 1) f.schemas = [availSchemas[0]];
    setForm(f);
    setEditingId("new");
  };

  const startEdit = (b: ScheduledBackup) => {
    setForm(formFromBackup(b));
    setEditingId(b.id);
  };

  const cancelEdit = () => setEditingId(null);

  const pickDir = async () => {
    const dir = await openDialog({ directory: true, multiple: false });
    if (dir && !Array.isArray(dir)) setForm((f) => ({ ...f, destDir: dir }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("scheduledBackups.errNoName");
    if (!form.destDir.trim()) return t("scheduledBackups.errNoDest");
    if (form.schemas.length === 0) return t("scheduledBackups.errNoSchema");
    if (form.kind === "daily" && !/^\d{1,2}:\d{2}$/.test(form.dailyAt.trim()))
      return t("scheduledBackups.errBadTime");
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      void appAlert(err);
      return;
    }
    setSaving(true);
    try {
      const draft = draftFromForm(form);
      if (editingId === "new") {
        await ipc.scheduledBackups.create(connectionId, draft);
      } else if (editingId) {
        await ipc.scheduledBackups.update(editingId, draft);
      }
      setEditingId(null);
      await refresh();
    } catch (e) {
      void appAlert(`${t("scheduledBackups.saveFailed")}: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (b: ScheduledBackup) => {
    try {
      await ipc.scheduledBackups.setEnabled(b.id, !b.enabled);
      await refresh();
    } catch (e) {
      void appAlert(`${t("scheduledBackups.saveFailed")}: ${e}`);
    }
  };

  const remove = async (b: ScheduledBackup) => {
    const ok = await appConfirm(
      t("scheduledBackups.deleteConfirm", { name: b.name }),
    );
    if (!ok) return;
    try {
      await ipc.scheduledBackups.delete(b.id);
      await refresh();
    } catch (e) {
      void appAlert(`${t("scheduledBackups.deleteFailed")}: ${e}`);
    }
  };

  const runNow = async (b: ScheduledBackup) => {
    setRunningNow((s) => new Set(s).add(b.id));
    try {
      const file = await ipc.scheduledBackups.runNow(b.id);
      await refresh();
      void appAlert(t("scheduledBackups.runDone", { file }));
    } catch (e) {
      void appAlert(`${t("scheduledBackups.runFailed")}: ${e}`);
    } finally {
      setRunningNow((s) => {
        const n = new Set(s);
        n.delete(b.id);
        return n;
      });
    }
  };

  const registerOs = async (b: ScheduledBackup) => {
    try {
      await ipc.scheduledBackups.registerOs(b.id);
      await loadOsStatuses(items);
    } catch (e) {
      void appAlert(`${t("scheduledBackups.registerFailed")}: ${e}`);
    }
  };

  const scheduleLabel = (b: ScheduledBackup): string => {
    if (b.schedule_kind === "interval") {
      const mins = Math.max(1, Math.round((Number(b.schedule_expr) || 0) / 60));
      return t("scheduledBackups.everyMinutes", { n: mins });
    }
    if (b.schedule_kind === "daily") {
      return t("scheduledBackups.dailyAtLabel", { time: b.schedule_expr });
    }
    return b.schedule_expr;
  };

  // The OS scheduler is the real trigger; the GUI only persists the schedule.
  // Surface the exact CLI line so a headless box can register it.
  const cliCommand = (b: ScheduledBackup): string => {
    const cadence =
      b.schedule_kind === "interval"
        ? `--every-minutes ${Math.max(1, Math.round((Number(b.schedule_expr) || 0) / 60))}`
        : `--daily-at ${b.schedule_expr}`;
    return `basemaster-cli schedule run --conn ${connectionId} ${b.name}  # cadence: ${cadence}`;
  };

  const copyCli = async (b: ScheduledBackup) => {
    try {
      await navigator.clipboard.writeText(cliCommand(b));
    } catch {
      /* clipboard blocked: no-op */
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/30 px-3 text-xs">
        <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          {conn?.name} · {t("scheduledBackups.title")}
        </span>
        <span className="tabular-nums text-muted-foreground">
          ({items.length})
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={startNew}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-conn-accent px-2 text-[11px] font-medium text-conn-accent-foreground hover:opacity-90"
          >
            <Plus className="h-3 w-3" />
            {t("scheduledBackups.new")}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={t("common.refresh")}
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {editingId && (
          <ScheduleForm
            form={form}
            setForm={setForm}
            availSchemas={availSchemas}
            saving={saving}
            onPickDir={pickDir}
            onSave={save}
            onCancel={cancelEdit}
          />
        )}

        {loading && items.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            {t("common.loading")}
          </div>
        ) : items.length === 0 && !editingId ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-md px-6">
              <CalendarClock className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              <div className="text-sm text-muted-foreground">
                {t("scheduledBackups.empty")}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                {t("scheduledBackups.cliHint")}
              </p>
              <button
                type="button"
                onClick={startNew}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-conn-accent-foreground hover:opacity-90"
              >
                <Plus className="h-3 w-3" />
                {t("scheduledBackups.new")}
              </button>
            </div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card/80 backdrop-blur">
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">
                  {t("scheduledBackups.col.name")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("scheduledBackups.col.schedule")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("scheduledBackups.col.format")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("scheduledBackups.col.dest")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("scheduledBackups.col.lastRun")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("scheduledBackups.osCol")}
                </th>
                <th className="w-32" />
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr
                  key={b.id}
                  className={cn(
                    "group border-b border-border/50 hover:bg-accent/30",
                    !b.enabled && "opacity-50",
                  )}
                  onDoubleClick={() => startEdit(b)}
                >
                  <td className="px-3 py-1.5 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void toggleEnabled(b)}
                        title={
                          b.enabled
                            ? t("scheduledBackups.disable")
                            : t("scheduledBackups.enable")
                        }
                        className={cn(
                          "grid h-3.5 w-3.5 place-items-center rounded-sm border",
                          b.enabled
                            ? "border-conn-accent bg-conn-accent text-conn-accent-foreground"
                            : "border-border",
                        )}
                      >
                        {b.enabled && <Check className="h-2.5 w-2.5" />}
                      </button>
                      {b.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3 opacity-60" />
                      {scheduleLabel(b)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 uppercase text-muted-foreground">
                    {b.format}
                    {b.compression === "zstd" ? " · zstd" : ""}
                  </td>
                  <td
                    className="max-w-0 truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
                    title={b.dest_dir}
                  >
                    {b.dest_dir}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                    {b.last_run_at ? (
                      <span
                        className={cn(
                          b.last_status === "ok"
                            ? "text-emerald-500"
                            : b.last_status
                              ? "text-destructive"
                              : "",
                        )}
                        title={b.last_status ?? ""}
                      >
                        {formatTs(b.last_run_at)}
                      </span>
                    ) : (
                      <span className="italic opacity-60">
                        {t("scheduledBackups.never")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {osStatus[b.id] ? (
                      <span
                        className="inline-flex items-center gap-1 text-emerald-500"
                        title={t("scheduledBackups.osRegisteredHint")}
                      >
                        <ShieldCheck className="h-3 w-3" />
                        {t("scheduledBackups.osRegistered")}
                      </span>
                    ) : b.enabled ? (
                      <button
                        type="button"
                        onClick={() => void registerOs(b)}
                        className="inline-flex items-center gap-1 text-amber-500 hover:underline"
                        title={t("scheduledBackups.registerOs")}
                      >
                        <ShieldAlert className="h-3 w-3" />
                        {t("scheduledBackups.osMissing")}
                      </button>
                    ) : (
                      <span className="italic opacity-50">
                        {t("scheduledBackups.osOff")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => void runNow(b)}
                        disabled={runningNow.has(b.id)}
                        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        title={t("scheduledBackups.runNow")}
                      >
                        {runningNow.has(b.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Play className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyCli(b)}
                        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={t("scheduledBackups.copyCli")}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(b)}
                        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={t("common.edit")}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(b)}
                        className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                        title={t("common.delete")}
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
    </div>
  );
}

function ScheduleForm({
  form,
  setForm,
  availSchemas,
  saving,
  onPickDir,
  onSave,
  onCancel,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  availSchemas: string[];
  saving: boolean;
  onPickDir: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const toggleSchema = (name: string) =>
    setForm((f) => ({
      ...f,
      schemas: f.schemas.includes(name)
        ? f.schemas.filter((s) => s !== name)
        : [...f.schemas, name],
    }));

  return (
    <div className="border-b border-border bg-card/40 p-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-3">
        <Field label={t("scheduledBackups.form.name")}>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("scheduledBackups.form.namePlaceholder")}
            className={inputCls}
          />
        </Field>

        <Field label={t("scheduledBackups.form.schedule")}>
          <div className="flex items-center gap-1.5">
            <select
              value={form.kind}
              onChange={(e) =>
                set("kind", e.target.value as FormState["kind"])
              }
              className={selectCls}
            >
              <option value="daily">
                {t("scheduledBackups.form.kindDaily")}
              </option>
              <option value="interval">
                {t("scheduledBackups.form.kindInterval")}
              </option>
            </select>
            {form.kind === "daily" ? (
              <input
                type="time"
                value={form.dailyAt}
                onChange={(e) => set("dailyAt", e.target.value)}
                className={cn(inputCls, "w-28")}
              />
            ) : (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  value={form.intervalMinutes}
                  onChange={(e) =>
                    set("intervalMinutes", Math.max(1, Number(e.target.value)))
                  }
                  className={cn(inputCls, "w-20")}
                />
                <span className="text-[11px] text-muted-foreground">
                  {t("scheduledBackups.form.minutesUnit")}
                </span>
              </div>
            )}
          </div>
        </Field>

        <Field label={t("scheduledBackups.form.format")}>
          <select
            value={form.format}
            onChange={(e) =>
              set("format", e.target.value as FormState["format"])
            }
            className={selectCls}
          >
            <option value="bmbak">.bmbak ({t("scheduledBackups.form.fastest")})</option>
            <option value="sql">.sql</option>
            <option value="zip">.zip</option>
          </select>
        </Field>

        <Field label={t("scheduledBackups.form.compression")}>
          <div className="flex items-center gap-1.5">
            <select
              value={form.compression}
              onChange={(e) =>
                set("compression", e.target.value as FormState["compression"])
              }
              className={selectCls}
            >
              <option value="zstd">Zstd</option>
              <option value="deflate">Deflate</option>
              <option value="stored">{t("scheduledBackups.form.stored")}</option>
            </select>
            {form.compression === "zstd" && (
              <input
                type="number"
                min={1}
                max={19}
                value={form.compressionLevel}
                onChange={(e) =>
                  set(
                    "compressionLevel",
                    Math.min(19, Math.max(1, Number(e.target.value))),
                  )
                }
                className={cn(inputCls, "w-16")}
                title={t("scheduledBackups.form.level")}
              />
            )}
          </div>
        </Field>

        <Field label={t("scheduledBackups.form.content")}>
          <select
            value={form.content}
            onChange={(e) =>
              set("content", e.target.value as FormState["content"])
            }
            className={selectCls}
          >
            <option value="both">{t("scheduledBackups.form.contentBoth")}</option>
            <option value="structure">
              {t("scheduledBackups.form.contentStructure")}
            </option>
            <option value="data">
              {t("scheduledBackups.form.contentData")}
            </option>
          </select>
        </Field>

        <Field label={t("scheduledBackups.form.retention")}>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              value={form.retentionKeepN}
              onChange={(e) => set("retentionKeepN", e.target.value)}
              placeholder={t("scheduledBackups.form.keepN")}
              className={cn(inputCls, "w-20")}
              title={t("scheduledBackups.form.keepNHint")}
            />
            <input
              type="number"
              min={0}
              value={form.retentionDays}
              onChange={(e) => set("retentionDays", e.target.value)}
              placeholder={t("scheduledBackups.form.days")}
              className={cn(inputCls, "w-20")}
              title={t("scheduledBackups.form.daysHint")}
            />
          </div>
        </Field>

        <Field
          label={t("scheduledBackups.form.dest")}
          className="col-span-2 lg:col-span-3"
        >
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={form.destDir}
              onChange={(e) => set("destDir", e.target.value)}
              placeholder={t("scheduledBackups.form.destPlaceholder")}
              className={cn(inputCls, "flex-1 font-mono")}
            />
            <button
              type="button"
              onClick={onPickDir}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] hover:bg-accent"
            >
              <FolderOpen className="h-3 w-3" />
              {t("scheduledBackups.form.browse")}
            </button>
          </div>
        </Field>

        <Field
          label={t("scheduledBackups.form.schemas")}
          className="col-span-2 lg:col-span-3"
        >
          {availSchemas.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {availSchemas.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSchema(s)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[11px]",
                    form.schemas.includes(s)
                      ? "border-conn-accent bg-conn-accent/15 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : (
            <input
              type="text"
              value={form.schemas.join(", ")}
              onChange={(e) =>
                set(
                  "schemas",
                  e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
              placeholder={t("scheduledBackups.form.schemasManual")}
              className={cn(inputCls, "w-full")}
            />
          )}
        </Field>

        <label className="col-span-2 flex items-start gap-2 lg:col-span-3">
          <input
            type="checkbox"
            checked={form.acceptSshHosts}
            onChange={(e) => set("acceptSshHosts", e.target.checked)}
            className="mt-0.5"
          />
          <span className="flex flex-col">
            <span className="text-[11px] font-medium">
              {t("scheduledBackups.form.acceptSsh")}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("scheduledBackups.form.acceptSshHint")}
            </span>
          </span>
        </label>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-3 text-xs hover:bg-accent"
        >
          <X className="h-3 w-3" />
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-conn-accent px-3 text-xs font-medium text-conn-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

const inputCls =
  "h-7 rounded border border-border bg-background px-2 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40";
const selectCls =
  "h-7 rounded border border-border bg-background px-2 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40";

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
