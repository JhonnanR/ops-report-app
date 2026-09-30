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

/** Group elevation percentages by building id (normalized). Hidden elevations skipped. */
export function elevationsByBuilding(elevationPages: NotionPage[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const el of elevationPages) {
    if (isHiddenElevation(el)) continue;
    for (const bid of readRelationIds(el, props.elevations.building)) {
      const key = norm(bid);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(elevationPercent(el));
    }
  }
  return map;
}

/** Simple average: every elevation has the same weight. Null if there are none. */
export function simpleAverage(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Weighted average for a project:
 *   Σ (building % × building SQ) ÷ Σ (building SQ)
 * Buildings missing a % or an SQ are left out of both sums.
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