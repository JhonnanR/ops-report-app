"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PickList from "@/components/PickList";
import SearchSelect, { type Option } from "@/components/SearchSelect";
import { timeAgo } from "@/lib/timeAgo";
import {
  clearPhoneData,
  flushOutbox,
  getJsonCached,
  loadList,
  newReportId,
  OfflineError,
  outboxAll,
  outboxDelete,
  outboxPut,
  saveList,
  sendReport,
  SignedOutError,
  storageNearlyFull,
  type OutboxItem,
  type ReportPayload,
} from "@/lib/offline";

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
  building: string; // short, e.g. "B1"
  elevation: string; // code, e.g. "[A203-3]"
  from: number | null;
  to: number | null;
  at: string | null;
  pending?: boolean; // saved on the phone, waiting to send
};

/** Page IDs sometimes come with dashes, sometimes without. */
const norm = (id: string) => id.replace(/-/g, "");

/** Amenity = a building whose type isn't "Bldg Type N" / "Type N" (e.g. "Cabana", "Clubhouse"). */
const isAmenity = (type?: string | null) => !!type && !/^(bldg\.?\s*)?type\b/i.test(type.trim());
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

/** "9:42 AM" if today, otherwise "Oct 28, 9:42 AM" */
function savedAt(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? timeOf(d.toISOString())
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

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

  // ---------- Offline ----------
  const [online, setOnline] = useState(true);
  const [listsFrom, setListsFrom] = useState<number | null>(null); // showing lists saved at this time
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [sendState, setSendState] = useState<{ done: number; total: number } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [storageFull, setStorageFull] = useState(false);

  /** A list came from the phone's saved copy (no signal) → show the "No signal" banner. */
  const noteCached = (at: number | null) => {
    if (at !== null) setListsFrom((prev) => (prev === null ? at : Math.min(prev, at)));
  };
  const showError = (e: unknown) => {
    if (e instanceof SignedOutError) {
      window.location.href = "/login";
      return;
    }
    setMessage({ kind: "err", text: e instanceof Error ? e.message : "Something went wrong." });
  };

  // Ticks every minute so "x minutes ago" stays current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Today's reports by this supervisor (resets at local midnight).
  const [today, setToday] = useState<TodayReport[]>([]);
  const [todayOpen, setTodayOpen] = useState(true); // Changes Today open/closed
  const dayKey = new Date(now).toDateString(); // changes at midnight → reload
  const loadToday = useCallback(async () => {
    const r = await getJsonCached<{ reports: TodayReport[] }>(
      `/api/today?since=${encodeURIComponent(startOfToday(Date.now()))}`,
      `today:${new Date().toDateString()}`,
    );
    setToday(r.data.reports);
  }, []);
  useEffect(() => {
    loadToday().catch(() => {});
  }, [dayKey, loadToday]);

  // Reports waiting on this phone show in Changes Today too (marked "Waiting").
  const todayAll = useMemo(() => {
    const start = Date.parse(startOfToday(now));
    const pending: TodayReport[] = outbox
      .filter((o) => Date.parse(o.createdAt) >= start)
      .map((o) => ({
        id: o.id,
        elevationId: o.elevationId,
        buildingId: o.buildingId,
        projectId: o.projectId,
        project: o.project,
        building: o.building,
        elevation: o.elevation,
        from: o.from,
        to: o.percent,
        at: o.createdAt,
        pending: true,
      }));
    return [...pending, ...today].sort((a, z) => (z.at ?? "").localeCompare(a.at ?? ""));
  }, [outbox, today, now]);

  // Elevations reported today → darkened in the list.
  const doneToday = useMemo(
    () => new Set(todayAll.map((r) => (r.elevationId ? norm(r.elevationId) : "")).filter(Boolean)),
    [todayAll],
  );
  // Buildings: which elevations in each one were reported today → "✓ 2/8" on the building.
  const doneByBuilding = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of todayAll) {
      if (!r.buildingId || !r.elevationId) continue;
      const key = norm(r.buildingId);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(norm(r.elevationId));
    }
    return map;
  }, [todayAll]);

  // Bottom list: every report today, grouped by project → building (newest first).
  // The newest report for each elevation is highlighted; earlier ones are dimmed.
  type TodayItem = TodayReport & { latest: boolean };
  const todayGroups = useMemo(() => {
    const seen = new Set<string>();
    const groups: {
      key: string;
      project: string;
      buildings: { key: string; building: string; items: TodayItem[] }[];
    }[] = [];
    for (const r of todayAll) {
      const elevKey = r.elevationId ? norm(r.elevationId) : r.id;
      const latest = !seen.has(elevKey);
      seen.add(elevKey);

      const pKey = r.projectId ? norm(r.projectId) : r.project;
      let g = groups.find((x) => x.key === pKey);
      if (!g) groups.push((g = { key: pKey, project: r.project, buildings: [] }));

      const bKey = r.buildingId ? norm(r.buildingId) : r.building || "—";
      let bg = g.buildings.find((x) => x.key === bKey);
      if (!bg) g.buildings.push((bg = { key: bKey, building: r.building || "Other", items: [] }));

      bg.items.push({ ...r, latest });
    }
    return groups;
  }, [todayAll]);

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
  const [description, setDescription] = useState(""); // optional note with the report

  // Photos for this save (at least 1, up to 3)
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
    getJsonCached<{ reasons: Reason[] }>("/api/reasons", "reasons")
      .then((r) => setReasons(r.data.reasons))
      .catch(() => {});
  }, []);

  function setPct(n: number) {
    const v = Math.min(100, Math.max(0, Math.round(n)));
    setPercent(v);
    setPctText(String(v));
  }

  const loadProjects = useCallback(async () => {
    const r = await getJsonCached<{ projects: Project[] }>("/api/projects", "projects");
    setProjects(r.data.projects);
    if (r.cachedAt === null) setListsFrom(null);
    noteCached(r.cachedAt);
  }, []);

  /** While online, save every building's elevation list too, so they can be opened with no signal. */
  const prefetchElevations = useCallback(async (list: Building[]) => {
    for (const b of list) {
      const key = `elevations:${b.id}`;
      const saved = loadList(key);
      if (saved && Date.now() - saved.at < 30 * 60_000) continue; // saved in the last 30 min
      try {
        const r = await getJsonCached(`/api/elevations?buildingId=${b.id}`, key);
        if (r.cachedAt !== null) return; // lost signal: stop
      } catch {
        return;
      }
    }
  }, []);

  const loadBuildings = useCallback(
    async (pid: string) => {
      const r = await getJsonCached<{ buildings: Building[] }>(`/api/buildings?projectId=${pid}`, `buildings:${pid}`);
      setBuildings(r.data.buildings);
      noteCached(r.cachedAt);
      if (r.cachedAt === null) prefetchElevations(r.data.buildings).catch(() => {});
    },
    [prefetchElevations],
  );

  const loadElevations = useCallback(async (bid: string) => {
    const r = await getJsonCached<{ elevations: Elevation[] }>(
      `/api/elevations?buildingId=${bid}`,
      `elevations:${bid}`,
    );
    setElevations(r.data.elevations);
    noteCached(r.cachedAt);
  }, []);

  // 1. Projects
  useEffect(() => {
    loadProjects()
      .catch(showError)
      .finally(() => setLoading(null));
  }, [loadProjects]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2. Buildings for the chosen project
  useEffect(() => {
    setBuildings([]);
    setBuildingId(null);
    if (!projectId) return;
    setLoading("buildings");
    loadBuildings(projectId)
      .catch(showError)
      .finally(() => setLoading(null));
  }, [projectId, loadBuildings]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3. Elevations for the chosen building
  useEffect(() => {
    setElevations([]);
    setElevationId("");
    if (!buildingId) return;
    setLoading("elevations");
    loadElevations(buildingId)
      .catch(showError)
      .finally(() => setLoading(null));
  }, [buildingId, loadElevations]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start at the elevation's current value, with no reason picked.
  useEffect(() => {
    const start = elevation?.percent ?? 0;
    setPercent(start);
    setPctText(String(start));
    setReasonChoice("");
    setReasonOther("");
    setDescription("");
    clearPhotos();
  }, [elevation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Reload everything shown (after reports were sent, or the connection came back). */
  const refreshAll = useCallback(async () => {
    await Promise.all([
      loadProjects(),
      projectId ? loadBuildings(projectId) : null,
      buildingId ? loadElevations(buildingId) : null,
      loadToday(),
    ]);
  }, [loadProjects, loadBuildings, loadElevations, loadToday, projectId, buildingId]);

  /** Show a saved report on this phone right away (new %, ✓ marks), and keep it in the saved list. */
  function applyLocally(elevId: string, bid: string | null, pct: number) {
    const update = (e: Elevation) =>
      e.id === elevId ? { ...e, percent: pct, submittedBy: supervisorName, lastEdited: new Date().toISOString() } : e;
    setElevations((list) => list.map(update));
    if (bid) {
      const key = `elevations:${bid}`;
      const saved = loadList<{ elevations: Elevation[] }>(key);
      if (saved) saveList(key, { elevations: saved.data.elevations.map(update) });
    }
  }

  // ---------- Outbox: send waiting reports ----------
  const flushing = useRef(false);
  const reloadOutbox = useCallback(async () => {
    setOutbox(await outboxAll());
    setStorageFull(await storageNearlyFull());
  }, []);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    const items = await outboxAll();
    setOutbox(items);
    const waiting = items.filter((i) => i.status === "waiting").length;
    if (waiting === 0 || !navigator.onLine) return;
    flushing.current = true;
    setSendState({ done: 0, total: waiting });
    try {
      const r = await flushOutbox((done, total) => setSendState({ done, total }));
      setSignedOut(r.stopped === "signed-out");
      if (r.sent > 0) {
        setMessage({ kind: "ok", text: `Sent ${r.sent} waiting report${r.sent === 1 ? "" : "s"}.` });
        await refreshAll().catch(() => {});
      }
    } finally {
      flushing.current = false;
      setSendState(null);
      await reloadOutbox();
    }
  }, [refreshAll, reloadOutbox]);

  // Send when the app opens, when the signal comes back, when the app is reopened, and every 30 s.
  useEffect(() => {
    setOnline(navigator.onLine);
    const goOnline = () => {
      setOnline(true);
      flush();
      refreshAll().catch(() => {});
    };
    const goOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") flush();
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisible);
    const t = setInterval(flush, 30_000);
    flush();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(t);
    };
  }, [flush, refreshAll]);

  async function retryFailed(item: OutboxItem) {
    await outboxPut({ ...item, status: "waiting", error: undefined });
    await flush();
  }

  async function discardFailed(item: OutboxItem) {
    if (!window.confirm("Discard this report? It won't be saved.")) return;
    await outboxDelete(item.id);
    await reloadOutbox();
    refreshAll().catch(() => {});
  }

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
        // Amenities (Cabana, Clubhouse…) show their type as the name; regular buildings show "B1" + type bubble.
        label: isAmenity(b.type) ? b.type.trim() : b.number !== null ? `B${b.number}` : buildingLabel(b.name),
        middle: b.type && !isAmenity(b.type) ? b.type.replace(/^bldg\s+/i, "") : undefined,
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
    elevation !== null && pctText !== "" && percent !== current && reasonOk && photosOk && !saving && !photoBusy;

  async function save() {
    if (!elevation || !canSave) return;
    setSaving(true);
    setMessage(null);

    const payload: ReportPayload = {
      reportId: newReportId(),
      changedAt: new Date().toISOString(),
      elevationId: elevation.id,
      percent,
      photos: photos.map((p) => p.blob),
      description: description.trim() || undefined,
      ...(isDecrease
        ? {
            reason: reasonChoice,
            reasonId: chosenReason?.id || undefined,
            reasonOther: isOtherReason(reasonChoice) ? reasonOther.trim() : undefined,
          }
        : {}),
    };
    const label = elevation.code || elevation.name;
    const clearForm = () => {
      setReasonChoice("");
      setReasonOther("");
      setDescription("");
      clearPhotos();
    };

    /** No signal (or signed out): keep the report on this phone and send it later. */
    async function keepForLater(why: "offline" | "signed-out") {
      const opt = buildingOptions.find((o) => o.id === buildingId);
      await outboxPut({
        id: payload.reportId,
        createdAt: payload.changedAt,
        elevationId: payload.elevationId,
        percent: payload.percent,
        from: current,
        reason: payload.reason,
        reasonId: payload.reasonId,
        reasonOther: payload.reasonOther,
        description: payload.description,
        photos: payload.photos,
        project: project?.name ?? "",
        projectId: projectId,
        building: opt?.label ?? "",
        buildingId: buildingId,
        elevation: label,
        status: "waiting",
      });
      applyLocally(payload.elevationId, buildingId, payload.percent);
      await reloadOutbox();
      clearForm();
      if (why === "signed-out") setSignedOut(true);
      setMessage({
        kind: "ok",
        text:
          why === "offline"
            ? `No signal: ${label} (${percent}%) is saved on this phone and will send automatically when you're back online.`
            : `Your sign-in expired: ${label} (${percent}%) is saved on this phone and will send after you sign in again.`,
      });
    }

    try {
      await sendReport(payload);
      applyLocally(payload.elevationId, buildingId, payload.percent);
      // Refresh project % and building % (keeps the current selection).
      await Promise.all([loadProjects(), projectId ? loadBuildings(projectId) : null, loadToday()]).catch(
        () => {},
      );
      setMessage({ kind: "ok", text: `Saved: ${label} is now ${percent}%.` });
      clearForm();
    } catch (e) {
      try {
        if (e instanceof OfflineError) await keepForLater("offline");
        else if (e instanceof SignedOutError) await keepForLater("signed-out");
        else setMessage({ kind: "err", text: e instanceof Error ? e.message : "Save failed." });
      } catch {
        setMessage({ kind: "err", text: "No signal, and this report couldn't be saved on the phone. Try again." });
      }
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    const waiting = (await outboxAll()).length;
    if (
      waiting > 0 &&
      !window.confirm(
        `${waiting} report${waiting === 1 ? " hasn't" : "s haven't"} been sent yet. ` +
          "Signing out deletes them from this phone. Sign out anyway?",
      )
    ) {
      return;
    }
    await clearPhoneData();
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
    router.refresh();
  }

  const waitingReports = outbox.filter((o) => o.status === "waiting");
  const failedReports = outbox.filter((o) => o.status === "failed");

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

      {/* ---------- No signal ---------- */}
      {(!online || listsFrom !== null) && (
        <div className="offline-banner">
          <strong>No signal.</strong>{" "}
          {listsFrom !== null ? `Showing lists saved ${savedAt(listsFrom)}. ` : "Showing saved lists. "}
          Reports you save will send automatically when you&apos;re back online.
        </div>
      )}

      {/* ---------- Reports waiting on this phone ---------- */}
      {(waitingReports.length > 0 || failedReports.length > 0) && (
        <div className="card outbox">
          {waitingReports.length > 0 && (
            <div className="outbox-head">
              <span className="outbox-title">
                📤 {waitingReports.length} report{waitingReports.length === 1 ? "" : "s"} waiting to send
              </span>
              <button
                type="button"
                className="btn-tool"
                onClick={() => flush()}
                disabled={!!sendState || !online}
              >
                {sendState
                  ? `Sending ${Math.min(sendState.done + 1, sendState.total)} of ${sendState.total}…`
                  : "Send now"}
              </button>
            </div>
          )}
          {signedOut && (
            <div className="hint outbox-warn">
              Your sign-in expired. <a href="/login">Sign in again</a> to send them.
            </div>
          )}
          {storageFull && (
            <div className="hint outbox-warn">
              This phone is almost out of space for waiting reports. Send them as soon as you have signal.
            </div>
          )}
          {failedReports.map((f) => (
            <div key={f.id} className="outbox-failed">
              <div>
                <strong>
                  {f.building ? `${f.building} - ` : ""}
                  {f.elevation}
                </strong>{" "}
                {f.from}% → {f.percent}%
                <div className="hint">Couldn&apos;t send: {f.error}</div>
              </div>
              <div className="outbox-actions">
                <button type="button" className="btn-tool" onClick={() => retryFailed(f)} disabled={!online}>
                  Retry
                </button>
                <button type="button" className="btn-tool" onClick={() => discardFailed(f)}>
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
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
                <span className="photos-title">Photos (at least 1)</span>
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
                {photos.length >= MAX_PHOTOS && <div className="photo-max">Max {MAX_PHOTOS} photos added</div>}
              </div>
              {!photosOk && <div className="hint photo-required">Add at least 1 photo to save this report.</div>}
            </div>
          )}
          {elevation && (
            <div className="description-box">
              <label className="field" htmlFor="report-description">
                Description <span className="optional">(optional)</span>
              </label>
              <textarea
                id="report-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="Notes about this report…"
                disabled={saving}
              />
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <button className="btn" onClick={save} disabled={!canSave}>
              {saving ? (photos.length ? "Uploading photos…" : "Saving…") : "Save report"}
            </button>
          </div>
          {message && <div className={`msg ${message.kind}`}>{message.text}</div>}
        </div>
      )}

      {todayAll.length > 0 && (
        <div className="card today">
          <button
            type="button"
            className="today-head today-toggle"
            onClick={() => setTodayOpen((o) => !o)}
            aria-expanded={todayOpen}
          >
            <span className="today-title">Changes Today</span>
            <span className="chip">
              {doneToday.size} elevation{doneToday.size === 1 ? "" : "s"} · {todayAll.length} report
              {todayAll.length === 1 ? "" : "s"}
            </span>
            <span className="section-caret" aria-hidden="true">
              {todayOpen ? "▾" : "▸"}
            </span>
          </button>
          {todayOpen &&
            todayGroups.map((g) => (
              <div key={g.key} className="today-group">
                <div className="today-project">{g.project}</div>
                {g.buildings.map((bg) => (
                  <div key={bg.key} className="today-building">
                    <div className="today-building-name">{bg.building}</div>
                    <ul className="today-list">
                      {bg.items.map((t) => (
                        <li
                          key={t.id}
                          className={`${t.latest ? "latest" : "earlier"}${t.pending ? " pending" : ""}`}
                        >
                          <span className="today-name">
                            {t.elevation}
                            {t.pending && <span className="tag pending-tag">Waiting</span>}
                          </span>
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
      {/* Room to scroll the elevation list into view on phones; goes away once an elevation is picked. */}
      {buildingId && !elevationId && <div className="scroll-room" aria-hidden="true" />}
    </main>
  );
}
