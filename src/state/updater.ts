import { create } from "zustand";
import { persist } from "zustand/middleware";
import { check, type Update } from "@tauri-apps/plugin-updater";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; downloaded: number; total: number | null }
  | { kind: "ready"; update: Update }
  | { kind: "error"; message: string };

interface UpdaterState {
  status: Status;
  /** Versions the user has told to "ignore this update". */
  ignoredVersions: string[];
  /** Last timestamp we checked (epoch ms). */
  lastCheckedAt: number | null;

  checkNow: (opts?: { silent?: boolean }) => Promise<void>;
  ignoreCurrent: () => void;
  dismiss: () => void;
  downloadAndInstall: () => Promise<void>;
}

export const useUpdater = create<UpdaterState>()(
  persist(
    (set, get) => ({
      status: { kind: "idle" },
      ignoredVersions: [],
      lastCheckedAt: null,

      async checkNow(opts) {
        const prev = get().status;
        if (prev.kind === "checking" || prev.kind === "downloading") return;
        set({ status: { kind: "checking" } });
        try {
          const update = await check();
          set({ lastCheckedAt: Date.now() });
          if (!update) {
            set({ status: { kind: "idle" } });
            return;
          }
          // "silent" = boot call: respects the ignored list.
          if (opts?.silent && get().ignoredVersions.includes(update.version)) {
            set({ status: { kind: "idle" } });
            return;
          }
          set({ status: { kind: "available", update } });
        } catch (e) {
          set({
            status: {
              kind: "error",
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
      },

      ignoreCurrent() {
        const s = get().status;
        if (s.kind !== "available") return;
        const v = s.update.version;
        set({
          ignoredVersions: Array.from(new Set([...get().ignoredVersions, v])),
          status: { kind: "idle" },
        });
      },

      dismiss() {
        set({ status: { kind: "idle" } });
      },

      async downloadAndInstall() {
        const s = get().status;
        if (s.kind !== "available") return;
        const update = s.update;
        let total: number | null = null;
        let downloaded = 0;
        set({ status: { kind: "downloading", update, downloaded: 0, total: null } });
        try {
          await update.downloadAndInstall((event) => {
            if (event.event === "Started") {
              total = event.data.contentLength ?? null;
              set({ status: { kind: "downloading", update, downloaded: 0, total } });
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              set({ status: { kind: "downloading", update, downloaded, total } });
            } else if (event.event === "Finished") {
              set({ status: { kind: "ready", update } });
            }
          });
          // The installer on Windows (NSIS) relaunches the app on its own after
          // installing; on macOS/Linux we need an explicit relaunch. The
          // process plugin covers all three.
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        } catch (e) {
          set({
            status: {
              kind: "error",
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
      },
    }),
    {
      name: "basemaster.updater",
      partialize: (s) => ({
        ignoredVersions: s.ignoredVersions,
        lastCheckedAt: s.lastCheckedAt,
      }),
    },
  ),
);
