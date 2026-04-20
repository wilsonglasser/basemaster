/** Desabilita comportamentos default do WebView (reload, devtools, context
 *  menu do browser, etc.) pra deixar a app se parecer com um app nativo.
 *  Em dev, DevTools (F12) continua habilitado pra debugging. */
export function installBrowserDefaultPrevention() {
  const isDev = import.meta.env.DEV;

  const onKey = (e: KeyboardEvent) => {
    const key = e.key;
    const low = key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    // Reload: F5, Ctrl/Cmd+R, Ctrl/Cmd+Shift+R, Ctrl+F5.
    if (key === "F5") return block(e);
    if (mod && low === "r") return block(e);

    // DevTools em produção.
    if (!isDev) {
      if (key === "F12") return block(e);
      if (mod && e.shiftKey && (low === "i" || low === "j" || low === "c")) {
        return block(e);
      }
    }

    // Print, Save as, Open file (browser-native, inúteis num app).
    if (mod && !e.shiftKey && !e.altKey) {
      if (low === "p") return block(e); // print
      if (low === "o") return block(e); // browser open-file
      // Ctrl+S intencionalmente NÃO bloqueado — é usado por query.save
    }
  };

  const onContext = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    // Permite o menu nativo só em inputs/textareas/contenteditable —
    // útil pro corretor ortográfico, recortar/colar, etc.
    if (t) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (t.isContentEditable) return;
    }
    e.preventDefault();
  };

  // Bloqueia drag-drop de ARQUIVOS externos pra janela — deixa drags
  // internos (conexão → pasta, etc) passarem normalmente.
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
