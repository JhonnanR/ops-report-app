import "server-only";
import { getSession, type Session } from "./session";

/**
 * Roles that can open the Project Manager view.
 * Matched against the Role column in Authorized Supervisors (case-insensitive, "contains").
 */
const MANAGER_ROLES = [/project manager/i, /business transformation/i];

export function isManager(session: Pick<Session, "role"> | null | undefined): boolean {
  const role = session?.role ?? "";
  return MANAGER_ROLES.some((re) => re.test(role));
}

/** Returns the session if the signed-in user may use the manager view, otherwise null. */
export async function getManagerSession(): Promise<Session | null> {
  const session = await getSession();
  return session && isManager(session) ? session : null;
}