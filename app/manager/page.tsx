import { redirect } from "next/navigation";
import { isManager } from "@/lib/access";
import { getSession } from "@/lib/session";
import ManagerView from "./ManagerView";

export const dynamic = "force-dynamic";

export default async function ManagerPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!isManager(session)) redirect("/"); // not a PM / Business Transformation role
  return <ManagerView userName={session.name} />;
}