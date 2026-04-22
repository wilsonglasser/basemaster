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
  /** Versões que o user mandou "ignorar esta atualização". */
  ignoredVersions: string[];
  /** Último timestamp em que checamos (epoch ms). */
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
          // "silent" = chamada do boot: respeita lista de ignorados.
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
          // O installer no Windows (NSIS) relança o app sozinho após instalar;
          // no macOS/Linux precisamos pedir relaunch explícito. O plugin
          // process cobre os três.
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
