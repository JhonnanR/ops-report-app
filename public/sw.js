/*
 * Ops Report – service worker (keeps the app on the phone so it opens with no signal).
 *
 * - Pages: try the network first (fresh app); with no signal, use the last copy saved.
 * - App files (/_next/static, icons): saved the first time they load, then reused.
 * - Data (/api/...): never touched here. The page itself saves lists and waiting reports.
 *
 * Change VERSION to force every phone to drop its old saved copy.
 */
const VERSION = "v1";
const PAGES = `ops-pages-${VERSION}`;
const FILES = `ops-files-${VERSION}`;
const NETWORK_TIMEOUT_MS = 6000; // weak signal: stop waiting and use the saved page

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = [PAGES, FILES];
      for (const key of await caches.keys()) if (!keep.includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // data: handled by the page

  // Pages (opening the app, refreshing)
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGES);
        try {
          const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
          // Only keep real pages (not "go to sign in" redirects or errors).
          if (res.ok && !res.redirected) cache.put(url.pathname, res.clone());
          return res;
        } catch {
          const saved = (await cache.match(url.pathname)) || (await cache.match("/"));
          if (saved) return saved;
          return new Response(
            "<!doctype html><meta name=viewport content='width=device-width'><body style='font-family:system-ui;padding:24px'><h2>No signal</h2><p>Open the app once with a connection so it can be saved on this phone.</p></body>",
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
    return;
  }

  // App files: saved once, reused (file names change with every update, so they never go stale).
  const isAppFile =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/icon.png" ||
    url.pathname === "/apple-icon.png" ||
    url.pathname === "/manifest.webmanifest";
  if (isAppFile) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FILES);
        const saved = await cache.match(req);
        if (saved) return saved;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
  }
});
