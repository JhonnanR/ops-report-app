"use client";

import { useEffect } from "react";

// Must match VERSION in public/sw.js
const PAGES = "ops-pages-v1";
const FILES = "ops-files-v1";

/**
 * Save the Report page and every app file it just loaded on the phone,
 * so the app can open from scratch with no signal next time.
 * (The very first load happens before the service worker is running, so it can't save it by itself.)
 */
async function saveForOffline() {
  if (!("caches" in window) || !navigator.onLine) return;

  // App files this page loaded (scripts, styles, icons)
  const files = await caches.open(FILES);
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => {
      const url = new URL(u);
      return url.origin === location.origin && /^\/(_next\/static|icons)\//.test(url.pathname);
    });
  await Promise.all(
    urls.map(async (u) => {
      try {
        if (!(await files.match(u))) await files.add(u);
      } catch {
        /* skip a file that fails; the rest still save */
      }
    }),
  );

  // The Report page itself (only if signed in, i.e. not sent to /login)
  if (location.pathname === "/") {
    try {
      const res = await fetch("/", { credentials: "same-origin", cache: "no-store" });
      if (res.ok && !res.redirected) await (await caches.open(PAGES)).put("/", res);
    } catch {
      /* no signal right now: it will save next time */
    }
  }
}

/**
 * Turns on the service worker (public/sw.js) so the app opens with no signal.
 * Only in the live app (npm run build + start / Vercel), never during npm run dev.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => saveForOffline())
      .catch(() => {});
    // Ask the phone not to clear saved data (waiting reports) when space runs low.
    navigator.storage?.persist?.().catch(() => {});
  }, []);
  return null;
}
