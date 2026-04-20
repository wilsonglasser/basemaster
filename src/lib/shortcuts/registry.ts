import type { ShortcutAction } from "./types";

/** Catálogo estático. IDs são chaves estáveis — NÃO renomear sem migração.
 *  Labels/descriptions são pro UI (Settings). */
export const SHORTCUTS: ShortcutAction[] = [
  // --- Query editor ---
  {
    id: "query.run",
    category: "Editor SQL",
    label: "Executar query",
    defaultBinding: "Mod+Enter",
    scope: "editor",
  },
  {
    id: "query.format",
    category: "Editor SQL",
    label: "Formatar SQL",
    defaultBinding: "Mod+Shift+F",
    scope: "editor",
  },
  {
    id: "query.toggleComment",
    category: "Editor SQL",
    label: "Toggle comentário",
    defaultBinding: "Mod+/",
    scope: "editor",
  },
  {
    id: "query.save",
    category: "Editor SQL",
    label: "Salvar query",
    defaultBinding: "Mod+S",
    scope: "global",
  },
  {
    id: "query.searchResult",
    category: "Editor SQL",
    label: "Buscar no resultado",
    defaultBinding: "Mod+F",
    scope: "global",
  },

  // --- Tabs ---
  {
    id: "tab.newQuery",
    category: "Abas",
    label: "Nova query",
    description: "Abre uma nova aba de query na conexão focada",
    defaultBinding: "Mod+T",
    scope: "global",
  },
  {
    id: "tab.close",
    category: "Abas",
    label: "Fechar aba",
    defaultBinding: "Mod+W",
    scope: "global",
  },
  {
    id: "tab.next",
    category: "Abas",
    label: "Próxima aba",
    defaultBinding: "Ctrl+Tab",
    scope: "global",
  },
  {
    id: "tab.prev",
    category: "Abas",
    label: "Aba anterior",
    defaultBinding: "Ctrl+Shift+Tab",
    scope: "global",
  },

  // --- Table / Structure ---
  {
    id: "table.openStructure",
    category: "Tabela",
    label: "Abrir estrutura (Alter Table)",
    description:
      "Abre/foca a tabela selecionada na sub-aba Estrutura. Se já está em TableView, alterna pra Estrutura.",
    defaultBinding: "Mod+D",
    scope: "global",
  },
  {
    id: "table.refresh",
    category: "Tabela",
    label: "Recarregar",
    defaultBinding: "F5",
    scope: "global",
  },

  // --- Layout ---
  {
    id: "layout.toggleSidebar",
    category: "Layout",
    label: "Toggle sidebar esquerda",
    defaultBinding: "Mod+B",
    scope: "global",
    allowInInputs: true,
  },
  {
    id: "layout.toggleAi",
    category: "Layout",
    label: "Toggle sidebar direita (IA)",
    defaultBinding: "Mod+J",
    scope: "global",
    allowInInputs: true,
  },

  // --- View / Zoom ---
  {
    id: "view.zoomIn",
    category: "Visualização",
    label: "Zoom in",
    defaultBinding: "Mod+=",
    scope: "global",
    allowInInputs: true,
  },
  {
    id: "view.zoomOut",
    category: "Visualização",
    label: "Zoom out",
    defaultBinding: "Mod+-",
    scope: "global",
    allowInInputs: true,
  },
  {
    id: "view.zoomReset",
    category: "Visualização",
    label: "Zoom 100%",
    defaultBinding: "Mod+0",
    scope: "global",
    allowInInputs: true,
  },
  {
    id: "view.fullscreen",
    category: "Visualização",
    label: "Tela cheia (modo apresentação)",
    description: "F11 — entra em fullscreen com zoom aumentado",
    defaultBinding: "F11",
    scope: "global",
    allowInInputs: true,
  },

  // --- Rename ---
  {
    id: "rename.selected",
    category: "Geral",
    label: "Renomear item selecionado",
    description: "Renomeia tabela/schema/conexão/pasta selecionado",
    defaultBinding: "F2",
    scope: "global",
  },

  // --- Global ---
  {
    id: "global.palette",
    category: "Geral",
    label: "Command Palette",
    description: "Abre paleta de comandos (em breve)",
    defaultBinding: "Mod+K",
    scope: "global",
    allowInInputs: true,
  },
  {
    id: "global.cheatsheet",
    category: "Geral",
    label: "Mostrar todos atalhos",
    defaultBinding: "Mod+/",
    scope: "global",
    allowInInputs: true,
  },
  {
    id: "global.settings",
    category: "Geral",
    label: "Abrir configurações",
    defaultBinding: "Mod+,",
    scope: "global",
    allowInInputs: true,
  },
];

export function actionById(id: string): ShortcutAction | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
