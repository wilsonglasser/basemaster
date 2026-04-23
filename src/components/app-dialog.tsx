import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { useT } from "@/state/i18n";
import { cn } from "@/lib/utils";
import { useAppDialog } from "@/state/app-dialog";

export function AppDialog() {
  const t = useT();
  const pending = useAppDialog((s) => s.pending);
  const dismiss = useAppDialog((s) => s.dismissWith);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the draft on each new prompt.
  useEffect(() => {
    if (pending?.kind === "prompt") {
      setDraft(pending.defaultValue ?? "");
      // Focus + select-all on the next tick so browser autoFocus
      // doesn't get lost to the destructive-confirm checkbox, which is also modal.
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [pending?.id, pending?.kind]);

  // Esc cancels; Enter confirms.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (pending.kind === "alert") dismiss("alert", undefined);
        else if (pending.kind === "confirm") dismiss("confirm", false);
        else dismiss("prompt", null);
      } else if (e.key === "Enter") {
        // Enter inside the prompt input is already handled by the local onKeyDown.
        if (pending.kind === "prompt") return;
        e.preventDefault();
        if (pending.kind === "alert") dismiss("alert", undefined);
        else dismiss("confirm", true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, dismiss, draft]);

  if (!pending) return null;

  const defaultTitle =
    pending.kind === "alert"
      ? t("appDialog.alertTitle")
      : pending.kind === "confirm"
        ? t("appDialog.confirmTitle")
        : t("appDialog.promptTitle");
  const title = pending.title ?? defaultTitle;

  const okLabel =
    pending.kind === "alert"
      ? (pending.okLabel ?? t("common.ok"))
      : pending.kind === "confirm"
        ? (pending.okLabel ?? t("common.confirm"))
        : (pending.okLabel ?? t("common.ok"));
  const cancelLabel =
    pending.kind === "alert"
      ? null
      : pending.kind === "confirm"
        ? (pending.cancelLabel ?? t("common.cancel"))
        : (pending.cancelLabel ?? t("common.cancel"));

  const onCancel = () => {
    if (pending.kind === "alert") dismiss("alert", undefined);
    else if (pending.kind === "confirm") dismiss("confirm", false);
    else dismiss("prompt", null);
  };
  const onOk = () => {
    if (pending.kind === "alert") dismiss("alert", undefined);
    else if (pending.kind === "confirm") dismiss("confirm", true);
    else dismiss("prompt", draft);
  };

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="flex w-[460px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border bg-card/40 px-4 py-2.5">
          <h2 className="flex-1 text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("common.cancel")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="whitespace-pre-wrap text-xs text-foreground/90">
            {pending.message}
          </p>

          {pending.kind === "prompt" && (
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={pending.placeholder}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  dismiss("prompt", draft);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  dismiss("prompt", null);
                }
              }}
              className="mt-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40"
            />
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-2.5">
          {cancelLabel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onOk}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md bg-conn-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90",
            )}
          >
            {okLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
