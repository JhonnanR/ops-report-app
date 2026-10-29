import "server-only";
import { props } from "./config";
import { getPage, readDate, readNumber, readRelationIds, readText, type NotionPage } from "./notion";

/** Page IDs sometimes come with dashes, sometimes without. */
export const norm = (id: string) => id.replace(/-/g, "");

/** Amenities show their type ("Cabana"); others "B" + Bldg #, or "B" + the building's number from its name. */
export function shortBuilding(name: string, number: number | null, type = ""): string {
  if (type && !/^(bldg\.?\s*)?type\b/i.test(type.trim())) return type.trim();
  if (number !== null) return `B${number}`;
  const parts = name.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  const first = (parts.length > 1 ? parts[1] : parts[0]) ?? name;
  return first.replace(/^bldg\.?\s*/i, "B").replace(/\s+/g, "");
}

/** Loads each page once, even if many reports point to it. */
async function loadPages(ids: string[]): Promise<Map<string, NotionPage>> {
  const unique = Array.from(new Set(ids.filter(Boolean).map(norm)));
  const pages = await Promise.all(unique.map((id) => getPage(id).catch(() => null)));
  const map = new Map<string, NotionPage>();
  unique.forEach((id, i) => {
    const pg = pages[i];
    if (pg) map.set(id, pg);
  });
  return map;
}

export type ReportRow = {
  id: string;
  elevationId: string | null;
  buildingId: string | null;
  projectId: string | null;
  project: string; // project name
  building: string; // short, e.g. "B1-3"
  elevation: string; // Elevation Code, e.g. "[A203-3]"
  from: number | null;
  to: number | null;
  by: string;
  at: string | null;
};

/**
 * Turns History log rows into short, readable rows:
 * looks up each building / elevation / project once and builds the short labels.
 * A row with no Project uses its building's project.
 */
export async function describeReports(logs: NotionPage[]): Promise<ReportRow[]> {
  const l = props.log;
  const b = props.buildings;
  const e = props.elevations;

  const rows = logs.map((pg) => ({
    pg,
    elevationId: readRelationIds(pg, l.elevation)[0] ?? null,
    buildingId: readRelationIds(pg, l.building)[0] ?? null,
    projectId: readRelationIds(pg, l.project)[0] ?? null,
  }));

  const [buildings, elevations] = await Promise.all([
    loadPages(rows.map((r) => r.buildingId ?? "")),
    loadPages(rows.map((r) => r.elevationId ?? "")),
  ]);
  const projectOf = (r: (typeof rows)[number]) => {
    if (r.projectId) return r.projectId;
    const bp = r.buildingId ? buildings.get(norm(r.buildingId)) : undefined;
    return bp ? (readRelationIds(bp, b.project)[0] ?? null) : null;
  };
  const projects = await loadPages(rows.map((r) => projectOf(r) ?? ""));

  const pct = (n: number | null) => (n === null ? null : Math.round(n * 100));
  return rows.map((r) => {
    const bp = r.buildingId ? buildings.get(norm(r.buildingId)) : undefined;
    const ep = r.elevationId ? elevations.get(norm(r.elevationId)) : undefined;
    const projectId = projectOf(r);
    const pp = projectId ? projects.get(norm(projectId)) : undefined;
    const fallback = readText(r.pg, l.title).replace(/\s-\sRep\s\d+$/, "");
    return {
      id: r.pg.id,
      elevationId: r.elevationId ? norm(r.elevationId) : null,
      buildingId: r.buildingId ? norm(r.buildingId) : null,
      projectId: projectId ? norm(projectId) : null,
      project: pp ? readText(pp, props.projects.name) : "Other",
      building: bp ? shortBuilding(readText(bp, b.name), readNumber(bp, b.number), readText(bp, b.type)) : "",
      elevation: ep ? readText(ep, e.elevCode) || readText(ep, e.code) || fallback : fallback,
      from: pct(readNumber(r.pg, l.from)),
      to: pct(readNumber(r.pg, l.to)),
      by: readText(r.pg, l.changedBy),
      at: readDate(r.pg, l.changedAt),
    };
  });
}