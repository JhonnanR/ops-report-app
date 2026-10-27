"use client";

import { useEffect, useMemo, useState } from "react";
import { timeAgo } from "@/lib/timeAgo";

type Report = {
  id: string;
  elevationId: string | null;
  buildingId: string | null;
  projectId: string | null;
  project: string;
  building: string; // "B1-3"
  elevation: string; // "[A203-3]"
  from: number | null;
  to: number | null;
  by: string;
  at: string | null;
};

/** One line per elevation: where it started in the period → where it is now. */
type ElevationSummary = {
  key: string;
  elevation: string; // "[A203-3]"
  from: number | null; // before the first report in the period
  to: number | null; // after the latest report
  by: string; // who made the latest report
  at: string | null; // when
  count: number; // reports in the period
};
type BuildingGroup = { key: string; building: string; rows: ElevationSummary[] };
type ProjectGroup = {
  key: string;
  project: string;
  latestAt: string | null;
  elevations: number;
  buildings: BuildingGroup[];
};

const RANGES = [
  { key: "today", label: "Today", days: 0 },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

/** Local midnight `days` days ago, as ISO. */
function startOf(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  if (res.status === 403) {
    window.location.href = "/";
    throw new Error("Not allowed");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data as T;
}

/** "Past Reports" section in the Manager view: a quick recap of recent reports, by project → building. */
export default function PastReports() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [open, setOpen] = useState(false); // section open/closed
  const [range, setRange] = useState<RangeKey>("7");
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const days = RANGES.find((r) => r.key === range)?.days ?? 7;
    setLoading(true);
    setError("");
    getJson<{ reports: Report[]; enabled: boolean }>(`/api/manager/recent?since=${encodeURIComponent(startOf(days))}`)
      .then((d) => {
        if (cancelled) return;
        setReports(d.reports);
        setEnabled(d.enabled);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  // Group by project → building, then one line per elevation. Reports arrive newest first,
  // so the first one seen for an elevation is its latest; the last one seen is its earliest.
  const groups = useMemo(() => {
    const out: ProjectGroup[] = [];
    for (const r of reports) {
      const pKey = r.projectId ?? r.project;
      let g = out.find((x) => x.key === pKey);
      if (!g) out.push((g = { key: pKey, project: r.project, latestAt: r.at, elevations: 0, buildings: [] }));

      const bKey = r.buildingId ?? (r.building || "—");
      let bg = g.buildings.find((x) => x.key === bKey);
      if (!bg) g.buildings.push((bg = { key: bKey, building: r.building || "Other", rows: [] }));

      const eKey = r.elevationId ?? r.id;
      const row = bg.rows.find((x) => x.key === eKey);
      if (!row) {
        bg.rows.push({ key: eKey, elevation: r.elevation, from: r.from, to: r.to, by: r.by, at: r.at, count: 1 });
        g.elevations += 1;
      } else {
        row.from = r.from; // walk back to the earliest "from"
        row.count += 1;
      }
    }
    return out;
  }, [reports]);

  const elevationCount = groups.reduce((n, g) => n + g.elevations, 0);
  const todayMs = Date.parse(startOf(0));
  const isToday = (iso: string | null) => !!iso && Date.parse(iso) >= todayMs;

  return (
    <>
      <section className="card">
        <button type="button" className="section-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="page-title">Past Reports</span>
          <span className="section-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        </button>

        {open && (
          <>
            {error && <div className="msg err">{error}</div>}

            <div className="toolbar">
              <div className="chips" role="group" aria-label="Time range">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    className={`chip-btn${range === r.key ? " on" : ""}`}
                    onClick={() => setRange(r.key)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              {!loading && reports.length > 0 && (
                <span className="chip">
                  {groups.length} project{groups.length === 1 ? "" : "s"} · {elevationCount} elevation
                  {elevationCount === 1 ? "" : "s"} · {reports.length} report{reports.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {!enabled && <div className="hint">History isn&apos;t set up yet (NOTION_LOG_DB is missing).</div>}
            {loading && <div className="hint">Loading reports…</div>}
            {!loading && enabled && reports.length === 0 && <div className="hint">No reports in this period.</div>}

            {!loading &&
              groups.map((g) => (
                <div key={g.key} className="past-group">
                  <div className="past-project">
                    <span className="past-project-name">{g.project}</span>
                    <span className="chip">
                      {g.elevations} elevation{g.elevations === 1 ? "" : "s"}
                    </span>
                    <span className="past-project-when">
                      {g.latestAt ? `Last report ${timeAgo(g.latestAt, now)}` : ""}
                    </span>
                  </div>
                  {g.buildings.map((bg) => (
                    <div key={bg.key} className="today-building">
                      <div className="today-building-name">{bg.building}</div>
                      <ul className="today-list past-list">
                        {bg.rows.map((row) => {
                          const down = (row.to ?? 0) < (row.from ?? 0);
                          return (
                            <li key={row.key} className={range !== "today" && isToday(row.at) ? "latest" : ""}>
                              <span className="today-name">{row.elevation}</span>
                              <span className="today-change">
                                {row.from ?? 0}% → <strong>{row.to ?? 0}%</strong>
                                {down && <span className="down-flag"> ↓</span>}
                                {row.count > 1 && <span className="past-count"> · {row.count} reports</span>}
                              </span>
                              <span className="today-time">
                                {row.by ? `${row.by} · ` : ""}
                                {row.at ? timeAgo(row.at, now) : ""}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              ))}
          </>
        )}
      </section>
    </>
  );
}
