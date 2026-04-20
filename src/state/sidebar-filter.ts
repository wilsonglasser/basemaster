import { create } from "zustand";

interface SidebarFilterState {
  query: string;
  setQuery: (q: string) => void;
}

export const useSidebarFilter = create<SidebarFilterState>((set) => ({
  query: "",
  setQuery(q) {
    set({ query: q });
  },
}));

/** Match case-insensitive, strip-acento. */
export function matches(text: string, query: string): boolean {
  if (!query) return true;
  return norm(text).includes(norm(query));
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Encontra o range [start, end) do match na string normalizada,
 *  mas retornando índices sobre a string ORIGINAL. Retorna null se
 *  não acha. Suporta NFD mantendo 1:1 char-length (normalize NFD pode
 *  aumentar o tamanho; pra simplicidade, comparação é simples sem
 *  stripping de acento pros índices). */
export function matchRange(
  text: string,
  query: string,
): { start: number; end: number } | null {
  if (!query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  return { start: idx, end: idx + query.length };
}
