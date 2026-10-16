import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { queryAll, readDate, readNumber, readRelationIds, readText } from "@/lib/notion";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/today?since=<ISO of the phone's local midnight>
 * The signed-in supervisor's reports since then (newest first), from the history log.
 * Used for "Today" on the Report page and to grey out elevations already done today.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!config.logDb) return NextResponse.json({ reports: [] });

  const since = req.nextUrl.searchParams.get("since");
  if (!since || Number.isNaN(Date.parse(since))) {
    return NextResponse.json({ error: "Missing start of day" }, { status: 400 });
  }

  const l = props.log;
  // Match by email when we have it (unique), otherwise by name.
  const who = session.email
    ? { property: l.changedByEmail, email: { equals: session.email } }
    : { property: l.changedBy, rich_text: { equals: session.name } };

  const pages = await queryAll(
    config.logDb,
    {
      filter: { and: [who, { property: l.changedAt, date: { on_or_after: since } }] },
      sorts: [{ property: l.changedAt, direction: "descending" }],
    },
    5,
  );

  const pct = (n: number | null) => (n === null ? null : Math.round(n * 100));
  const reports = pages.map((pg) => ({
    id: pg.id,
    elevationId: readRelationIds(pg, l.elevation)[0] ?? null,
    elevation: readText(pg, l.title).replace(/\s-\sRep\s\d+$/, ""),
    from: pct(readNumber(pg, l.from)),
    to: pct(readNumber(pg, l.to)),
    at: readDate(pg, l.changedAt),
  }));

  return NextResponse.json({ reports });
}