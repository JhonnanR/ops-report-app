import { NextRequest, NextResponse } from "next/server";
import { getManagerSession } from "@/lib/access";
import { config, props } from "@/lib/config";
import { queryAll } from "@/lib/notion";
import { describeReports } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * GET /api/manager/recent?since=<ISO>
 * Every report from every supervisor since that time (newest first, up to 1,000),
 * with short labels and project names. Used by the Past Reports tab. Manager roles only.
 */
export async function GET(req: NextRequest) {
  if (!(await getManagerSession())) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  if (!config.logDb) return NextResponse.json({ reports: [], enabled: false });

  const since = req.nextUrl.searchParams.get("since");
  if (!since || Number.isNaN(Date.parse(since))) {
    return NextResponse.json({ error: "Missing start date" }, { status: 400 });
  }

  const l = props.log;
  const logs = await queryAll(
    config.logDb,
    {
      filter: { property: l.changedAt, date: { on_or_after: since } },
      sorts: [{ property: l.changedAt, direction: "descending" }],
    },
    10,
  );

  return NextResponse.json({ reports: await describeReports(logs), enabled: true });
}
