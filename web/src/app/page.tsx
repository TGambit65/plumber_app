import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/permissions";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");
  redirect(ROLE_HOME[session.role]);
}
