/**
 * Splits SQL into top-level statements with character offsets, so we can
 * answer "which statement is the cursor sitting in?". Quote-aware (single,
 * double, backtick) and comment-aware (-- and /* *\/), mirroring the parser
 * in dangerous-query.ts.
 */

export interface SqlSegment {
  /** Raw SQL text of the segment (trailing `;` excluded). */
  sql: string;
  /** Start offset (inclusive) into the original input. */
  start: number;
  /** End offset (exclusive) into the original input : points at the `;`
   *  that terminated it, or `sql.length` for the trailing fragment. */
  end: number;
}

export function splitSqlSegments(sql: string): SqlSegment[] {
  const out: SqlSegment[] = [];
  let i = 0;
  let segStart = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < n) i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          i++;
          if (sql[i] === quote) {
            i++;
            continue;
          }
          break;
        }
        if (sql[i] === "\\" && quote !== "`") {
          i++;
          if (i < n) i++;
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === ";") {
      const text = sql.slice(segStart, i);
      out.push({ sql: text, start: segStart, end: i });
      i++;
      segStart = i;
      continue;
    }
    i++;
  }
  if (segStart < n) {
    out.push({ sql: sql.slice(segStart, n), start: segStart, end: n });
  }
  return out;
}

/** Returns the segment that the cursor is currently on, or null if there's
 *  no non-empty statement around it. The cursor sitting on a `;` snaps to
 *  the statement that just ended (so you can run "the one I just typed").
 */
export function statementAtCursor(
  sql: string,
  cursor: number,
): SqlSegment | null {
  const segments = splitSqlSegments(sql);
  if (segments.length === 0) return null;
  const c = Math.max(0, Math.min(cursor, sql.length));
  for (const seg of segments) {
    if (c >= seg.start && c <= seg.end) {
      if (seg.sql.trim().length === 0) {
        // Empty segment (e.g., the `;\n;` gap). Fall back to the previous
        // non-empty one.
        const prev = segments
          .slice(0, segments.indexOf(seg))
          .reverse()
          .find((s) => s.sql.trim().length > 0);
        return prev ?? null;
      }
      return seg;
    }
  }
  // Cursor past everything (shouldn't happen with the clamp), return last.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].sql.trim().length > 0) return segments[i];
  }
  return null;
}
