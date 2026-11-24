"use client";

import { useEffect, useState } from "react";

const TYPES = [
  { key: "Bug", label: "Something's wrong" },
  { key: "Change", label: "Change / idea" },
  { key: "Question", label: "Question" },
] as const;

/**
 * "Report an issue" link at the bottom of the page. Opens a small form that saves
 * to the App Reports DB in Notion. Hidden if NOTION_APP_REPORTS_DB isn't set.
 */
export default function ReportIssue({ page }: { page: "Report" | "Manager view" }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>("Bug");
  const [description, setDescription] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/feedback", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setEnabled(Boolean(d.enabled)))
      .catch(() => {});
  }, []);

  if (!enabled) return null;

  function reset() {
    setType("Bug");
    setDescription("");
    setUrgent(false);
  }

  async function send() {
    if (description.trim().length < 3 || sending) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setMsg({ kind: "err", text: "No signal. Try again when you're connected." });
      return;
    }
    setSending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, description: description.trim(), urgent, page }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Couldn't send. Try again.");
      reset();
      setOpen(false);
      setMsg({ kind: "ok", text: "Thanks, your report was sent." });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Couldn't send. Try again." });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="report-issue">
      {!open && (
        <button
          type="button"
          className="report-issue-link"
          onClick={() => {
            setOpen(true);
            setMsg(null);
          }}
        >
          Report an issue or request a change
        </button>
      )}

      {open && (
        <div className="card report-issue-form">
          <div className="report-issue-title">Report an issue</div>

          <div className="report-issue-types" role="radiogroup" aria-label="Type">
            {TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`chip-btn${type === t.key ? " on" : ""}`}
                onClick={() => setType(t.key)}
                aria-pressed={type === t.key}
              >
                {t.label}
              </button>
            ))}
          </div>

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="What happened, or what would you like changed?"
            disabled={sending}
          />

          <label className="report-issue-urgent">
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
            Urgent
          </label>

          <div className="report-issue-actions">
            <button type="button" className="btn-tool" onClick={() => setOpen(false)} disabled={sending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn report-issue-send"
              onClick={send}
              disabled={sending || description.trim().length < 3}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}

      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
    </div>
  );
}
