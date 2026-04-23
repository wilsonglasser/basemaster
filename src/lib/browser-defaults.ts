/** Disables default WebView behavior (reload, devtools, browser context
 *  menu, etc.) to make the app feel native.
 *  In dev, DevTools (F12) stays enabled for debugging. */
export function installBrowserDefaultPrevention() {
  const isDev = import.meta.env.DEV;

  const onKey = (e: KeyboardEvent) => {
    const key = e.key;
    const low = key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    // Reload: F5, Ctrl/Cmd+R, Ctrl/Cmd+Shift+R, Ctrl+F5.
    if (key === "F5") return block(e);
    if (mod && low === "r") return block(e);

    // DevTools in production.
    if (!isDev) {
      if (key === "F12") return block(e);
      if (mod && e.shiftKey && (low === "i" || low === "j" || low === "c")) {
        return block(e);
      }
    }

    // Print, Save as, Open file (browser-native, useless in an app).
    if (mod && !e.shiftKey && !e.altKey) {
      if (low === "p") return block(e); // print
      if (low === "o") return block(e); // browser open-file
      // Ctrl+S intentionally NOT blocked — used by query.save
    }
  };

  const onContext = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    // Allow the native menu only in inputs/textareas/contenteditable —
    // useful for spellcheck, cut/paste, etc.
    if (t) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (t.isContentEditable) return;
    }
    e.preventDefault();
  };

  // Block drag-drop of external FILES into the window — internal drags
  // (connection → folder, etc) pass through normally.
  const isFileDrag = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDrop = (e: DragEvent) => {
    if (isFileDrag(e)) e.preventDefault();
  };
  const onDragover = (e: DragEvent) => {
    if (isFileDrag(e)) e.preventDefault();
  };

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("contextmenu", onContext);
  window.addEventListener("drop", onDrop);
  window.addEventListener("dragover", onDragover);

  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("contextmenu", onContext);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("dragover", onDragover);
  };
}

function block(e: Event) {
  e.preventDefault();
  e.stopPropagation();
}
