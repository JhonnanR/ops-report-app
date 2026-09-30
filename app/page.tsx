import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import Tracker from "./Tracker";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <Tracker supervisorName={session.name} />;
}
