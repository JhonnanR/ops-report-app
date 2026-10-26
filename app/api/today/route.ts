import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { queryAll } from "@/lib/notion";
import { describeReports } from "@/lib/reports";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/today?since=<ISO of the phone's local midnight>
 * Every report the signed-in supervisor made since then (newest first), with short
 * building / elevation labels and the project each one belongs to.
 * Used for "Today" on the Report page and for the ✓ marks on buildings and elevations.
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

  const logs = await queryAll(
    config.logDb,
    {
      filter: { and: [who, { property: l.changedAt, date: { on_or_after: since } }] },
      sorts: [{ property: l.changedAt, direction: "descending" }],
    },
    5,
  );

  return NextResponse.json({ reports: await describeReports(logs) });
}