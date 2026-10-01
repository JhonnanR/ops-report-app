import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { findProp, getPage, isNotionId, queryAll, readNumber, readRelationIds, updatePage } from "@/lib/notion";
import { buildingPercent, elevationsByBuilding, norm } from "@/lib/progress";
import { getSession } from "@/lib/session";

/** Building % (0–100) after this save: weighted by elevation SQ, or simple average if none have SQ. */
async function buildingAverage(buildingId: string, saved: { id: string; percent: number }) {
  const pages = await queryAll(config.elevationsDb, {
    filter: { property: props.elevations.building, relation: { contains: buildingId } },
  });
  const rows = (elevationsByBuilding(pages).get(norm(buildingId)) ?? []).map((r) =>
    r.id === norm(saved.id) ? { ...r, percent: saved.percent } : r,
  );
  const bp = buildingPercent(rows);
  return bp.percent === null ? saved.percent : Math.round(bp.percent);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { elevationId } = body;
  const percent = Number(body.percent);

  if (!isNotionId(elevationId)) return NextResponse.json({ error: "Invalid elevation" }, { status: 400 });
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    return NextResponse.json({ error: "Percent must be a whole number from 0 to 100." }, { status: 400 });
  }

  const e = props.elevations;
  const b = props.buildings;

  // Make sure the page really is an elevation, and find its building.
  const page = await getPage(elevationId);
  const parentDb = (page.parent?.database_id ?? "").replace(/-/g, "");
  if (parentDb !== config.elevationsDb.replace(/-/g, "") || !findProp(page, e.percent)) {
    return NextResponse.json({ error: "Not an elevation record" }, { status: 400 });
  }
  const buildingIds = readRelationIds(page, e.building);

  // Progress can only go up.
  const current = Math.round((readNumber(page, e.percent) ?? 0) * 100);
  if (percent < current) {
    return NextResponse.json(
      { error: `This elevation is already at ${current}%. Progress can't go down.` },
      { status: 409 },
    );
  }

  // 1. Save the elevation.
  await updatePage(elevationId, {
    [e.percent]: { number: percent / 100 },
    [e.completed]: { checkbox: percent === 100 },
    [e.submittedBy]: { rich_text: [{ text: { content: session.name } }] },
    [e.submitterEmail]: { email: session.email || null },
  });

  // 2. Roll up to the building.
  const now = new Date().toISOString();
  const buildingPercents = await Promise.all(
    buildingIds.map(async (id) => {
      const avg = await buildingAverage(id, { id: elevationId, percent });
      await updatePage(id, {
        [b.progress]: { number: avg / 100 },
        [b.completed]: { checkbox: avg === 100 },
        [b.lastReported]: { date: { start: now } },
      });
      return avg;
    }),
  );

  return NextResponse.json({
    ok: true,
    percent,
    buildingPercent: buildingPercents[0] ?? null,
    submittedBy: session.name,
    at: now,
  });
}

export const dynamic = "force-dynamic";