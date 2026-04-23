import { useEffect, useMemo, useState } from "react";

import { formatValue, isNullish } from "@/lib/format-value";
import type { Value } from "@/lib/types";

import type { SearchState } from "@/components/grid/search-bar";

/**
 * Compute SearchBar matches against a result set.
 *
 * - "campo" mode: columns whose name contains the term.
 * - "dado" mode: cells whose displayValue contains the term (case-insensitive).
 *
 * Returns match list, current index, prev/next handlers.
 */
export function useGridSearch(
  search: SearchState,
  columns: string[],
  rows: Value[][],
) {
  const matches = useMemo<ReadonlyArray<readonly [number, number]>>(() => {
    const term = search.value.trim();
    if (!term) return [];

    // Compile a predicate per flags: regex compiles once with
    // optional /i; otherwise uses case-sensitive includes or lower-case.
    let match: (s: string) => boolean;
    if (search.regex) {
      try {
        const re = new RegExp(term, search.caseSensitive ? "" : "i");
        match = (s) => re.test(s);
      } catch {
        // Invalid regex → zero matches instead of throw.
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

    // Dado mode: full scan. O(rows * cols).
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

  // Reset index when matches change.
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

  // Clamp to avoid `matches[index]` undefined on render right after
  // `matches` shrinks (the useEffect that resets index only runs later).
  const safeIndex = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);

  return { matches, index: safeIndex, prev, next };
}
