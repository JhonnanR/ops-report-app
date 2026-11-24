import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { createPage } from "@/lib/notion";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const TYPES = ["Bug", "Change", "Question"];
const PAGES = ["Report", "Manager view"];

/** GET /api/feedback → is the "Report an issue" form set up? */
export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ enabled: Boolean(config.appReportsDb) });
}

/**
 * POST /api/feedback  { type, description, urgent, page }
 * Saves an issue / change request from the app as a row in the App Reports DB.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!config.appReportsDb) return NextResponse.json({ error: "Reporting isn't set up yet." }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const type = TYPES.includes(body.type) ? body.type : "Bug";
  const page = PAGES.includes(body.page) ? body.page : "Report";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
  const urgent = body.urgent === true;
  if (description.length < 3) {
    return NextResponse.json({ error: "Please describe the issue." }, { status: 400 });
  }

  // Title: short summary from the description (first line, max 80 characters)
  const firstLine = description.split(/\r?\n/)[0];
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;

  const r = props.appReports;
  await createPage(config.appReportsDb, {
    [r.title]: { title: [{ text: { content: title } }] },
    [r.type]: { select: { name: type } },
    [r.description]: { rich_text: [{ text: { content: description } }] },
    [r.urgent]: { checkbox: urgent },
    [r.submittedBy]: { rich_text: [{ text: { content: session.name } }] },
    [r.submittedByEmail]: { email: session.email || null },
    [r.page]: { select: { name: page } },
  });

  return NextResponse.json({ ok: true });
}
