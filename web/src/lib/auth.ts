import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { db, t } from "@/db";
import { eq } from "drizzle-orm";
import { cache } from "react";

const COOKIE = "plumber_session";
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-secret");

export type Role = "TECH" | "SALES_PM" | "OFFICE" | "ADMIN";

export type Session = {
  userId: string;
  name: string;
  email: string;
  role: Role;
};

export async function createSession(user: { id: string; name: string; email: string; role: Role }) {
  const token = await new SignJWT({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());

  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
}

export async function destroySession() {
  cookies().delete(COOKIE);
}

export const getSession = cache(async (): Promise<Session | null> => {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      userId: payload.userId as string,
      name: payload.name as string,
      email: payload.email as string,
      role: payload.role as Role,
    };
  } catch {
    return null;
  }
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
  return session!;
}

export async function verifyCredentials(email: string, password: string) {
  const [user] = await db.select().from(t.users).where(eq(t.users.email, email.toLowerCase().trim()));
  if (!user || !user.active) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}
