import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import {
  createPage,
  findProp,
  getPage,
  isNotionId,
  queryAll,
  readNumber,
  readRelationIds,
  readText,
  updatePage,
} from "@/lib/notion";
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
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 100) : "";
  const reasonId = typeof body.reasonId === "string" ? body.reasonId.trim().slice(0, 100) : "";
  const reasonOther = typeof body.reasonOther === "string" ? body.reasonOther.trim().slice(0, 300) : "";
  // Photo upload IDs from /api/upload (optional, up to 3)
  const photoIds: string[] = Array.isArray(body.photoIds)
    ? body.photoIds.filter((x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{32,36}$/i.test(x)).slice(0, 3)
    : [];

  if (!isNotionId(elevationId)) return NextResponse.json({ error: "Invalid elevation" }, { status: 400 });
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    return NextResponse.json({ error: "Percent must be a whole number from 0 to 100." }, { status: 400 });
  }

  const e = props.elevations;
  const b = props.buildings;

  const photosEnabled = Boolean(config.logDb && props.log.photos); // photos are optional

  // Make sure the page really is an elevation, and find its building + project.
  const page = await getPage(elevationId);
  const parentDb = (page.parent?.database_id ?? "").replace(/-/g, "");
  if (parentDb !== config.elevationsDb.replace(/-/g, "") || !findProp(page, e.percent)) {
    return NextResponse.json({ error: "Not an elevation record" }, { status: 400 });
  }
  const buildingIds = readRelationIds(page, e.building);
  let projectIds = readRelationIds(page, e.project);
  // Many elevations don't have Project filled in. Fall back to the building's project.
  if (projectIds.length === 0 && buildingIds.length) {
    const buildingPages = await Promise.all(buildingIds.map((id) => getPage(id).catch(() => null)));
    projectIds = [
      ...new Set(buildingPages.flatMap((bp) => (bp ? readRelationIds(bp, b.project) : []))),
    ];
  }

  // Progress can go down, but only with a reason.
  const current = Math.round((readNumber(page, e.percent) ?? 0) * 100);
  const isDecrease = percent < current;
  const isOther = /other/i.test(reason); // the option whose name contains "Other" needs a typed reason
  if (isDecrease && (!reason || (isOther && !reasonOther))) {
    return NextResponse.json(
      { error: `Lowering from ${current}% to ${percent}% needs a reason.` },
      { status: 400 },
    );
  }

  // 1. Save the elevation (and replace its Latest Photo with this save's photos).
  await updatePage(elevationId, {
    [e.percent]: { number: percent / 100 },
    [e.completed]: { checkbox: percent === 100 },
    [e.submittedBy]: { rich_text: [{ text: { content: session.name } }] },
    [e.submitterEmail]: { email: session.email || null },
    ...(e.latestPhoto && photoIds.length
      ? {
          [e.latestPhoto]: {
            files: photoIds.map((id, i) => ({
              type: "file_upload",
              file_upload: { id },
              name: `latest-${i + 1}.jpg`,
            })),
          },
        }
      : {}),
  });

  const now = new Date().toISOString();

  // 2. Add a row to the history log (never blocks the save if it fails).
  let logged = false;
  if (config.logDb) {
    const l = props.log;
    const elevationName = readText(page, e.code) || readText(page, e.name) || "Elevation";
    try {
      // Report number for this elevation: existing reports + 1 → "… - Rep 3"
      const prior = await queryAll(config.logDb, {
        filter: { property: l.elevation, relation: { contains: elevationId } },
      });
      const repNo = prior.length + 1;

      await createPage(config.logDb, {
        [l.title]: { title: [{ text: { content: `${elevationName} - Rep ${repNo}` } }] },
        ...(l.reportNo ? { [l.reportNo]: { number: repNo } } : {}),
        [l.elevation]: { relation: [{ id: elevationId }] },
        [l.building]: { relation: buildingIds.map((id) => ({ id })) },
        [l.project]: { relation: projectIds.map((id) => ({ id })) },
        [l.from]: { number: current / 100 },
        [l.to]: { number: percent / 100 },
        [l.changedBy]: { rich_text: [{ text: { content: session.name } }] },
        [l.changedByEmail]: { email: session.email || null },
        [l.changedAt]: { date: { start: now } },
        // Reason (Notion Select) + Other Reason (Text, only when "Other" was picked)
        // Select by option ID when we have it (rename-safe), otherwise by name.
        ...(isDecrease && l.reason ? { [l.reason]: { select: reasonId ? { id: reasonId } : { name: reason } } } : {}),
        ...(isDecrease && isOther && l.reasonOther
          ? { [l.reasonOther]: { rich_text: [{ text: { content: reasonOther } }] } }
          : {}),
        // Photos (Notion "Files & media" column)
        ...(photosEnabled && photoIds.length
          ? {
              [l.photos]: {
                files: photoIds.map((id, i) => ({
                  type: "file_upload",
                  file_upload: { id },
                  name: `photo-${i + 1}.jpg`,
                })),
              },
            }
          : {}),
      });
      logged = true;
    } catch (err) {
      console.error("ops-report: could not write history log", err);
    }
  }

  // 3. Roll up to the building.
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
    logged,
  });
}

export const dynamic = "force-dynamic";