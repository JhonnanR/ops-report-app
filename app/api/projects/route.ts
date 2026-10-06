import { NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { findProp, queryAll, readDate, readNumber, readRelationIds, readText } from "@/lib/notion";
import { buildingPercent, elevationsByBuilding, norm, rollup } from "@/lib/progress";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Projects to leave out of the app. Option names must match Notion exactly. */
const HIDE_DIVISION = "Brick";
const HIDE_STATUSES = ["Completed"];

export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const p = props.projects;
  const b = props.buildings;
  const e = props.elevations;

  const [projectPages, elevationPages, buildingPages] = await Promise.all([
    queryAll(config.projectsDb, {
      filter: {
        and: [
          { property: p.division, multi_select: { does_not_contain: HIDE_DIVISION } },
          ...HIDE_STATUSES.map((s) => ({ property: p.status, select: { does_not_equal: s } })),
        ],
      },
      sorts: [{ property: p.name, direction: "ascending" }],
    }),
    queryAll(config.elevationsDb, {}, 100),
    queryAll(config.buildingsDb, {}, 100),
  ]);

  // Projects that have at least one elevation (directly, or through one of their buildings).
  const withElevations = new Set<string>();
  for (const el of elevationPages) {
    readRelationIds(el, e.project).forEach((id) => withElevations.add(norm(id)));
  }

  // Building % (weighted by elevation SQ, or simple average) grouped by project, with building SQ.
  const elevByBuilding = elevationsByBuilding(elevationPages);
  const buildingsByProject = new Map<string, { percent: number | null; sq: number | null }[]>();
  const lastReportedByProject = new Map<string, string>();
  for (const bp of buildingPages) {
    const rows = elevByBuilding.get(norm(bp.id)) ?? [];
    const row = { percent: buildingPercent(rows).percent, sq: readNumber(bp, b.sq) };
    const reported = readDate(bp, b.lastReported);
    for (const pid of readRelationIds(bp, b.project)) {
      const key = norm(pid);
      if (rows.length) withElevations.add(key);
      if (!buildingsByProject.has(key)) buildingsByProject.set(key, []);
      buildingsByProject.get(key)!.push(row);
      // Most recent report across the project's buildings
      if (reported && (!lastReportedByProject.has(key) || reported > lastReportedByProject.get(key)!)) {
        lastReportedByProject.set(key, reported);
      }
    }
  }

  const projects = projectPages
    .filter((pg) => withElevations.has(norm(pg.id)))
    .map((pg) => {
      // Project % comes from its buildings' %s (weighted by building SQ when all have SQ).
      const w = rollup(buildingsByProject.get(norm(pg.id)) ?? []);
      const division = findProp(pg, p.division);
      return {
        id: pg.id,
        name: readText(pg, p.name),
        status: readText(pg, p.status),
        divisions: (division?.multi_select ?? []).map((o: { name: string }) => o.name) as string[],
        percent: w.percent === null ? null : Math.round(w.percent),
        included: w.included, // buildings that have progress
        total: w.total, // all buildings on the project
        lastReported: lastReportedByProject.get(norm(pg.id)) ?? null,
      };
    })
    .filter((x) => x.name);

  return NextResponse.json({ projects });
}