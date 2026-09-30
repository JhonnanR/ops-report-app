import { NextRequest, NextResponse } from "next/server";
import { config, props } from "@/lib/config";
import { queryAll, readText } from "@/lib/notion";
import { SESSION_COOKIE, cookieOptions, encodeSession } from "@/lib/session";

// Basic brute-force protection. In-memory, so it resets per server instance;
// good enough as a speed bump until Microsoft SSO replaces passwords.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (tooManyAttempts(ip)) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password.trim() : "";
  if (!password || password.length > 200) {
    return NextResponse.json({ error: "Enter your password." }, { status: 400 });
  }

  const p = props.supervisors;
  const matches = await queryAll(config.supervisorsDb, {
    filter: {
      and: [
        { property: p.password, rich_text: { equals: password } },
        { property: p.active, checkbox: { equals: true } },
      ],
    },
  });

  if (matches.length === 0) {
    return NextResponse.json({ error: "Password not recognized." }, { status: 401 });
  }
  if (matches.length > 1) {
    // Two active supervisors share a password: we can't tell who this is.
    console.error("ops-report: duplicate supervisor password detected");
    return NextResponse.json(
      { error: "This password is assigned to more than one person. Ask the office to reset it." },
      { status: 409 },
    );
  }

  const sup = matches[0];
  attempts.delete(ip);
  const { value, maxAge } = encodeSession({
    id: sup.id,
    name: readText(sup, p.name),
    email: readText(sup, p.email),
  });

  const res = NextResponse.json({ ok: true, name: readText(sup, p.name) });
  res.cookies.set(SESSION_COOKIE, value, { ...cookieOptions, maxAge });
  return res;
}
