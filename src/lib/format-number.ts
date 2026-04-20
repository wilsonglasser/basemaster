/** Formato compacto: 1.2k / 12.3k / 1.5M / 4.2B — pra badges apertados. */
export function formatCompactNumber(n: number | null | undefined): string {
  if (n == null) return "";
  const abs = Math.abs(n);
  if (abs < 1_000) return String(n);
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  if (abs < 1_000_000_000)
    return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Formato compacto de bytes: 42 B / 1.2 KB / 3.4 MB / 1.2 GB. */
export function formatCompactBytes(n: number | null | undefined): string {
  if (n == null) return "";
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
