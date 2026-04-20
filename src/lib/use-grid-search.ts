import { useEffect, useMemo, useState } from "react";

import { formatValue, isNullish } from "@/lib/format-value";
import type { Value } from "@/lib/types";

import type { SearchState } from "@/components/grid/search-bar";

/**
 * Calcula matches da SearchBar contra um result set.
 *
 * - Modo "campo": colunas cujo nome contém o termo.
 * - Modo "dado": células cujo displayValue contém o termo (case-insensitive).
 *
 * Retorna match list, índice corrente, prev/next handlers.
 */
export function useGridSearch(
  search: SearchState,
  columns: string[],
  rows: Value[][],
) {
  const matches = useMemo<ReadonlyArray<readonly [number, number]>>(() => {
    const term = search.value.trim();
    if (!term) return [];

    // Compila um predicate conforme os flags: regex compila uma vez com
    // /i opcional; senão usa includes case-sensitive ou lower-case.
    let match: (s: string) => boolean;
    if (search.regex) {
      try {
        const re = new RegExp(term, search.caseSensitive ? "" : "i");
        match = (s) => re.test(s);
      } catch {
        // Regex inválida → zero matches em vez de throw.
        return [];
      }
    } else if (search.caseSensitive) {
      match = (s) => s.includes(term);
    } else {
      const lower = term.toLowerCase();
      match = (s) => s.toLowerCase().includes(lower);
    }

    if (search.mode === "campo") {
      const out: Array<[number, number]> = [];
      columns.forEach((c, i) => {
        if (match(c)) out.push([i, 0]);
      });
      return out;
    }

    // Modo Dado: scan completo. O(rows * cols).
    const out: Array<[number, number]> = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = 0; c < columns.length; c++) {
        const v = row[c];
        if (isNullish(v)) continue;
        const s = formatValue(v);
        if (match(s)) out.push([c, r]);
      }
    }
    return out;
  }, [search, columns, rows]);

  const [index, setIndex] = useState(0);

  // Reset índice quando matches mudam.
  useEffect(() => {
    setIndex(0);
  }, [matches]);

  const prev = () => {
    if (matches.length === 0) return;
    setIndex((i) => (i - 1 + matches.length) % matches.length);
  };
  const next = () => {
    if (matches.length === 0) return;
    setIndex((i) => (i + 1) % matches.length);
  };

  // Clamp para evitar `matches[index]` undefined no render imediatamente
  // após `matches` shrink (o useEffect que reseta o índice só roda depois).
  const safeIndex = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);

  return { matches, index: safeIndex, prev, next };
}
