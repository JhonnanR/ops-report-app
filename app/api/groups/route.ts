import { NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { findProp, queryAll, readText } from "@/lib/notion";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/groups
 * The crews/groups from the Groups DB: { id, name, members, active }, sorted by name.
 * The Report page lists the active ones in its "Group" dropdown; both pages use the names.
 */
export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!config.groupsDb) return NextResponse.json({ groups: [], enabled: false });

  const g = props.groups;
  const pages = await queryAll(config.groupsDb, {});
  const groups = pages
    .map((pg) => ({
      id: pg.id.replace(/-/g, ""),
      name: readText(pg, g.name),
      members: readText(pg, g.members),
      active: findProp(pg, g.active)?.checkbox === true,
    }))
    .filter((x) => x.name)
    .sort((a, z) => a.name.localeCompare(z.name, undefined, { numeric: true }));

  return NextResponse.json({ groups, enabled: true });
}
