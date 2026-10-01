import { NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { queryAll, readNumber, readRelationIds, readText } from "@/lib/notion";
import { buildingPercent, elevationsByBuilding, norm, weightedAverage } from "@/lib/progress";
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
  for (const bp of buildingPages) {
    const rows = elevByBuilding.get(norm(bp.id)) ?? [];
    const row = { percent: buildingPercent(rows).percent, sq: readNumber(bp, b.sq) };
    for (const pid of readRelationIds(bp, b.project)) {
      const key = norm(pid);
      if (rows.length) withElevations.add(key);
      if (!buildingsByProject.has(key)) buildingsByProject.set(key, []);
      buildingsByProject.get(key)!.push(row);
    }
  }

  const projects = projectPages
    .filter((pg) => withElevations.has(norm(pg.id)))
    .map((pg) => {
      // Project % = Σ(building % × building SQ) ÷ Σ building SQ
      const w = weightedAverage(buildingsByProject.get(norm(pg.id)) ?? []);
      return {
        id: pg.id,
        name: readText(pg, p.name),
        status: readText(pg, p.status),
        percent: w.percent === null ? null : Math.round(w.percent),
        included: w.included, // buildings with both SQ and elevations
        total: w.total, // all buildings on the project
      };
    })
    .filter((x) => x.name);

  return NextResponse.json({ projects });
}