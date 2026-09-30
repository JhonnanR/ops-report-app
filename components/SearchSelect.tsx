"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type Option = { id: string; label: string; tag?: string };

type Props = {
  options: Option[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  /** false = plain dropdown (no typing), same look */
  searchable?: boolean;
};

/** Dropdown with an optional tag on the right (e.g. "40% completed"). Touch + keyboard friendly. */
export default function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Search…",
  disabled,
  emptyText = "No matches",
  searchable = true,
}: Props) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? null;
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Keep the text box in sync when a selection is made. (Parents reset this
  // component with a `key` when its options change.)
  useEffect(() => {
    if (selected) setQuery(selected.label);
  }, [selected]);

  // Close when tapping outside.
  useEffect(() => {
    function onDown(e: MouseEvent | TouchEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery(selected?.label ?? "");
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [selected?.label]);

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q || q === selected?.label.toLowerCase()) return options;
    const words = q.split(/\s+/);
    return options.filter((o) => {
      const hay = `${o.label} ${o.tag ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [options, query, selected?.label, searchable]);

  function pick(o: Option) {
    onChange(o.id);
    setQuery(o.label);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && filtered[active]) pick(filtered[active]);
      else setOpen(true);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className={`combo${searchable ? "" : " plain"}${selected?.tag ? " has-tag" : ""}`} ref={wrapRef}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete={searchable ? "list" : "none"}
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        readOnly={!searchable}
        inputMode={searchable ? undefined : "none"}
        onFocus={(e) => {
          setOpen(true);
          if (searchable) e.currentTarget.select();
        }}
        onClick={() => {
          if (!searchable) setOpen((o) => !o);
        }}
        onChange={(e) => {
          if (!searchable) return;
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          if (value) onChange(null);
        }}
        onKeyDown={onKey}
      />
      {/* The selected option's tag shows inside the field, on the right */}
      {selected?.tag && !disabled && <span className="tag combo-tag">{selected.tag}</span>}
      {open && !disabled && (
        <ul className="combo-list" id={listId} role="listbox">
          {filtered.length === 0 && <li className="combo-empty">{emptyText}</li>}
          {filtered.map((o, i) => (
            <li
              key={o.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              <span>{o.label}</span>
              {o.tag && <span className="tag">{o.tag}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}