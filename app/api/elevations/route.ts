import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { isNotionId, queryAll, readNumber, readText } from "@/lib/notion";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const buildingId = req.nextUrl.searchParams.get("buildingId");
  if (!isNotionId(buildingId)) return NextResponse.json({ error: "Invalid building" }, { status: 400 });

  const e = props.elevations;
  const pages = await queryAll(config.elevationsDb, {
    filter: { property: e.building, relation: { contains: buildingId } },
  });

  const elevations = pages
    .map((pg) => {
      const pct = readNumber(pg, e.percent);
      return {
        id: pg.id,
        name: readText(pg, e.name) || readText(pg, e.code),
        code: readText(pg, e.code),
        percent: pct === null ? null : Math.round(pct * 100),
        submittedBy: readText(pg, e.submittedBy),
        lastEdited: pg.last_edited_time ?? null,
      };
    })
    .filter((x) => config.showTestElevations || !/^test/i.test(x.name))
    .sort((a, z) => a.name.localeCompare(z.name));

  return NextResponse.json({ elevations });
}