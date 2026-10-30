/**
 * Offline helpers for the Report page (runs on the phone, not the server).
 *
 * 1. Saved lists: every list the app loads (projects, buildings, elevations, reasons, today)
 *    is kept on the phone, so it can still be shown when there's no signal.
 * 2. Outbox: a report that can't reach the server is kept on the phone (photos included)
 *    and sent later, in order, once the connection is back.
 */

/* ---------------- Saved lists (phone storage) ---------------- */

const LIST_PREFIX = "ops-report:list:";

export function saveList(key: string, data: unknown) {
  try {
    localStorage.setItem(LIST_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* storage full or blocked: the app still works online */
  }
}

export function loadList<T>(key: string): { at: number; data: T } | null {
  try {
    const raw = localStorage.getItem(LIST_PREFIX + key);
    return raw ? (JSON.parse(raw) as { at: number; data: T }) : null;
  } catch {
    return null;
  }
}

/** Remove every saved list (used when signing out, so the next person doesn't see them). */
export function clearSavedLists() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(LIST_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/** Thrown when there's no connection (or it timed out). */
export class OfflineError extends Error {
  constructor(message = "No connection.") {
    super(message);
    this.name = "OfflineError";
  }
}

/** Thrown when the sign-in has expired. */
export class SignedOutError extends Error {
  constructor() {
    super("Signed out");
    this.name = "SignedOutError";
  }
}

/** fetch() that gives up after `ms` (weak signal) and turns network failures into OfflineError. */
export async function fetchOnline(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new OfflineError();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", ...init, signal: ctrl.signal });
  } catch {
    throw new OfflineError();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load a list from the server and keep a copy on the phone.
 * With no signal, returns the saved copy instead (cachedAt = when it was saved).
 */
export async function getJsonCached<T>(url: string, key: string): Promise<{ data: T; cachedAt: number | null }> {
  try {
    const res = await fetchOnline(url);
    if (res.status === 401) throw new SignedOutError();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || "Something went wrong.");
    saveList(key, data);
    return { data: data as T, cachedAt: null };
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
    const saved = loadList<T>(key);
    if (saved) return { data: saved.data, cachedAt: saved.at };
    throw new OfflineError("No signal, and this list hasn't been saved on this phone yet.");
  }
}

/* ---------------- Outbox (reports waiting to send) ---------------- */

export type OutboxItem = {
  id: string; // unique report ID (stops a report from being saved twice)
  createdAt: string; // when the report was actually made
  elevationId: string;
  percent: number;
  from: number; // % before this report (for the Changes Today list)
  reason?: string;
  reasonId?: string;
  reasonOther?: string;
  description?: string;
  photos: Blob[];
  // labels for showing it in Changes Today while it waits
  project: string;
  projectId: string | null;
  building: string;
  buildingId: string | null;
  elevation: string;
  status: "waiting" | "failed";
  error?: string;
};

const DB_NAME = "ops-report";
const STORE = "outbox";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** All waiting / failed reports, oldest first. */
export async function outboxAll(): Promise<OutboxItem[]> {
  try {
    const items = await withStore<OutboxItem[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxItem[]>);
    return items.sort((a, z) => a.createdAt.localeCompare(z.createdAt));
  } catch {
    return [];
  }
}

export function outboxPut(item: OutboxItem) {
  return withStore("readwrite", (s) => s.put(item));
}

export function outboxDelete(id: string) {
  return withStore("readwrite", (s) => s.delete(id));
}

export function outboxClear() {
  return withStore("readwrite", (s) => s.clear());
}

/** Sign-out clean-up: saved lists, waiting reports and the saved app page (it shows the user's name). */
export async function clearPhoneData() {
  clearSavedLists();
  await outboxClear().catch(() => {});
  try {
    if ("caches" in window) {
      for (const key of await caches.keys()) if (key.startsWith("ops-pages")) await caches.delete(key);
    }
  } catch {
    /* ignore */
  }
}

/** A new unique report ID. */
export function newReportId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/* ---------------- Sending ---------------- */

export type ReportPayload = {
  reportId: string;
  changedAt: string;
  elevationId: string;
  percent: number;
  photos: Blob[];
  description?: string;
  reason?: string;
  reasonId?: string;
  reasonOther?: string;
};

/**
 * Upload the photos, then save the report.
 * Throws OfflineError (no signal), SignedOutError (sign-in expired), or Error (the server refused it).
 */
export async function sendReport(r: ReportPayload): Promise<{ buildingPercent?: number | null }> {
  const photoIds: string[] = [];
  for (let i = 0; i < r.photos.length; i++) {
    const form = new FormData();
    form.append("file", r.photos[i], `photo-${i + 1}.jpg`);
    const up = await fetchOnline("/api/upload", { method: "POST", body: form }, 60000);
    if (up.status === 401) throw new SignedOutError();
    const d = await up.json().catch(() => ({}));
    if (!up.ok || !d.id) throw new Error(d.error || "Photo upload failed.");
    photoIds.push(d.id as string);
  }

  const res = await fetchOnline(
    "/api/progress",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportId: r.reportId,
        changedAt: r.changedAt,
        elevationId: r.elevationId,
        percent: r.percent,
        photoIds,
        description: r.description || undefined,
        reason: r.reason || undefined,
        reasonId: r.reasonId || undefined,
        reasonOther: r.reasonOther || undefined,
      }),
    },
    30000,
  );
  if (res.status === 401) throw new SignedOutError();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Save failed.");
  return data;
}

/**
 * Send every waiting report, oldest first. Stops at the first lost connection or expired sign-in;
 * a report the server refuses is marked "failed" (Retry / Discard) and the rest keep going.
 */
export async function flushOutbox(onProgress?: (done: number, total: number) => void): Promise<{
  sent: number;
  stopped: "offline" | "signed-out" | null;
}> {
  const waiting = (await outboxAll()).filter((x) => x.status === "waiting");
  let sent = 0;
  for (const item of waiting) {
    onProgress?.(sent, waiting.length);
    try {
      await sendReport({
        reportId: item.id,
        changedAt: item.createdAt,
        elevationId: item.elevationId,
        percent: item.percent,
        photos: item.photos,
        description: item.description,
        reason: item.reason,
        reasonId: item.reasonId,
        reasonOther: item.reasonOther,
      });
      await outboxDelete(item.id);
      sent++;
    } catch (e) {
      if (e instanceof OfflineError) return { sent, stopped: "offline" };
      if (e instanceof SignedOutError) return { sent, stopped: "signed-out" };
      await outboxPut({ ...item, status: "failed", error: e instanceof Error ? e.message : "Save failed." });
    }
  }
  onProgress?.(sent, waiting.length);
  return { sent, stopped: null };
}

/** True when the phone's browser storage is more than 80% full. */
export async function storageNearlyFull(): Promise<boolean> {
  try {
    const est = await navigator.storage?.estimate?.();
    return !!est && !!est.quota && (est.usage ?? 0) / est.quota > 0.8;
  } catch {
    return false;
  }
}
