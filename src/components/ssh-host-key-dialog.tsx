import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { KeyRound, ShieldAlert, X } from "lucide-react";

import { ipc } from "@/lib/ipc";
import type { SshHostKeyPrompt } from "@/lib/types";
import { useT } from "@/state/i18n";

/** Queue of pending prompts. The backend fires one per hop/host on first
 *  contact; if the user opens two connections fast, multiple prompts can
 *  stack. We resolve them in order. */
export function SshHostKeyDialog() {
  const t = useT();
  const [queue, setQueue] = useState<SshHostKeyPrompt[]>([]);
  const current = queue[0];

  useEffect(() => {
    const off = listen<SshHostKeyPrompt>("ssh-host-key-prompt", (e) => {
      setQueue((prev) => [...prev, e.payload]);
    });
    return () => {
      off.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const respond = (accept: boolean) => {
    if (!current) return;
    const id = current.request_id;
    setQueue((prev) => prev.slice(1));
    ipc.ssh.respondKey(id, accept).catch((err) => {
      console.warn("ssh_host_key_respond:", err);
    });
  };

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        respond(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.request_id]);

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={() => respond(false)}
    >
      <div
        className="flex w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border bg-card/40 px-4 py-2.5">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          <h2 className="flex-1 text-sm font-semibold">
            {t("sshHostKey.title")}
          </h2>
          <button
            type="button"
            onClick={() => respond(false)}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("common.cancel")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-3">
          <p className="whitespace-pre-wrap text-xs text-foreground/90">
            {t("sshHostKey.body", { host: current.host, port: current.port })}
          </p>

          <div className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2">
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>{current.algorithm}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>SHA-256</span>
              </div>
              <div className="break-all font-mono text-[11px] text-foreground">
                {current.fingerprint_sha256}
              </div>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t("sshHostKey.tip")}
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-2.5">
          <button
            type="button"
            onClick={() => respond(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            {t("sshHostKey.reject")}
          </button>
          <button
            type="button"
            onClick={() => respond(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
          >
            {t("sshHostKey.accept")}
          </button>
        </footer>
      </div>
    </div>
  );
}
