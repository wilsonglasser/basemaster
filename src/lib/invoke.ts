import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** Real Error wrapper around Tauri's string rejections. Lets Sentry/devtools
 *  see a proper stack and the failing command instead of a bare string. */
export class IpcError extends Error {
  readonly command: string;
  readonly original: unknown;
  constructor(command: string, original: unknown) {
    super(typeof original === "string" ? original : String(original));
    this.name = "IpcError";
    this.command = command;
    this.original = original;
  }
}

/** Drop-in replacement for `@tauri-apps/api/core`'s `invoke`. Captures the
 *  caller's stack synchronously so a rejection has a meaningful trace —
 *  Tauri rejects with a bare string and V8 won't synthesize a stack for that. */
export function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const caller = new Error();
  return tauriInvoke<T>(command, args).catch((e: unknown) => {
    const err = new IpcError(command, e);
    if (caller.stack) err.stack = caller.stack;
    throw err;
  });
}
