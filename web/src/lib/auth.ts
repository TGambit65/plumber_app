import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { cache } from "react";

const COOKIE = "plumber_session";
const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-secret");

export type Role = "TECH" | "SALES_PM" | "OFFICE" | "ADMIN";

export type Session = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  organizationId: string;
};

export async function createSession(user: { id: string; name: string; email: string; role: Role; organizationId: string }) {
  const token = await new SignJWT({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
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
      organizationId: payload.organizationId as string,
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

/**
 * Login bootstrap — the one legitimate cross-tenant read. users is under
 * FORCE RLS, so this goes through auth_user_by_email(), a SECURITY DEFINER
 * function (see src/db/rls.sql) that resolves email → user before any tenant
 * context exists.
 */
export async function verifyCredentials(email: string, password: string) {
  const result = await db.execute(
    sql`select id, email, name, phone, role, password_hash, active, organization_id from auth_user_by_email(${email.toLowerCase().trim()})`
  );
  const row = (result.rows?.[0] ?? null) as
    | { id: string; email: string; name: string; phone: string | null; role: Role; password_hash: string; active: boolean; organization_id: string }
    | null;
  if (!row || !row.active) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role: row.role,
    active: row.active,
    organizationId: row.organization_id,
  };
}
