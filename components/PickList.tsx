"use client";

import { useEffect, useState } from "react";
import type { Option } from "./SearchSelect";

type Props = {
  options: Option[];
  value: string | null;
  onChange: (id: string) => void;
  loading?: boolean;
  loadingText?: string;
  emptyText?: string;
};

/**
 * A list that's open until something is picked (no typing).
 * After picking, it collapses into one field showing the choice + its bubbles.
 * Tapping that field opens the list again to change it.
 */
export default function PickList({
  options,
  value,
  onChange,
  loading,
  loadingText = "Loading…",
  emptyText = "Nothing to show",
}: Props) {
  const selected = options.find((o) => o.id === value) ?? null;
  const [open, setOpen] = useState(!selected);

  // Nothing picked (e.g. a new parent was chosen) → show the list again.
  useEffect(() => {
    if (!value) setOpen(true);
  }, [value]);

  if (loading) return <div className="hint">{loadingText}</div>;
  if (options.length === 0) return <div className="hint">{emptyText}</div>;

  if (selected && !open) {
    return (
      <button
        type="button"
        className="pick-selected"
        onClick={() => setOpen(true)}
        aria-label="Change selection"
      >
        <span className="pick-label">{selected.label}</span>
        <span className="pick-bubbles">
          {selected.middle && <span className="tag tag-soft">{selected.middle}</span>}
          {selected.tag && <span className="tag">{selected.tag}</span>}
        </span>
        <span className="pick-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
    );
  }

  return (
    <ul className="pick-list" role="listbox">
      {options.map((o) => (
        <li key={o.id}>
          <button
            type="button"
            role="option"
            aria-selected={o.id === value}
            className={`pick-row${o.id === value ? " on" : ""}`}
            onClick={() => {
              onChange(o.id);
              setOpen(false);
            }}
          >
            <span className="pick-label">{o.label}</span>
            {o.middle && (
              <span className="pick-middle">
                <span className="tag tag-soft">{o.middle}</span>
              </span>
            )}
            {o.tag && <span className="tag">{o.tag}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}