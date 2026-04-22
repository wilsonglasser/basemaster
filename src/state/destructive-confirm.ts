import { create } from "zustand";

/**
 * Confirmação de ações destrutivas (DROP, TRUNCATE, DELETE em massa).
 * Mesmo padrão do `useApproval` do agente: um pendente por vez,
 * resolve(true|false) via Promise.
 *
 * O dialog força o usuário a marcar um checkbox antes do botão
 * confirmar habilitar — evita "muscle memory" matando dados.
 */
export interface PendingDestructive {
  id: string;
  title: string;
  /** Linha de descrição (ex: "Esta ação não pode ser desfeita."). */
  description: string;
  /** Lista de itens afetados (nomes de tabela, colunas, etc.). */
  items: string[];
  /** Texto do botão de confirmação (ex: "Drop 3 tables"). */
  confirmLabel: string;
  /** Texto da checkbox que precisa ser marcada. */
  checkboxLabel: string;
  resolve: (confirmed: boolean) => void;
}

interface DestructiveState {
  pending: PendingDestructive | null;
  confirmDestructive: (
    req: Omit<PendingDestructive, "id" | "resolve">,
  ) => Promise<boolean>;
  resolveCurrent: (confirmed: boolean) => void;
}

export const useDestructive = create<DestructiveState>((set, get) => ({
  pending: null,
  confirmDestructive(req) {
    return new Promise<boolean>((resolve) => {
      const prev = get().pending;
      if (prev) prev.resolve(false);
      set({
        pending: { ...req, id: crypto.randomUUID(), resolve },
      });
    });
  },
  resolveCurrent(confirmed) {
    const cur = get().pending;
    if (!cur) return;
    set({ pending: null });
    cur.resolve(confirmed);
  },
}));

export const confirmDestructive = (
  req: Omit<PendingDestructive, "id" | "resolve">,
) => useDestructive.getState().confirmDestructive(req);
