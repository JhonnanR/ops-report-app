import "server-only";
import { config, props } from "./config";
import { type NotionPage, readNumber, readRelationIds, readText } from "./notion";

/** Page IDs sometimes come with dashes, sometimes without. */
export const norm = (id: string) => id.replace(/-/g, "");

/** "Test…" elevations are ignored unless SHOW_TEST_ELEVATIONS=true. */
export function isHiddenElevation(page: NotionPage): boolean {
  return !config.showTestElevations && /^test/i.test(readText(page, props.elevations.name));
}

/** An elevation's saved progress as 0–100 (blank counts as 0). */
export function elevationPercent(page: NotionPage): number {
  return Math.round((readNumber(page, props.elevations.percent) ?? 0) * 100);
}

export type ElevationRow = { id: string; percent: number; sq: number | null };

/** Group elevations (percent + SQ) by building id (normalized). Hidden elevations skipped. */
export function elevationsByBuilding(elevationPages: NotionPage[]): Map<string, ElevationRow[]> {
  const map = new Map<string, ElevationRow[]>();
  for (const el of elevationPages) {
    if (isHiddenElevation(el)) continue;
    const row: ElevationRow = {
      id: norm(el.id),
      percent: elevationPercent(el),
      sq: readNumber(el, props.elevations.sq),
    };
    for (const bid of readRelationIds(el, props.elevations.building)) {
      const key = norm(bid);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
  }
  return map;
}

/** Simple average: every item has the same weight. Null if there are none. */
export function simpleAverage(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Weighted average:
 *   Σ (% × SQ) ÷ Σ (SQ)
 * Items missing a % or an SQ are left out of both sums.
 */
export function weightedAverage(items: { percent: number | null; sq: number | null }[]) {
  const usable = items.filter(
    (i): i is { percent: number; sq: number } => i.percent !== null && i.sq !== null && i.sq > 0,
  );
  const totalSq = usable.reduce((a, i) => a + i.sq, 0);
  if (totalSq === 0) return { percent: null, included: 0, total: items.length };
  const weighted = usable.reduce((a, i) => a + i.percent * i.sq, 0);
  return { percent: weighted / totalSq, included: usable.length, total: items.length };
}

/**
 * Building % from its elevations.
 * - Weighted by elevation SQ when at least one elevation has SQ
 *   (elevations without SQ are left out).
 * - Otherwise falls back to a simple average of all its elevations.
 */
export function buildingPercent(elevations: ElevationRow[]) {
  const w = weightedAverage(elevations);
  if (w.percent !== null) {
    return { percent: w.percent, method: "weighted" as const, included: w.included, total: w.total };
  }
  const s = simpleAverage(elevations.map((e) => e.percent));
  return {
    percent: s,
    method: s === null ? null : ("simple" as const),
    included: elevations.length,
    total: elevations.length,
  };
}