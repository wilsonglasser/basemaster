import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface ComboboxProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  mono?: boolean;
  /** Dropdown height in px. Default 240. */
  maxHeight?: number;
}

/** Free-form input with autocomplete: user can type any value, and a
 *  dropdown suggests options filtered by substring. Portaled to escape
 *  overflow:hidden containers. */
export function Combobox({
  value,
  options,
  onChange,
  placeholder,
  className,
  mono,
  maxHeight = 240,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const filtered = value
    ? options.filter((o) => o.toLowerCase().includes(value.toLowerCase()))
    : options;

  useEffect(() => setCursor(0), [value, open]);

  const openDropdown = () => {
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
    setOpen(true);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          openDropdown();
        }}
        onFocus={openDropdown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openDropdown();
            setCursor((c) => Math.min(filtered.length - 1, c + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === "Enter") {
            if (open && filtered[cursor]) {
              e.preventDefault();
              onChange(filtered[cursor]);
              setOpen(false);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className={cn(
          "w-full rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:border-conn-accent focus:outline-none focus:ring-1 focus:ring-conn-accent/40",
          mono && "font-mono",
          className,
        )}
      />
      {open && rect && filtered.length > 0 &&
        createPortal(
          <div
            className="fixed z-[9999] overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
            style={{
              top: rect.bottom + 4,
              left: rect.left,
              width: Math.max(200, rect.width),
              maxHeight,
            }}
          >
            {filtered.map((o, i) => (
              <button
                key={o}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o);
                  setOpen(false);
                }}
                onMouseEnter={() => setCursor(i)}
                className={cn(
                  "block w-full truncate rounded px-2 py-0.5 text-left font-mono text-[11px]",
                  i === cursor ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                {o}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
