"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

type Reason = { id: string; name: string };
/** The reason whose name contains "Other" opens a text box. */
const isOtherReason = (name: string) => /other/i.test(name);

/** "Meridian Forty54 - Cabana - 5" → "Cabana 5" (project name and dashes removed) */
function buildingLabel(name: string): string {
  const parts = name.split(" - ").map((s) => s.trim()).filter(Boolean);
  return (parts.length > 1 ? parts.slice(1) : parts).join(" ");
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

  const elevation = elevations.find((e) => e.id === elevationId) ?? null;
  const building = buildings.find((b) => b.id === buildingId) ?? null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  // What's saved right now. Going below it needs a reason.
  const current = elevation?.percent ?? 0;

  // Reason for lowering a percentage. The list comes from the "Reason" Select column in Notion.
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [reasonChoice, setReasonChoice] = useState(""); // option name
  const [reasonOther, setReasonOther] = useState("");

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
        label: buildingLabel(b.name),
        tag: b.percent !== null ? `${b.percent}% completed` : "No elevations",
      })),
    [buildings],
  );
  const elevationOptions: Option[] = useMemo(
    () => elevations.map((e) => ({ id: e.id, label: e.name, tag: `Currently ${e.percent ?? 0}%` })),
    [elevations],
  );

  const isDecrease = elevation !== null && pctText !== "" && percent < current;
  const chosenReason = reasons.find((r) => r.name === reasonChoice) ?? null;
  const reasonText = isOtherReason(reasonChoice)
    ? reasonOther.trim()
      ? `${reasonChoice}: ${reasonOther.trim()}`
      : ""
    : reasonChoice;
  const reasonOk = !isDecrease || reasonText !== "";
  const canSave = elevation !== null && pctText !== "" && percent !== current && reasonOk && !saving;

  async function save() {
    if (!elevation || !canSave) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elevationId: elevation.id,
          percent,
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
      await Promise.all([loadProjects(), projectId ? loadBuildings(projectId) : null]).catch(() => {});
      const bldg = typeof data.buildingPercent === "number" ? ` Building overall: ${data.buildingPercent}%.` : "";
      setMessage({ kind: "ok", text: `Saved: ${elevation.name} is now ${percent}%.${bldg}` });
      setReasonChoice("");
      setReasonOther("");
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

      <div className="card">
        <label className="field">
          <span className="step">2</span>Building
        </label>
        <SearchSelect
          key={projectId ?? "none"}
          options={buildingOptions}
          value={buildingId}
          onChange={(id) => {
            setMessage(null);
            setBuildingId(id);
          }}
          placeholder={
            !projectId
              ? "Pick a project first"
              : loading === "buildings"
                ? "Loading buildings…"
                : buildings.length === 0
                  ? "No buildings linked to this project"
                  : "Search buildings"
          }
          disabled={!projectId || loading === "buildings" || buildings.length === 0}
          emptyText="No building matches"
        />
        {building && (
          <div className="hint">
            {building.sqCount > 0 && building.sqCount < building.elevationCount
              ? `${building.sqCount} of ${building.elevationCount} elevations have SQ`
              : `${building.elevationCount} elevation${building.elevationCount === 1 ? "" : "s"}`}
          </div>
        )}
      </div>

      <div className="card">
        <label className="field">
          <span className="step">3</span>Elevation
        </label>
        <SearchSelect
          key={buildingId ?? "none"}
          searchable={false}
          options={elevationOptions}
          value={elevationId || null}
          onChange={(id) => {
            setMessage(null);
            setElevationId(id ?? "");
          }}
          placeholder={
            !buildingId
              ? "Pick a building first"
              : loading === "elevations"
                ? "Loading elevations…"
                : elevations.length === 0
                  ? "No elevations for this building"
                  : "Choose an elevation"
          }
          disabled={!buildingId || loading === "elevations" || elevations.length === 0}
          emptyText="No elevations"
        />
        {elevation && (elevation.submittedBy || elevation.lastEdited) && (
          <div className="hint">
            {elevation.submittedBy ? `Last reported by ${elevation.submittedBy}` : "Last edited"}
            {elevation.lastEdited ? ` · ${timeAgo(elevation.lastEdited, now)}` : ""}
          </div>
        )}
      </div>

      <div className="card">
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
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map((n) => (
                <span key={n} className={n % 20 ? "minor" : ""} style={{ left: `${n}%` }}>
                  {n % 20 ? "" : n}
                </span>
              ))}
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

        <div style={{ marginTop: 16 }}>
          <button className="btn" onClick={save} disabled={!canSave}>
            {saving ? "Saving…" : "Save progress"}
          </button>
        </div>
        {message && <div className={`msg ${message.kind}`}>{message.text}</div>}
      </div>
    </main>
  );
}