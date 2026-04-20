import { useEffect, useRef, useState } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Hash,
  Regex,
  Type,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";

export type SearchMode = "campo" | "dado";

export interface SearchState {
  value: string;
  mode: SearchMode;
  caseSensitive: boolean;
  regex: boolean;
}

interface SearchBarProps {
  open: boolean;
  onClose: () => void;
  /** Disparado a cada mudança de texto/modo. */
  onChange: (state: SearchState) => void;
  /** Total de matches calculado pelo parent (colunas em Campo, células em Dado). */
  matchCount?: number;
  /** Match focado atualmente (0-based). */
  matchIndex?: number;
  onPrev?: () => void;
  onNext?: () => void;
}

export function SearchBar({
  open,
  onClose,
  onChange,
  matchCount,
  matchIndex,
  onPrev,
  onNext,
}: SearchBarProps) {
  const t = useT();
  const [mode, setMode] = useState<SearchMode>("dado");
  const [value, setValue] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Propaga estado pra cima.
  useEffect(() => {
    if (!open) {
      onChange({ value: "", mode, caseSensitive, regex });
      return;
    }
    onChange({ value, mode, caseSensitive, regex });
  }, [open, value, mode, caseSensitive, regex, onChange]);

  // Limpa quando fecha.
  useEffect(() => {
    if (!open) setValue("");
  }, [open]);

  if (!open) return null;

  const hasMatches = matchCount != null && matchCount > 0;
  const showCount = !!value.trim();

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/70 px-2 text-xs">
      <div className="inline-flex rounded-md border border-border bg-background p-0.5">
        <ModeBtn
          active={mode === "campo"}
          onClick={() => setMode("campo")}
          icon={<Hash className="h-3 w-3" />}
          label={t("search.modeField")}
        />
        <ModeBtn
          active={mode === "dado"}
          onClick={() => setMode("dado")}
          icon={<Type className="h-3 w-3" />}
          label={t("search.modeData")}
        />
      </div>

      <div className="relative flex flex-1 items-center">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) onPrev?.();
              else onNext?.();
            }
          }}
          placeholder={
            mode === "campo"
              ? t("search.placeholderField")
              : t("search.placeholderData")
          }
          className={cn(
            "w-full rounded border border-border bg-background px-2 py-1 pr-16 text-xs",
            "placeholder:text-muted-foreground/60",
            "focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/40",
          )}
        />
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <ToggleBtn
            active={caseSensitive}
            onClick={() => setCaseSensitive((x) => !x)}
            icon={<CaseSensitive className="h-3 w-3" />}
            title={t("search.caseTitle")}
          />
          <ToggleBtn
            active={regex}
            onClick={() => setRegex((x) => !x)}
            icon={<Regex className="h-3 w-3" />}
            title={t("search.regexTitle")}
          />
        </div>
      </div>

      {showCount && (
        <span
          className={cn(
            "min-w-[60px] shrink-0 text-center tabular-nums",
            hasMatches ? "text-muted-foreground" : "text-destructive/80",
          )}
        >
          {hasMatches ? `${(matchIndex ?? 0) + 1} / ${matchCount}` : "0 / 0"}
        </span>
      )}

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasMatches}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          title={t("search.prevTitle")}
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasMatches}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          title={t("search.nextTitle")}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("search.closeTitle")}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  icon,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "grid h-5 w-5 place-items-center rounded text-[11px] transition-colors",
        active
          ? "bg-conn-accent/25 text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

function ModeBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "bg-conn-accent text-conn-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
