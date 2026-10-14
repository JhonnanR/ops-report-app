"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type Option = { id: string; label: string; middle?: string; tag?: string };

/** Text typed/shown in the field once an option is picked (the middle + tag show as bubbles). */
const textOf = (o: Option) => o.label;

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

/** Dropdown with optional bubbles: a blue one in the middle (e.g. "Type 1") and a % one on the right. */
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
  const [query, setQuery] = useState(selected ? textOf(selected) : "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Keep the text box in sync when a selection is made. (Parents reset this
  // component with a `key` when its options change.)
  useEffect(() => {
    if (selected) setQuery(textOf(selected));
  }, [selected]);

  // Close when tapping outside.
  useEffect(() => {
    function onDown(e: MouseEvent | TouchEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery(selected ? textOf(selected) : "");
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [selected]);

  const filtered = useMemo(() => {
    if (!searchable) return options;
    const q = query.trim().toLowerCase();
    if (!q || (selected && q === textOf(selected).toLowerCase())) return options;
    const words = q.split(/\s+/);
    return options.filter((o) => {
      const hay = `${o.label} ${o.middle ?? ""} ${o.tag ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [options, query, selected, searchable]);

  function pick(o: Option) {
    onChange(o.id);
    setQuery(textOf(o));
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
    <div
      className={`combo${searchable ? "" : " plain"}${selected?.tag ? " has-tag" : ""}${
        selected?.middle && selected?.tag ? " has-tag2" : ""
      }`}
      ref={wrapRef}
    >
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
      {/* The selected option's bubbles show inside the field, on the right */}
      {selected && (selected.middle || selected.tag) && !disabled && (
        <span className="combo-tags">
          {selected.middle && <span className="tag tag-soft">{selected.middle}</span>}
          {selected.tag && <span className="tag">{selected.tag}</span>}
        </span>
      )}
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
              <span className="combo-label">{o.label}</span>
              {o.middle && (
                <span className="combo-middle">
                  <span className="tag tag-soft">{o.middle}</span>
                </span>
              )}
              {o.tag && <span className="tag">{o.tag}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}