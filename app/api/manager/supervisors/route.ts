import { NextResponse } from "next/server";
import { getManagerSession } from "@/lib/access";
import { config, props } from "@/lib/config";
import { queryAll, readText } from "@/lib/notion";

export const dynamic = "force-dynamic";

/** Names of active supervisors, for the History filter. (Names only, never passwords.) */
export async function GET() {
  if (!(await getManagerSession())) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  const s = props.supervisors;
  const pages = await queryAll(config.supervisorsDb, {
    filter: { property: s.active, checkbox: { equals: true } },
  });
  const names = pages
    .map((pg) => readText(pg, s.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return NextResponse.json({ supervisors: names });
}