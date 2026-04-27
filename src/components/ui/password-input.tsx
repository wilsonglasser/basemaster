import { useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/state/i18n";

interface PasswordInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  /** Optional fetcher: when set, clicking the eye while the field is
   *  empty calls this to pull the stored value from the backend (OS
   *  keyring) and reveals it. Returns null if nothing is stored. */
  onReveal?: () => Promise<string | null>;
  disabled?: boolean;
  autoComplete?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}

export function PasswordInput({
  value,
  onChange,
  placeholder,
  className,
  onReveal,
  disabled,
  autoComplete = "current-password",
  onKeyDown,
}: PasswordInputProps) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (loading) return;
    if (!shown && onReveal && value === "") {
      setLoading(true);
      try {
        const fetched = await onReveal();
        if (fetched != null) onChange(fetched);
      } finally {
        setLoading(false);
      }
    }
    setShown((s) => !s);
  };

  return (
    <div className="relative">
      <input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        onKeyDown={onKeyDown}
        className={cn(className, "pr-9")}
      />
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={disabled}
        title={shown ? t("common.hide") : t("common.show")}
        tabIndex={-1}
        className="absolute inset-y-0 right-1 my-auto grid h-7 w-7 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : shown ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
