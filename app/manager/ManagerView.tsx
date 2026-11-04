"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { timeAgo } from "@/lib/timeAgo";
import PastReports from "./PastReports";

type Project = {
  id: string;
  name: string;
  code: string;
  status: string;
  divisions: string[];
  percent: number | null;
  included: number;
  total: number;
  lastReported: string | null;
  bldgDone: number; // buildings fully at 100%
  bldgTotal: number; // buildings that have elevations
};
type Building = {
  id: string;
  name: string;
  type: string;
  number: number | null;
  elevationCount: number;
  doneCount: number; // elevations at 100%
  percent: number | null;
  lastReported: string | null;
};
type Elevation = {
  id: string;
  name: string;
  code: string;
  percent: number | null;
  submittedBy: string;
  lastEdited: string | null;
  groupId?: string | null; // group that last worked on it
};
type HistoryRow = {
  id: string;
  elevation: string;
  projectId: string | null;
  from: number | null;
  to: number | null;
  by: string;
  at: string | null;
  reason: string;
  photos: string[];
  description: string;
  groupId: string | null; // Worked by
};
type Filters = {
  supervisor: string;
  groupId: string; // Worked by
  projectId: string;
  buildingId: string;
  elevationId: string;
  from: string; // yyyy-mm-dd (local)
  to: string; // yyyy-mm-dd (local)
};

const EMPTY_FILTERS: Filters = { supervisor: "", groupId: "", projectId: "", buildingId: "", elevationId: "", from: "", to: "" };

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

/** How many days of reports count toward the ✓ (today + the days before it). Change this one number to adjust. */
const CHECK_DAYS = 4;

/** Same bubble as the Report tab: grey "0/8 elev." until something's reported, then green "✓ 2/8 elev.". */
function CountMark({ done, total, unit }: { done: number; total?: number; unit: string }) {
  const t = total ?? 0;
  if (t <= 0) return null;
  const n = Math.min(done, t);
  return (
    <span
      className={`done-mark${n > 0 ? "" : " off"}`}
      title={`${n} of ${t} ${unit === "bldg." ? "buildings" : "elevations"} reported in the last ${CHECK_DAYS} days`}
    >
      {n > 0 ? "✓ " : ""}
      {n}/{t} {unit}
    </span>
  );
}

/** Local midnight at the start of the check window (CHECK_DAYS days, counting today), as ISO. */
function startOfWindow(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (CHECK_DAYS - 1));
  return d.toISOString();
}

/** Page IDs sometimes come with dashes, sometimes without. */
const norm = (id: string) => id.replace(/-/g, "");

type TodayReport = { elevationId: string | null; buildingId: string | null; projectId: string | null };

/** Amenity = a building whose type isn't "Bldg Type N" / "Type N" (e.g. "Cabana", "Clubhouse"). */
function isAmenity(type?: string | null): boolean {
  return !!type && !/^(bldg\.?\s*)?type\b/i.test(type.trim());
}

/** Amenities show their type ("Cabana"); others show "B1" from Bldg #, or the short name if Bldg # is empty. */
function bldgCode(b: { name: string; number: number | null; type?: string }): string {
  if (isAmenity(b.type)) return b.type!.trim();
  return b.number !== null ? `B${b.number}` : shortName(b.name);
}

/** "Bldg Type 1" → "Type 1"; "Cabana" stays "Cabana". */
function bldgType(type: string): string {
  return type.replace(/^bldg\s+/i, "");
}
function shortName(name: string): string {
  const parts = name
    .split(/\s+-\s*|\s*-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
  const [projectsOpen, setProjectsOpen] = useState(true); // Projects section open/closed
  const [buildingsBy, setBuildingsBy] = useState<Record<string, Building[]>>({});
  const [elevationsBy, setElevationsBy] = useState<Record<string, Elevation[]>>({});

  // Reports from every supervisor in the last CHECK_DAYS days → "✓ 2/8 elev." / "✓ 3/9 bldg." / ✓ on elevations.
  const [todayReports, setTodayReports] = useState<TodayReport[]>([]);
  const dayKey = new Date(now).toDateString();
  useEffect(() => {
    const load = () =>
      getJson<{ reports: TodayReport[] }>(`/api/manager/recent?since=${encodeURIComponent(startOfWindow())}`)
        .then((d) => setTodayReports(d.reports))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60_000); // refresh every 5 minutes
    return () => clearInterval(t);
  }, [dayKey]);
  const doneElevations = useMemo(
    () => new Set(todayReports.map((r) => (r.elevationId ? norm(r.elevationId) : "")).filter(Boolean)),
    [todayReports],
  );
  const doneByBuilding = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of todayReports) {
      if (!r.buildingId || !r.elevationId) continue;
      const key = norm(r.buildingId);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(norm(r.elevationId));
    }
    return map;
  }, [todayReports]);
  const doneByProject = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of todayReports) {
      if (!r.projectId || !r.buildingId) continue;
      const key = norm(r.projectId);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(norm(r.buildingId));
    }
    return map;
  }, [todayReports]);

  // Group names (Groups DB) → bubble on each elevation row
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  useEffect(() => {
    getJson<{ groups: { id: string; name: string }[] }>("/api/groups")
      .then((d) => setGroupNames(Object.fromEntries(d.groups.map((g) => [g.id, g.name]))))
      .catch(() => {});
  }, []);

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
  const [historyOpen, setHistoryOpen] = useState(false); // History section open/closed

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
      if (filters.groupId) q.set("groupId", filters.groupId);
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
        <button
          type="button"
          className="section-toggle"
          onClick={() => setProjectsOpen((o) => !o)}
          aria-expanded={projectsOpen}
        >
          <span className="page-title">Projects</span>
          <span className="section-caret" aria-hidden="true">
            {projectsOpen ? "▾" : "▸"}
          </span>
        </button>

        {projectsOpen && (
          <>
            <div className="toolbar">
              <div className="chips" role="group" aria-label="Filter by division">
                <button
                  type="button"
                  className={`chip-btn${division === "" ? " on" : ""}`}
                  onClick={() => setDivision("")}
                >
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
              <button type="button" className="btn-tool" onClick={collapseAll} disabled={!anyOpen}>
                ⊟ Collapse all
              </button>
            </div>

            {loadingProjects && <div className="hint">Loading projects…</div>}
            {!loadingProjects && visibleProjects.length === 0 && <div className="hint">No active projects.</div>}

            <ul className="tree">
              {visibleProjects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`tree-row level-1${
                      p.bldgTotal > 0 && (doneByProject.get(norm(p.id))?.size ?? 0) >= p.bldgTotal ? " all-done" : ""
                    }`}
                    onClick={() => toggleProject(p.id)}
                  >
                    <span className="caret">{openProjects.has(p.id) ? "▾" : "▸"}</span>
                    <span className="tree-title">
                      <span className="tree-name-text">{p.name}</span>
                      {p.status && <span className="tag">{p.status}</span>}
                      <span className="chip">
                        {p.total} building{p.total === 1 ? "" : "s"}
                      </span>
                      <CountMark done={doneByProject.get(norm(p.id))?.size ?? 0} total={p.bldgTotal} unit="bldg." />
                    </span>
                    <Progress percent={p.percent} />
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
                          <button
                            type="button"
                            className={`tree-row level-2${
                              b.elevationCount > 0 &&
                              (doneByBuilding.get(norm(b.id))?.size ?? 0) >= b.elevationCount
                                ? " all-done"
                                : ""
                            }`}
                            onClick={() => toggleBuilding(b.id)}
                          >
                            <span className="caret">{openBuildings.has(b.id) ? "▾" : "▸"}</span>
                            <span className="tree-title" title={b.name}>
                              <span className="tree-name-text">{bldgCode(b)}</span>
                              {b.type && !isAmenity(b.type) && (
                                <span className="tag tag-soft">{bldgType(b.type)}</span>
                              )}
                              <span className="chip">
                                {b.elevationCount ?? 0} elevation{b.elevationCount === 1 ? "" : "s"}
                              </span>
                              <CountMark
                                done={doneByBuilding.get(norm(b.id))?.size ?? 0}
                                total={b.elevationCount}
                                unit="elev."
                              />
                            </span>
                            <Progress percent={b.percent} />
                            <span className="tree-when">
                              {b.lastReported ? `Last report ${timeAgo(b.lastReported, now)}` : "No reports yet"}
                            </span>
                          </button>

                          {openBuildings.has(b.id) && (
                            <ul className="tree nested">
                              {!elevationsBy[b.id] && <li className="hint">Loading elevations…</li>}
                              {elevationsBy[b.id]?.length === 0 && <li className="hint">No elevations.</li>}
                              {elevationsBy[b.id]?.map((el) => (
                                <li
                                  key={el.id}
                                  className={`tree-row level-3 static${doneElevations.has(norm(el.id)) ? " all-done" : ""}`}
                                >
                                  <span className="caret" />
                                  <span className="tree-title">
                                    <span className="tree-name-text">{el.code || el.name}</span>
                                    {el.groupId && groupNames[norm(el.groupId)] && (
                                      <span className="tag tag-soft">{groupNames[norm(el.groupId)]}</span>
                                    )}
                                    {doneElevations.has(norm(el.id)) && (
                                      <span className="done-mark" title={`Reported in the last ${CHECK_DAYS} days`}>
                                        ✓
                                      </span>
                                    )}
                                  </span>
                                  <Progress percent={el.percent ?? 0} />
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
          </>
        )}
      </section>

      {/* ---------- Past Reports (recap) ---------- */}
      <PastReports />

      {/* ---------- History ---------- */}
      <section className="card">
        <button
          type="button"
          className="section-toggle"
          onClick={() => setHistoryOpen((o) => !o)}
          aria-expanded={historyOpen}
        >
          <span className="page-title">History</span>
          <span className="section-caret" aria-hidden="true">
            {historyOpen ? "▾" : "▸"}
          </span>
        </button>

        {historyOpen && (
          <>
            {historyEnabled && (
              <div className="toolbar toolbar-end">
                <button
                  type="button"
                  className="btn-tool"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  disabled={!hasFilters}
                >
                  ✕ Clear filters
                </button>
              </div>
            )}

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
                    <span>Worked by</span>
                    <select value={filters.groupId} onChange={(e) => setFilter("groupId", e.target.value)}>
                      <option value="">All groups</option>
                      {Object.entries(groupNames)
                        .sort((a, z) => a[1].localeCompare(z[1], undefined, { numeric: true }))
                        .map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
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
                          {bldgCode(b)}
                          {b.type && !isAmenity(b.type) ? ` · ${bldgType(b.type)}` : ""}
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
                          {el.code || el.name}
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
                          <th>Worked by</th>
                          <th>Description</th>
                          <th>Photos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((h) => (
                          <tr key={h.id}>
                            <td className="nowrap">
                              {formatWhen(h.at)}
                              <div className="tree-sub">{timeAgo(h.at, now)}</div>
                            </td>
                            <td>{h.elevation}</td>
                            <td>
                              <span className="nowrap">
                                {h.from ?? 0}% → <strong>{h.to ?? 0}%</strong>
                                {(h.to ?? 0) < (h.from ?? 0) && <span className="down-flag"> ↓</span>}
                              </span>
                              {h.reason && <div className="tree-sub">{h.reason}</div>}
                            </td>
                            <td>{h.by}</td>
                            <td className="nowrap">{h.groupId ? (groupNames[h.groupId] ?? "") : ""}</td>
                            <td className="history-desc">{h.description}</td>
                            <td>
                              {h.photos.length > 0 && (
                                <div className="history-photos">
                                  {h.photos.map((url, i) => (
                                    <a key={i} href={url} target="_blank" rel="noreferrer" title="Open photo">
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img src={url} alt={`Photo ${i + 1}`} loading="lazy" />
                                    </a>
                                  ))}
                                </div>
                              )}
                            </td>
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
          </>
        )}
      </section>
    </main>
  );
}