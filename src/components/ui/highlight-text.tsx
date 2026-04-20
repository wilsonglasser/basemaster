import { matchRange } from "@/state/sidebar-filter";

/** Renderiza `text` destacando o trecho que bate com `query`.
 *  Se query vazia ou sem match, devolve o texto inteiro sem destaque. */
export function HighlightText({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}) {
  const range = query ? matchRange(text, query) : null;
  if (!range) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {text.slice(0, range.start)}
      <mark className="rounded-sm bg-yellow-400/40 px-0.5 text-foreground dark:bg-yellow-500/30">
        {text.slice(range.start, range.end)}
      </mark>
      {text.slice(range.end)}
    </span>
  );
}
