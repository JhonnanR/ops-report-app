import { NextRequest, NextResponse } from "next/server";
import { getManagerSession } from "@/lib/access";
import { config, props } from "@/lib/config";
import { isNotionId, queryAll, queryPage, readDate, readNumber, readRelationIds, readText } from "@/lib/notion";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/history
 *   ?projectId= &buildingId= &elevationId= &supervisor= &from=ISO &to=ISO &cursor=
 * Newest first, 50 at a time. Manager roles only.
 */
export async function GET(req: NextRequest) {
  if (!(await getManagerSession())) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  if (!config.logDb) return NextResponse.json({ history: [], nextCursor: null, enabled: false });

  const q = req.nextUrl.searchParams;
  const l = props.log;
  const filters: unknown[] = [];

  const projectId = q.get("projectId");
  const buildingId = q.get("buildingId");
  const elevationId = q.get("elevationId");
  const supervisor = q.get("supervisor")?.trim();
  const from = q.get("from");
  const to = q.get("to");

  // Use the most specific location chosen: elevation > building > project.
  if (isNotionId(elevationId)) {
    filters.push({ property: l.elevation, relation: { contains: elevationId } });
  } else if (isNotionId(buildingId)) {
    filters.push({ property: l.building, relation: { contains: buildingId } });
  } else if (isNotionId(projectId)) {
    // Match rows linked to the project directly OR to any of its buildings
    // (older rows may not have Project filled in).
    const buildings = await queryAll(config.buildingsDb, {
      filter: { property: props.buildings.project, relation: { contains: projectId } },
    });
    filters.push({
      or: [
        { property: l.project, relation: { contains: projectId } },
        ...buildings.slice(0, 90).map((bp) => ({ property: l.building, relation: { contains: bp.id } })),
      ],
    });
  }
  if (supervisor) filters.push({ property: l.changedBy, rich_text: { equals: supervisor } });
  if (from && !Number.isNaN(Date.parse(from))) filters.push({ property: l.changedAt, date: { on_or_after: from } });
  if (to && !Number.isNaN(Date.parse(to))) filters.push({ property: l.changedAt, date: { before: to } });

  const { results, nextCursor } = await queryPage(
    config.logDb,
    {
      ...(filters.length ? { filter: { and: filters } } : {}),
      sorts: [{ property: l.changedAt, direction: "descending" }],
    },
    q.get("cursor"),
  );

  const pct = (n: number | null) => (n === null ? null : Math.round(n * 100));
  const history = results.map((pg) => ({
    id: pg.id,
    elevation: readText(pg, l.title),
    projectId: readRelationIds(pg, l.project)[0] ?? null,
    from: pct(readNumber(pg, l.from)),
    to: pct(readNumber(pg, l.to)),
    by: readText(pg, l.changedBy),
    at: readDate(pg, l.changedAt),
  }));

  return NextResponse.json({ history, nextCursor, enabled: true });
}