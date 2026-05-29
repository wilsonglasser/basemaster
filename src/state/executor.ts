import { create } from "zustand";

import { ipc } from "@/lib/ipc";

/**
 * Sequential job runner with a live progress UI — for bulk operations that
 * fire many queries (bulk drop/truncate/empty/duplicate, maintenance). Each
 * job runs in order; the dialog shows per-row ok/error and a final summary,
 * mirroring the per-table feedback of the data-transfer wizard. Also drives
 * the OS taskbar progress bar.
 *
 * Imperative API: `runExecutor(title, jobs)` resolves with the results once
 * every job has run (the dialog stays open for the user to inspect). One
 * batch at a time — the modal overlay blocks concurrent triggers.
 */

export type JobStatus = "pending" | "running" | "ok" | "error" | "skipped";

export interface ExecutorJob {
  id: string;
  label: string;
  /** Runs the job. Throw to mark the row as failed (message is shown). */
  run: () => Promise<unknown>;
}

export interface JobState {
  id: string;
  label: string;
  status: JobStatus;
  error: string | null;
}

export interface ExecutorResult {
  ok: number;
  failed: number;
  /** Per-job outcome in original order — `error === null` means success. */
  results: { id: string; label: string; error: string | null }[];
}

interface ExecutorState {
  open: boolean;
  title: string;
  jobs: JobState[];
  running: boolean;
  cancelRequested: boolean;
  run: (title: string, jobs: ExecutorJob[]) => Promise<ExecutorResult>;
  requestCancel: () => void;
  close: () => void;
}

const setTaskbar = (
  status: "none" | "normal" | "indeterminate" | "paused" | "error",
  progress?: number,
) => {
  void ipc.taskbar.setProgress(status, progress).catch(() => {});
};

export const useExecutor = create<ExecutorState>((set, get) => ({
  open: false,
  title: "",
  jobs: [],
  running: false,
  cancelRequested: false,

  async run(title, jobs) {
    set({
      open: true,
      title,
      running: true,
      cancelRequested: false,
      jobs: jobs.map((j) => ({
        id: j.id,
        label: j.label,
        status: "pending" as JobStatus,
        error: null,
      })),
    });

    const total = jobs.length;
    const results: ExecutorResult["results"] = [];

    const patch = (i: number, next: Partial<JobState>) =>
      set((s) => ({
        jobs: s.jobs.map((j, idx) => (idx === i ? { ...j, ...next } : j)),
      }));

    for (let i = 0; i < jobs.length; i++) {
      if (get().cancelRequested) {
        // Mark this and everything after as skipped, then stop.
        set((s) => ({
          jobs: s.jobs.map((j, idx) =>
            idx >= i && j.status === "pending"
              ? { ...j, status: "skipped" as JobStatus }
              : j,
          ),
        }));
        for (let k = i; k < jobs.length; k++) {
          results.push({ id: jobs[k].id, label: jobs[k].label, error: null });
        }
        break;
      }

      patch(i, { status: "running" });
      setTaskbar("normal", Math.round((i / total) * 100));

      try {
        await jobs[i].run();
        patch(i, { status: "ok" });
        results.push({ id: jobs[i].id, label: jobs[i].label, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        patch(i, { status: "error", error: msg });
        results.push({ id: jobs[i].id, label: jobs[i].label, error: msg });
      }
    }

    const failed = results.filter((r) => r.error !== null).length;
    const ok = results.length - failed;
    set({ running: false });
    // Leave the bar red when something failed so the user notices even if
    // the window isn't focused; cleared on close.
    setTaskbar(failed > 0 ? "error" : "none", 100);

    return { ok, failed, results };
  },

  requestCancel() {
    if (get().running) set({ cancelRequested: true });
  },

  close() {
    if (get().running) return;
    setTaskbar("none");
    set({ open: false, jobs: [], title: "" });
  },
}));

/** Run a batch of jobs through the executor dialog. Resolves once all jobs
 *  have run; the dialog remains open for inspection until the user closes. */
export const runExecutor = (title: string, jobs: ExecutorJob[]) =>
  useExecutor.getState().run(title, jobs);
