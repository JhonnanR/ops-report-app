import { NextRequest, NextResponse } from "next/server";
import { uploadFile } from "@/lib/notion";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024; // photos are shrunk on the phone first; this is a safety limit

/**
 * POST /api/upload  (multipart form, field "file")
 * Sends one photo to Notion and returns its file_upload ID.
 * The ID is attached to the history row when the progress is saved.
 */
export async function POST(req: NextRequest) {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "No photo received." }, { status: 400 });
  if (!file.type.startsWith("image/")) return NextResponse.json({ error: "Only photos can be uploaded." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Photo is too large." }, { status: 413 });

  try {
    const name = `progress-${Date.now()}.jpg`;
    const id = await uploadFile(file, name);
    return NextResponse.json({ id, name });
  } catch (err) {
    console.error("ops-report: photo upload failed", err);
    return NextResponse.json({ error: "Photo upload failed. Try again." }, { status: 502 });
  }
}