import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { config } from "./config";

export const SESSION_COOKIE = "ops_report_session";

export type Session = {
  id: string; // Authorized Supervisors page id
  name: string;
  email: string;
  exp: number; // unix ms
};

function sign(payload: string): string {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

export function encodeSession(data: Omit<Session, "exp">): { value: string; maxAge: number } {
  const maxAge = Math.round(config.sessionHours * 3600);
  const session: Session = { ...data, exp: Date.now() + maxAge * 1000 };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return { value: `${payload}.${sign(payload)}`, maxAge };
}

export function decodeSession(value: string | undefined): Session | null {
  if (!value) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (typeof session.exp !== "number" || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};
