"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/lib/timeAgo";

type Project = {
  id: string;
  name: string;
  status: string;
  divisions: string[];
  percent: number | null;
  included: number;
  total: number;
  lastReported: string | null;
};
type Building = {
  id: string;
  name: string;
  type: string;
  elevationCount: number;
  percent: number | null;
  lastReported: string | null;
};
type Elevation = {
  id: string;
  name: string;
  percent: number | null;
  submittedBy: string;
  lastEdited: string | null;
};
type HistoryRow = {
  id: string;
  elevation: string;
  projectId: string | null;
  from: number | null;
  to: number | null;
  by: string;
  at: string | null;
};
type Filters = {
  supervisor: string;
  projectId: string;
  buildingId: string;
  elevationId: string;
  from: string; // yyyy-mm-dd (local)
  to: string; // yyyy-mm-dd (local)
};

const EMPTY_FILTERS: Filters = { supervisor: "", projectId: "", buildingId: "", elevationId: "", from: "", to: "" };

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

/** "Oct 1, 2:30 PM" */
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Local yyyy-mm-dd → ISO at local midnight (optionally +1 day, for an inclusive "to" date). */
function localDayToIso(day: string, addDays = 0): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + addDays);
  return d.toISOString();
}

/** Small pie chart + % bubble, coloured by level (project / building / elevation). */
function Progress({ percent }: { percent: number | null }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <span className="progress" aria-label={percent === null ? "No progress yet" : `${p}% completed`}>
      <span className="pie" style={{ ["--p" as string]: `${p}%` }} />
      <span className="chip chip-pct">{percent === null ? "—" : `${p}%`}</span>
    </span>
  );
}

/** "Meridian Forty54 - Cabana - 5" → "Cabana - 5" (the project is already shown above it). */
function shortName(name: string): string {
  const parts = name.split(" - ");
  return parts.length > 1 ? parts.slice(1).join(" - ") : name;
}

export default function ManagerView({ userName }: { userName: string }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  /* ---------------- Projects overview ---------------- */
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [error, setError] = useState("");

  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [openBuildings, setOpenBuildings] = useState<Set<string>>(new Set());
  const [division, setDivision] = useState(""); // "" = all divisions
  const [buildingsBy, setBuildingsBy] = useState<Record<string, Building[]>>({});
  const [elevationsBy, setElevationsBy] = useState<Record<string, Elevation[]>>({});

  useEffect(() => {
    getJson<{ projects: Project[] }>("/api/projects")
      .then((d) => setProjects(d.projects))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingProjects(false));
  }, []);

  const toggleIn = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  async function toggleProject(id: string) {
    setOpenProjects((s) => toggleIn(s, id));
    if (!buildingsBy[id]) {
      const d = await getJson<{ buildings: Building[] }>(`/api/buildings?projectId=${id}`).catch(() => ({
        buildings: [],
      }));
      setBuildingsBy((m) => ({ ...m, [id]: d.buildings }));
    }
  }

  async function toggleBuilding(id: string) {
    setOpenBuildings((s) => toggleIn(s, id));
    if (!elevationsBy[id]) {
      const d = await getJson<{ elevations: Elevation[] }>(`/api/elevations?buildingId=${id}`).catch(() => ({
        elevations: [],
      }));
      setElevationsBy((m) => ({ ...m, [id]: d.elevations }));
    }
  }

  function collapseAll() {
    setOpenProjects(new Set());
    setOpenBuildings(new Set());
  }

  const divisions = Array.from(new Set(projects.flatMap((p) => p.divisions))).sort();
  const visibleProjects = division ? projects.filter((p) => p.divisions.includes(division)) : projects;
  const anyOpen = openProjects.size > 0 || openBuildings.size > 0;

  /* ---------------- History ---------------- */
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [supervisors, setSupervisors] = useState<string[]>([]);
  const [filterBuildings, setFilterBuildings] = useState<Building[]>([]);
  const [filterElevations, setFilterElevations] = useState<Elevation[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyEnabled, setHistoryEnabled] = useState(true);

  useEffect(() => {
    getJson<{ supervisors: string[] }>("/api/manager/supervisors")
      .then((d) => setSupervisors(d.supervisors))
      .catch(() => {});
  }, []);

  // Building options follow the chosen project; elevation options follow the chosen building.
  useEffect(() => {
    setFilterBuildings([]);
    if (!filters.projectId) return;
    getJson<{ buildings: Building[] }>(`/api/buildings?projectId=${filters.projectId}`)
      .then((d) => setFilterBuildings(d.buildings))
      .catch(() => {});
  }, [filters.projectId]);

  useEffect(() => {
    setFilterElevations([]);
    if (!filters.buildingId) return;
    getJson<{ elevations: Elevation[] }>(`/api/elevations?buildingId=${filters.buildingId}`)
      .then((d) => setFilterElevations(d.elevations))
      .catch(() => {});
  }, [filters.buildingId]);

  const historyUrl = useCallback(
    (cursor?: string | null) => {
      const q = new URLSearchParams();
      if (filters.supervisor) q.set("supervisor", filters.supervisor);
      if (filters.projectId) q.set("projectId", filters.projectId);
      if (filters.buildingId) q.set("buildingId", filters.buildingId);
      if (filters.elevationId) q.set("elevationId", filters.elevationId);
      if (filters.from) q.set("from", localDayToIso(filters.from));
      if (filters.to) q.set("to", localDayToIso(filters.to, 1)); // inclusive of the "to" day
      if (cursor) q.set("cursor", cursor);
      return `/api/manager/history?${q.toString()}`;
    },
    [filters],
  );

  // Reload the feed whenever a filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    getJson<{ history: HistoryRow[]; nextCursor: string | null; enabled: boolean }>(historyUrl())
      .then((d) => {
        if (cancelled) return;
        setHistory(d.history);
        setNextCursor(d.nextCursor);
        setHistoryEnabled(d.enabled);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [historyUrl]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingHistory(true);
    try {
      const d = await getJson<{ history: HistoryRow[]; nextCursor: string | null }>(historyUrl(nextCursor));
      setHistory((h) => [...h, ...d.history]);
      setNextCursor(d.nextCursor);
    } finally {
      setLoadingHistory(false);
    }
  }

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((f) => {
      const next = { ...f, [key]: value };
      // Changing a parent clears its children.
      if (key === "projectId") {
        next.buildingId = "";
        next.elevationId = "";
      }
      if (key === "buildingId") next.elevationId = "";
      return next;
    });
  }

  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? "";
  const hasFilters = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="shell wide">
      <div className="topbar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" width={32} height={32} />
          <h1>Ops Report</h1>
        </div>
        <div className="who">
          {userName} ·{" "}
          <button className="btn link" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>

      <nav className="tabs">
        <Link className="tab" href="/">
          Report
        </Link>
        <span className="tab active">Manager view</span>
      </nav>

      {error && <div className="msg err">{error}</div>}

      {/* ---------- Projects overview ---------- */}
      <section className="card">
        <h2 className="page-title">Projects</h2>

        <div className="toolbar">
          <div className="chips" role="group" aria-label="Filter by division">
            <button type="button" className={`chip-btn${division === "" ? " on" : ""}`} onClick={() => setDivision("")}>
              All
            </button>
            {divisions.map((d) => (
              <button
                key={d}
                type="button"
                className={`chip-btn${division === d ? " on" : ""}`}
                onClick={() => setDivision(d)}
              >
                {d}
              </button>
            ))}
          </div>
          <button type="button" className="btn link" onClick={collapseAll} disabled={!anyOpen}>
            Collapse all
          </button>
        </div>

        {loadingProjects && <div className="hint">Loading projects…</div>}
        {!loadingProjects && visibleProjects.length === 0 && <div className="hint">No active projects.</div>}

        <ul className="tree">
          {visibleProjects.map((p) => (
            <li key={p.id}>
              <button type="button" className="tree-row level-1" onClick={() => toggleProject(p.id)}>
                <span className="caret">{openProjects.has(p.id) ? "▾" : "▸"}</span>
                <span className="tree-title">
                  <span className="tree-name-text">{p.name}</span>
                  {p.status && <span className="tag">{p.status}</span>}
                </span>
                <Progress percent={p.percent} />
                <span className="chip">
                  {p.total} building{p.total === 1 ? "" : "s"}
                </span>
                <span className="tree-when">
                  {p.lastReported ? `Last report ${timeAgo(p.lastReported, now)}` : "No reports yet"}
                </span>
              </button>

              {openProjects.has(p.id) && (
                <ul className="tree nested">
                  {!buildingsBy[p.id] && <li className="hint">Loading buildings…</li>}
                  {buildingsBy[p.id]?.length === 0 && <li className="hint">No buildings.</li>}
                  {buildingsBy[p.id]?.map((b) => (
                    <li key={b.id}>
                      <button type="button" className="tree-row level-2" onClick={() => toggleBuilding(b.id)}>
                        <span className="caret">{openBuildings.has(b.id) ? "▾" : "▸"}</span>
                        <span className="tree-title" title={b.name}>
                          <span className="tree-name-text">{shortName(b.name)}</span>
                        </span>
                        <Progress percent={b.percent} />
                        <span className="chip">
                          {b.elevationCount} elevation{b.elevationCount === 1 ? "" : "s"}
                        </span>
                        <span className="tree-when">
                          {b.lastReported ? `Last report ${timeAgo(b.lastReported, now)}` : "No reports yet"}
                        </span>
                      </button>

                      {openBuildings.has(b.id) && (
                        <ul className="tree nested">
                          {!elevationsBy[b.id] && <li className="hint">Loading elevations…</li>}
                          {elevationsBy[b.id]?.length === 0 && <li className="hint">No elevations.</li>}
                          {elevationsBy[b.id]?.map((el) => (
                            <li key={el.id} className="tree-row level-3 static">
                              <span className="caret" />
                              <span className="tree-title">
                                <span className="tree-name-text">{el.name}</span>
                              </span>
                              <Progress percent={el.percent ?? 0} />
                              <span className="chip-spacer" />
                              <span className="tree-when">
                                {el.submittedBy
                                  ? `${el.submittedBy}${el.lastEdited ? ` · ${timeAgo(el.lastEdited, now)}` : ""}`
                                  : "Not reported yet"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- History ---------- */}
      <section className="card">
        <div className="section-head">
          <h2 className="section-title">History</h2>
          {historyEnabled && hasFilters && (
            <button type="button" className="btn link" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </button>
          )}
        </div>

        {!historyEnabled ? (
          <div className="hint">History isn&apos;t set up yet (NOTION_LOG_DB is missing).</div>
        ) : (
          <>
            <div className="filters">
              <label>
                <span>Supervisor</span>
                <select value={filters.supervisor} onChange={(e) => setFilter("supervisor", e.target.value)}>
                  <option value="">All supervisors</option>
                  {supervisors.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Project</span>
                <select value={filters.projectId} onChange={(e) => setFilter("projectId", e.target.value)}>
                  <option value="">All projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Building</span>
                <select
                  value={filters.buildingId}
                  onChange={(e) => setFilter("buildingId", e.target.value)}
                  disabled={!filters.projectId}
                >
                  <option value="">{filters.projectId ? "All buildings" : "Pick a project"}</option>
                  {filterBuildings.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Elevation</span>
                <select
                  value={filters.elevationId}
                  onChange={(e) => setFilter("elevationId", e.target.value)}
                  disabled={!filters.buildingId}
                >
                  <option value="">{filters.buildingId ? "All elevations" : "Pick a building"}</option>
                  {filterElevations.map((el) => (
                    <option key={el.id} value={el.id}>
                      {el.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>From</span>
                <input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
              </label>
              <label>
                <span>To</span>
                <input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
              </label>
            </div>

            <div className="feed">
              {history.length === 0 && !loadingHistory && <div className="hint">No changes found.</div>}
              {history.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Elevation</th>
                      <th>Change</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td className="nowrap">
                          {formatWhen(h.at)}
                          <div className="tree-sub">{timeAgo(h.at, now)}</div>
                        </td>
                        <td>
                          {h.elevation}
                          {h.projectId && !filters.projectId && (
                            <div className="tree-sub">{projectName(h.projectId)}</div>
                          )}
                        </td>
                        <td className="nowrap">
                          {h.from ?? 0}% → <strong>{h.to ?? 0}%</strong>
                        </td>
                        <td>{h.by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {loadingHistory && <div className="hint">Loading…</div>}
              {nextCursor && !loadingHistory && (
                <button type="button" className="btn secondary" onClick={loadMore}>
                  Load more
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}