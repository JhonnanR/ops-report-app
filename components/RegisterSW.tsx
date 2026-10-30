"use client";

import { useEffect } from "react";

/**
 * Turns on the service worker (public/sw.js) so the app opens with no signal.
 * Only in the live app (npm run build + start / Vercel), never during npm run dev.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Ask the phone not to clear saved data (waiting reports) when space runs low.
    navigator.storage?.persist?.().catch(() => {});
  }, []);
  return null;
}
