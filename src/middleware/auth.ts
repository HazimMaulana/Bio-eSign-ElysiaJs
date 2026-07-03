import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";

export const jwtPlugin = new Elysia({ name: "jwt-plugin" }).use(
  jwt({
    name: "jwt",
    secret: process.env.JWT_SECRET || "super-secret-key-for-university-bioesign",
  })
);

function getCookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey !== name) continue;

    const value = rawValue.join("=");
    return value ? decodeURIComponent(value) : null;
  }

  return null;
}

export const authGuard = async ({ jwt, set, headers }: { jwt: any; set: any; headers: Record<string, string | undefined> }) => {
  const auth = headers.authorization;
  const bearerToken = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;
  const cookieToken = getCookieValue(headers.cookie, "auth_token");
  const token = bearerToken || cookieToken;

  if (!token) {
    set.status = 401;
    return "Unauthorized";
  }

  const profile = await jwt.verify(token);
  if (!profile) {
    set.status = 401;
    return "Invalid Token";
  }
};
