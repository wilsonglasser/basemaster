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

/** Case-insensitive match, accent-stripped. */
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

/** Find the [start, end) range of the match in the normalized string,
 *  but return indices over the ORIGINAL string. Returns null if not
 *  found. Supports NFD keeping 1:1 char-length (NFD normalize may
 *  increase size; for simplicity, comparison is plain without
 *  accent-stripping for the indices). */
export function matchRange(
  text: string,
  query: string,
): { start: number; end: number } | null {
  if (!query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  return { start: idx, end: idx + query.length };
}
