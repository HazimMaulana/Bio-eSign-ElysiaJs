import { Elysia } from "elysia";
import { jwt } from "@elysiajs/jwt";

export const jwtPlugin = new Elysia({ name: "jwt-plugin" }).use(
  jwt({
    name: "jwt",
    secret: process.env.JWT_SECRET || "super-secret-key-for-university-bioesign",
  })
);

export const authGuard = async ({ jwt, set, headers }: { jwt: any; set: any; headers: Record<string, string | undefined> }) => {
  const auth = headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    set.status = 401;
    return "Unauthorized";
  }
  const token = auth.split(" ")[1];
  const profile = await jwt.verify(token);
  if (!profile) {
    set.status = 401;
    return "Invalid Token";
  }
};
