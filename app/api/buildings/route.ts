import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { isNotionId, queryAll, readNumber, readText } from "@/lib/notion";
import { elevationsByBuilding, norm, simpleAverage } from "@/lib/progress";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!isNotionId(projectId)) return NextResponse.json({ error: "Invalid project" }, { status: 400 });

  const b = props.buildings;

  const [buildingPages, elevationPages] = await Promise.all([
    queryAll(config.buildingsDb, { filter: { property: b.project, relation: { contains: projectId } } }),
    queryAll(config.elevationsDb, {}, 100),
  ]);

  const elevByBuilding = elevationsByBuilding(elevationPages);

  const buildings = buildingPages
    .map((pg) => {
      const values = elevByBuilding.get(norm(pg.id)) ?? [];
      const avg = simpleAverage(values); // simple average, equal weight per elevation
      return {
        id: pg.id,
        name: readText(pg, b.name),
        type: readText(pg, b.type),
        number: readNumber(pg, b.number),
        elevationCount: values.length,
        percent: avg === null ? null : Math.round(avg),
      };
    })
    .sort((a, z) => (a.number ?? 9999) - (z.number ?? 9999) || a.name.localeCompare(z.name));

  return NextResponse.json({ buildings });
}