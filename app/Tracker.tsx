"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PickList from "@/components/PickList";
import SearchSelect, { type Option } from "@/components/SearchSelect";
import { timeAgo } from "@/lib/timeAgo";

type Project = {
  id: string;
  name: string;
  status: string;
  percent: number | null; // SQ-weighted average of its buildings
  included: number; // buildings counted (have SQ + elevations)
  total: number; // all buildings
};
type Building = {
  id: string;
  name: string;
  type: string;
  number: number | null;
  elevationCount: number;
  sqCount: number; // elevations that have SQ (0 = using simple average)
  percent: number | null; // weighted by elevation SQ (or simple average if none have SQ)
};
type Elevation = {
  id: string;
  name: string;
  code: string;
  percent: number | null;
  submittedBy: string;
  lastEdited: string | null;
};

const STEP = 5;
const MAX_PHOTOS = 3;

type Photo = { key: string; blob: Blob; preview: string };

/** Shrink a phone photo before uploading (max 1600px, JPEG ~80%) so it uploads fast on site. */
async function compressImage(file: File, maxSide = 1600, quality = 0.8): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read that photo."));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("Could not process that photo.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type TodayReport = {
  id: string;
  elevationId: string | null;
  buildingId: string | null;
  projectId: string | null;
  project: string;
  building: string; // short, e.g. "B1-3"
  elevation: string; // code, e.g. "[A203-3]"
  from: number | null;
  to: number | null;
  at: string | null;
};

/** Page IDs sometimes come with dashes, sometimes without. */
const norm = (id: string) => id.replace(/-/g, "");

/** Building ✓: "✓ 2/8" once any of its elevations is reported today; greyed when all are done. */
function doneMark(done: number, total: number): { mark?: string; done?: boolean } {
  if (done === 0) return {};
  return { mark: total > 0 ? `✓ ${Math.min(done, total)}/${total}` : "✓", done: total > 0 && done >= total };
}

/** Local midnight today, as ISO (the "session" resets each day). */
function startOfToday(nowMs: number): string {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** "2:35 PM" */
const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";

type Reason = { id: string; name: string };
/** The reason whose name contains "Other" opens a text box. */
const isOtherReason = (name: string) => /other/i.test(name);

/** "Merdian Forty 54 - Bldg 1 - 1" → "Bldg 1 - 1" (used only if Bldg # is empty) */
function buildingLabel(name: string): string {
  const parts = name
    .split(/\s+-\s*|\s*-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (parts.length > 1 ? parts.slice(1) : parts).join(" - ");
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data as T;
}

export default function Tracker({
  supervisorName,
  canManage = false,
}: {
  supervisorName: string;
  canManage?: boolean;
}) {
  const router = useRouter();

  const [projects, setProjects] = useState<Project[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [elevations, setElevations] = useState<Elevation[]>([]);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [elevationId, setElevationId] = useState<string>("");

  // percent = the value we save; pctText = what's shown in the box while typing
  const [percent, setPercent] = useState<number>(0);
  const [pctText, setPctText] = useState<string>("0");

  const [loading, setLoading] = useState<"projects" | "buildings" | "elevations" | null>("projects");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Ticks every minute so "x minutes ago" stays current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Today's reports by this supervisor (resets at local midnight).
  const [today, setToday] = useState<TodayReport[]>([]);
  const dayKey = new Date(now).toDateString(); // changes at midnight → reload
  const loadToday = useCallback(async () => {
    const d = await getJson<{ reports: TodayReport[] }>(
      `/api/today?since=${encodeURIComponent(startOfToday(Date.now()))}`,
    );
    setToday(d.reports);
  }, []);
  useEffect(() => {
    loadToday().catch(() => {});
  }, [dayKey, loadToday]);

  // Elevations reported today → darkened in the list. Bottom list groups by elevation.
  const doneToday = useMemo(
    () => new Set(today.map((r) => (r.elevationId ? norm(r.elevationId) : "")).filter(Boolean)),
    [today],
  );
    // Buildings: which elevations in each one were reported today → "✓ 2/8" on the building.
  const doneByBuilding = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of today) {
      if (!r.buildingId || !r.elevationId) continue;
      const key = norm(r.buildingId);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(norm(r.elevationId));
    }
    return map;
  }, [today]);
  // Bottom list: every report today, grouped under its project (newest first).
  // The newest report for each elevation is highlighted; earlier ones are dimmed.
    // Bottom list: every report today, grouped by project → building (newest first).
  // The newest report for each elevation is highlighted; earlier ones are dimmed.
   // Bottom list: every report today, grouped by project → building (newest first).
  // The newest report for each elevation is highlighted; earlier ones are dimmed.
  // "Latest edit" bubble only when that elevation was reported more than once today.
  type TodayItem = TodayReport & { latest: boolean; repeated: boolean };
  const todayGroups = useMemo(() => {
    const keyOf = (r: TodayReport) => (r.elevationId ? norm(r.elevationId) : r.id);
    const counts = new Map<string, number>();
    for (const r of today) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1);

    const seen = new Set<string>();
    const groups: {
      key: string;
      project: string;
      buildings: { key: string; building: string; items: TodayItem[] }[];
    }[] = [];
    for (const r of today) {
      const elevKey = keyOf(r);
      const latest = !seen.has(elevKey);
      seen.add(elevKey);

      const pKey = r.projectId ?? r.project;
      let g = groups.find((x) => x.key === pKey);
      if (!g) groups.push((g = { key: pKey, project: r.project, buildings: [] }));

      const bKey = r.buildingId ? norm(r.buildingId) : r.building || "—";
      let bg = g.buildings.find((x) => x.key === bKey);
      if (!bg) g.buildings.push((bg = { key: bKey, building: r.building || "Other", items: [] }));

      bg.items.push({ ...r, latest, repeated: (counts.get(elevKey) ?? 0) > 1 });
    }
    return groups;
  }, [today]);

  // Each step appears only after the one before it is done; scroll it into view on phones.
  const buildingCard = useRef<HTMLDivElement>(null);
  const elevationCard = useRef<HTMLDivElement>(null);
  const completionCard = useRef<HTMLDivElement>(null);
  const reveal = (el: HTMLDivElement | null) =>
    setTimeout(() => el?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  useEffect(() => {
    if (projectId) reveal(buildingCard.current);
  }, [projectId]);
  // Elevations: scroll to the list once it has loaded (same as project → building).
  const elevationsLoading = loading === "elevations";
  useEffect(() => {
    if (buildingId && !elevationsLoading) reveal(elevationCard.current);
  }, [buildingId, elevationsLoading]);
  useEffect(() => {
    if (elevationId) reveal(completionCard.current);
  }, [elevationId]);

  const elevation = elevations.find((e) => e.id === elevationId) ?? null;
  const building = buildings.find((b) => b.id === buildingId) ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  // What's saved right now. Going below it needs a reason.
  const current = elevation?.percent ?? 0;

  // Reason for lowering a percentage. The list comes from the "Reason" Select column in Notion.
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [reasonChoice, setReasonChoice] = useState(""); // option name
  const [reasonOther, setReasonOther] = useState("");

  // Photos for this save (optional, up to 3)
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);

  function clearPhotos() {
    setPhotos((list) => {
      list.forEach((p) => URL.revokeObjectURL(p.preview));
      return [];
    });
  }

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPhotoBusy(true);
    try {
      const room = MAX_PHOTOS - photos.length;
      const picked = Array.from(files).slice(0, Math.max(0, room));
      const added: Photo[] = [];
      for (const f of picked) {
        const blob = await compressImage(f);
        added.push({ key: `${Date.now()}-${Math.random()}`, blob, preview: URL.createObjectURL(blob) });
      }
      setPhotos((list) => [...list, ...added].slice(0, MAX_PHOTOS));
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Could not add that photo." });
    } finally {
      setPhotoBusy(false);
    }
  }

  function removePhoto(key: string) {
    setPhotos((list) => {
      const p = list.find((x) => x.key === key);
      if (p) URL.revokeObjectURL(p.preview);
      return list.filter((x) => x.key !== key);
    });
  }

  useEffect(() => {
    getJson<{ reasons: Reason[] }>("/api/reasons")
      .then((d) => setReasons(d.reasons))
      .catch(() => {});
  }, []);

  function setPct(n: number) {
    const v = Math.min(100, Math.max(0, Math.round(n)));
    setPercent(v);
    setPctText(String(v));
  }

  const loadProjects = useCallback(async () => {
    const d = await getJson<{ projects: Project[] }>("/api/projects");
    setProjects(d.projects);
  }, []);

  const loadBuildings = useCallback(async (pid: string) => {
    const d = await getJson<{ buildings: Building[] }>(`/api/buildings?projectId=${pid}`);
    setBuildings(d.buildings);
  }, []);

  // 1. Projects
  useEffect(() => {
    loadProjects()
      .catch((e) => setMessage({ kind: "err", text: e.message }))
      .finally(() => setLoading(null));
  }, [loadProjects]);

  // 2. Buildings for the chosen project
  useEffect(() => {
    setBuildings([]);
    setBuildingId(null);
    if (!projectId) return;
    setLoading("buildings");
    loadBuildings(projectId)
      .catch((e) => setMessage({ kind: "err", text: e.message }))
      .finally(() => setLoading(null));
  }, [projectId, loadBuildings]);

  // 3. Elevations for the chosen building
  useEffect(() => {
    setElevations([]);
    setElevationId("");
    if (!buildingId) return;
    setLoading("elevations");
    getJson<{ elevations: Elevation[] }>(`/api/elevations?buildingId=${buildingId}`)
      .then((d) => setElevations(d.elevations))
      .catch((e) => setMessage({ kind: "err", text: e.message }))
      .finally(() => setLoading(null));
  }, [buildingId]);

  // Start at the elevation's current value, with no reason picked.
  useEffect(() => {
    const start = elevation?.percent ?? 0;
    setPercent(start);
    setPctText(String(start));
    setReasonChoice("");
    setReasonOther("");
    clearPhotos();
  }, [elevation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectOptions: Option[] = useMemo(
    () =>
      projects.map((p) => ({
        id: p.id,
        label: p.name,
        tag: p.percent !== null ? `${p.percent}% completed` : "No progress yet",
      })),
    [projects],
  );
  const buildingOptions: Option[] = useMemo(
    () =>
      buildings.map((b) => ({
        id: b.id,
        // "B1" + type in the middle ("Type 1", "Cabana"…). Falls back to the name if Bldg # is empty.
        label: b.number !== null ? `B${b.number}` : buildingLabel(b.name),
        middle: b.type ? b.type.replace(/^bldg\s+/i, "") : undefined,
        tag: b.percent !== null ? `${b.percent}% completed` : "No elevations",
        ...doneMark(doneByBuilding.get(norm(b.id))?.size ?? 0, b.elevationCount),
      })),
    [buildings, doneByBuilding],
  );
  const elevationOptions: Option[] = useMemo(
    () =>
      elevations.map((e) => ({
        id: e.id,
        label: e.code || e.name,
        tag: `Currently ${e.percent ?? 0}%`,
        done: doneToday.has(norm(e.id)),
      })),
    [elevations, doneToday],
  );

  const isDecrease = elevation !== null && pctText !== "" && percent < current;
  const chosenReason = reasons.find((r) => r.name === reasonChoice) ?? null;
  const reasonText = isOtherReason(reasonChoice)
    ? reasonOther.trim()
      ? `${reasonChoice}: ${reasonOther.trim()}`
      : ""
    : reasonChoice;
  const reasonOk = !isDecrease || reasonText !== "";
  const photosOk = photos.length > 0;
  const canSave =
    elevation !== null && pctText !== "" && percent !== current && reasonOk && !saving && !photoBusy;

  async function save() {
    if (!elevation || !canSave) return;
    setSaving(true);
    setMessage(null);
    try {
      // 1. Upload the photos to Notion (one request each)
      const photoIds = await Promise.all(
        photos.map(async (p, i) => {
          const form = new FormData();
          form.append("file", p.blob, `photo-${i + 1}.jpg`);
          const up = await fetch("/api/upload", { method: "POST", body: form });
          const d = await up.json().catch(() => ({}));
          if (!up.ok || !d.id) throw new Error(d.error || "Photo upload failed.");
          return d.id as string;
        }),
      );

      // 2. Save the progress with the photos attached
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevationId: elevation.id,
          percent,
          photoIds,
          ...(isDecrease
            ? {
                reason: reasonChoice,
                reasonId: chosenReason?.id || undefined,
                ...(isOtherReason(reasonChoice) ? { reasonOther: reasonOther.trim() } : {}),
              }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Save failed.");
      setElevations((list) =>
        list.map((e) =>
          e.id === elevation.id
            ? { ...e, percent, submittedBy: supervisorName, lastEdited: new Date().toISOString() }
            : e,
        ),
      );
      // Refresh project % and building % (keeps the current selection).
      await Promise.all([loadProjects(), projectId ? loadBuildings(projectId) : null, loadToday()]).catch(
        () => {},
      );
      setMessage({
        kind: "ok",
        text: `Saved: ${elevation.code || elevation.name} is now ${percent}%.`,
      });
      setReasonChoice("");
      setReasonOther("");
      clearPhotos();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="shell">
      <div className="topbar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" width={32} height={32} />
          <h1>Ops Report</h1>
        </div>
        <div className="who">
          {supervisorName} ·{" "}
          <button className="btn link" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>

      {canManage && (
        <nav className="tabs">
          <span className="tab active">Report</span>
          <Link className="tab" href="/manager">
            Manager view
          </Link>
        </nav>
      )}

      <div className="card">
        <label className="field">
          <span className="step">1</span>Project
        </label>
        <SearchSelect
          options={projectOptions}
          value={projectId}
          onChange={(id) => {
            setMessage(null);
            setProjectId(id);
          }}
          placeholder={loading === "projects" ? "Loading projects…" : "Search projects"}
          disabled={loading === "projects"}
          emptyText="No project matches"
        />
        {project && project.total > 0 && (
          <div className="hint">
            {project.included < project.total
              ? `${project.included} of ${project.total} buildings have SQ and elevations`
              : `${project.total} building${project.total === 1 ? "" : "s"}`}
          </div>
        )}
      </div>

      {projectId && (
        <div className="card" ref={buildingCard}>
          <label className="field">
            <span className="step">2</span>Building
          </label>
          <PickList
            options={buildingOptions}
            value={buildingId}
            onChange={(id) => {
              setMessage(null);
              setBuildingId(id);
            }}
            loading={loading === "buildings"}
            loadingText="Loading buildings…"
            emptyText="No buildings linked to this project"
          />
          {building && (
            <div className="hint">
              {building.sqCount > 0 && building.sqCount < building.elevationCount
                ? `${building.sqCount} of ${building.elevationCount} elevations have SQ`
                : `${building.elevationCount} elevation${building.elevationCount === 1 ? "" : "s"}`}
            </div>
          )}
        </div>
      )}

      {buildingId && (
        <div className="card" ref={elevationCard}>
          <label className="field">
            <span className="step">3</span>Elevation
          </label>
          <PickList
            options={elevationOptions}
            value={elevationId || null}
            onChange={(id) => {
              setMessage(null);
              setElevationId(id);
            }}
            loading={loading === "elevations"}
            loadingText="Loading elevations…"
            emptyText="No elevations for this building"
          />
          {elevation && (elevation.submittedBy || elevation.lastEdited) && (
            <div className="hint">
              {elevation.submittedBy ? `Last reported by ${elevation.submittedBy}` : "Last edited"}
              {elevation.lastEdited ? ` · ${timeAgo(elevation.lastEdited, now)}` : ""}
            </div>
          )}
        </div>
      )}

      {elevation && (
        <div className="card" ref={completionCard}>
          <label className="field" htmlFor="pct">
            <span className="step">4</span>Completion
          </label>
          <div className="pct-row">
            <div className="range-wrap">
              <input
                type="range"
                min={0}
                max={100}
                step={STEP}
                value={percent}
                onChange={(e) => setPct(Number(e.target.value))}
                disabled={!elevation}
                aria-label="Completion percent slider"
              />
              <div className="ticks" aria-hidden="true">
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map(
                  (n) => (
                    <span key={n} className={n % 20 ? "minor" : ""} style={{ left: `${n}%` }}>
                      {n % 20 ? "" : n}
                    </span>
                  ),
                )}
              </div>
            </div>
            <div className="pct-input">
              <input
                id="pct"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={pctText}
                disabled={!elevation}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  // digits only, no leading zeros, max 100
                  let raw = e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
                  if (raw !== "" && Number(raw) > 100) raw = "100";
                  setPctText(raw);
                  setPercent(raw === "" ? current : Number(raw));
                }}
                onBlur={() => setPct(pctText === "" ? current : percent)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPct(percent + STEP);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPct(percent - STEP);
                  }
                }}
              />
              <span className="pct-sign">%</span>
              <div className="pct-steppers">
                <button
                  type="button"
                  aria-label="Increase 5%"
                  disabled={!elevation || percent >= 100}
                  onClick={() => setPct(percent + STEP)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="Decrease 5%"
                  disabled={!elevation || percent <= 0}
                  onClick={() => setPct(percent - STEP)}
                >
                  ▼
                </button>
              </div>
            </div>
          </div>
          {elevation && (elevation.submittedBy || elevation.lastEdited) && (
            <div className="hint">
              {elevation.submittedBy ? `Last reported by ${elevation.submittedBy}` : "Last edited"}
              {elevation.lastEdited ? ` · ${timeAgo(elevation.lastEdited, now)}` : ""}
            </div>
          )}
          {isDecrease && (
            <div className="reason-box">
              <div className="reason-title">
                Lowering from {current}% to {percent}%. Why?
              </div>
              <div className="reason-list" role="radiogroup" aria-label="Reason for lowering">
                {reasons.map((r) => (
                  <label key={r.id || r.name} className={`reason-opt${reasonChoice === r.name ? " on" : ""}`}>
                    <input
                      type="radio"
                      name="down-reason"
                      value={r.name}
                      checked={reasonChoice === r.name}
                      onChange={() => setReasonChoice(r.name)}
                    />
                    {r.name}
                  </label>
                ))}
              </div>
              {isOtherReason(reasonChoice) && (
                <input
                  type="text"
                  className="reason-other"
                  placeholder="Describe the reason"
                  maxLength={200}
                  value={reasonOther}
                  onChange={(e) => setReasonOther(e.target.value)}
                  autoFocus
                />
              )}
              {!reasonOk && <div className="hint">Pick a reason to save.</div>}
            </div>
          )}

          {elevation && (
            <div className="photos">
              <div className="photos-head">
                <span className="photos-title">Photos</span>
              </div>
              <div className="photo-row">
                {photos.map((p) => (
                  <div key={p.key} className="photo-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.preview} alt="" />
                    <button type="button" aria-label="Remove photo" onClick={() => removePhoto(p.key)}>
                      ×
                    </button>
                  </div>
                ))}
                {photos.length < MAX_PHOTOS && (
                  <label className={`photo-add${photoBusy ? " busy" : ""}`}>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => {
                        addPhotos(e.target.files);
                        e.target.value = "";
                      }}
                      disabled={photoBusy || saving}
                    />
                    <span>{photoBusy ? "…" : "📷"}</span>
                    <small>{photoBusy ? "Adding" : "Add photo"}</small>
                  </label>
                )}
                {photos.length >= MAX_PHOTOS && (
                  <div className="photo-max">Max {MAX_PHOTOS} photos added</div>
                )}
              </div>
              {!photosOk && percent !== current && (
                <div className="hint">A photo is recommended with each report.</div>
              )}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button className="btn" onClick={save} disabled={!canSave}>
              {saving ? (photos.length ? "Uploading photos…" : "Saving…") : "Save progress"}
            </button>
          </div>
          {message && <div className={`msg ${message.kind}`}>{message.text}</div>}
        </div>
      )}

      {today.length > 0 && (
        <div className="card today">
          <div className="today-head">
            <span className="today-title"> Changes Today</span>
            <span className="chip">
              {doneToday.size} elevation{doneToday.size === 1 ? "" : "s"} · {today.length} report
              {today.length === 1 ? "" : "s"}
            </span>
          </div>
          {todayGroups.map((g) => (
            <div key={g.key} className="today-group">
              <div className="today-project">{g.project}</div>
              {g.buildings.map((bg) => (
                <div key={bg.key} className="today-building">
                  <div className="today-building-name">{bg.building}</div>
                  <ul className="today-list">
                    {bg.items.map((t) => (
                      <li key={t.id} className={t.latest ? "latest" : "earlier"}>
                        <span className="today-name">{t.elevation}</span>
                        <span className="today-change">
                          {t.from ?? 0}% → <strong>{t.to ?? 0}%</strong>
                        </span>
                        <span className="today-time">{timeOf(t.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}