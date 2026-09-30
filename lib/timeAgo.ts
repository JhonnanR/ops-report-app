/** "just now", "5 minutes ago", "2 hours ago", "1 day ago", "1 week ago", "3 months ago", "1 year ago" */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const s = Math.max(0, Math.floor((now - then) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const w = Math.floor(d / 7);
  const mo = Math.floor(d / 30);
  const y = Math.floor(d / 365);

  const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

  if (m < 1) return "just now";
  if (h < 1) return ago(m, "minute");
  if (d < 1) return ago(h, "hour");
  if (w < 1) return ago(d, "day");
  if (mo < 1) return ago(w, "week");
  if (y < 1) return ago(mo, "month");
  return ago(y, "year");
}