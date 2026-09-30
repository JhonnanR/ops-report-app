import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return (
    <main className="center">
      <div className="card login">
        <h1>Ops Report</h1>
        <p>Enter your supervisor password to report progress.</p>
        <LoginForm />
      </div>
    </main>
  );
}
