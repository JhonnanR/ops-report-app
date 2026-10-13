import { NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { getDatabaseProps } from "@/lib/notion";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Used only if the Reason column can't be read (e.g. no log DB yet). */
const FALLBACK = ["Entered wrong %", "Work removed / redone", "Damage", "Inspection failed", "Scope change", "Other"];

/**
 * GET /api/reasons → the options of the "Reason" Select column in the history log.
 * Add, rename, reorder or delete options in Notion and the app follows — no code change.
 */
export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const fallback = FALLBACK.map((name) => ({ id: "", name }));
  const key = props.log.reason;
  if (!config.logDb || !key) return NextResponse.json({ reasons: fallback });

  try {
    const columns = Object.values(await getDatabaseProps(config.logDb));
    const same = (a: string, b: string) => {
      try {
        return a === b || decodeURIComponent(a) === decodeURIComponent(b);
      } catch {
        return a === b;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = columns.find((c: any) => same(c.id, key) || c.name === key) as any;
    const options: { id: string; name: string }[] = col?.type === "select" ? col.select.options : [];
    if (!options.length) return NextResponse.json({ reasons: fallback });
    return NextResponse.json({ reasons: options.map((o) => ({ id: o.id, name: o.name })) });
  } catch (err) {
    console.error("ops-report: could not read Reason options", err);
    return NextResponse.json({ reasons: fallback });
  }
}