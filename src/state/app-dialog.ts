import { create } from "zustand";

/**
 * Replaces window.alert/confirm/prompt with custom modals — avoids the
 * native webview's "tauri.localhost says…" and allows styling.
 *
 * Contract: one pending at a time. If another request arrives with one
 * active, the previous one resolves with cancel (alert → undefined,
 * confirm → false, prompt → null) and the new one takes over. Same
 * strategy as useDestructive.
 */

type Kind = "alert" | "confirm" | "prompt";

interface AlertReq {
  kind: "alert";
  id: string;
  title?: string;
  message: string;
  okLabel?: string;
  resolve: () => void;
}

interface ConfirmReq {
  kind: "confirm";
  id: string;
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  resolve: (confirmed: boolean) => void;
}

interface PromptReq {
  kind: "prompt";
  id: string;
  title?: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  okLabel?: string;
  cancelLabel?: string;
  resolve: (value: string | null) => void;
}

export type PendingAppDialog = AlertReq | ConfirmReq | PromptReq;

interface AppDialogState {
  pending: PendingAppDialog | null;
  alert: (
    message: string,
    opts?: { title?: string; okLabel?: string },
  ) => Promise<void>;
  confirm: (
    message: string,
    opts?: { title?: string; okLabel?: string; cancelLabel?: string },
  ) => Promise<boolean>;
  prompt: (
    message: string,
    opts?: {
      title?: string;
      defaultValue?: string;
      placeholder?: string;
      okLabel?: string;
      cancelLabel?: string;
    },
  ) => Promise<string | null>;
  dismissWith: (kind: Kind, payload: unknown) => void;
}

function cancelValueFor(kind: Kind): unknown {
  switch (kind) {
    case "alert":
      return undefined;
    case "confirm":
      return false;
    case "prompt":
      return null;
  }
}

export const useAppDialog = create<AppDialogState>((set, get) => ({
  pending: null,

  alert(message, opts) {
    return new Promise<void>((resolve) => {
      const prev = get().pending;
      if (prev) {
        (prev.resolve as (v: unknown) => void)(cancelValueFor(prev.kind));
      }
      set({
        pending: {
          kind: "alert",
          id: crypto.randomUUID(),
          title: opts?.title,
          message,
          okLabel: opts?.okLabel,
          resolve,
        },
      });
    });
  },

  confirm(message, opts) {
    return new Promise<boolean>((resolve) => {
      const prev = get().pending;
      if (prev) {
        (prev.resolve as (v: unknown) => void)(cancelValueFor(prev.kind));
      }
      set({
        pending: {
          kind: "confirm",
          id: crypto.randomUUID(),
          title: opts?.title,
          message,
          okLabel: opts?.okLabel,
          cancelLabel: opts?.cancelLabel,
          resolve,
        },
      });
    });
  },

  prompt(message, opts) {
    return new Promise<string | null>((resolve) => {
      const prev = get().pending;
      if (prev) {
        (prev.resolve as (v: unknown) => void)(cancelValueFor(prev.kind));
      }
      set({
        pending: {
          kind: "prompt",
          id: crypto.randomUUID(),
          title: opts?.title,
          message,
          defaultValue: opts?.defaultValue,
          placeholder: opts?.placeholder,
          okLabel: opts?.okLabel,
          cancelLabel: opts?.cancelLabel,
          resolve,
        },
      });
    });
  },

  dismissWith(kind, payload) {
    const cur = get().pending;
    if (!cur || cur.kind !== kind) return;
    set({ pending: null });
    (cur.resolve as (v: unknown) => void)(payload);
  },
}));

/** Global helpers — preserve the ergonomics of window.alert/confirm/prompt
 *  without the hook. Use in handlers outside components. */
export const appAlert = (
  message: string,
  opts?: { title?: string; okLabel?: string },
) => useAppDialog.getState().alert(message, opts);

export const appConfirm = (
  message: string,
  opts?: { title?: string; okLabel?: string; cancelLabel?: string },
) => useAppDialog.getState().confirm(message, opts);

export const appPrompt = (
  message: string,
  opts?: {
    title?: string;
    defaultValue?: string;
    placeholder?: string;
    okLabel?: string;
    cancelLabel?: string;
  },
) => useAppDialog.getState().prompt(message, opts);
