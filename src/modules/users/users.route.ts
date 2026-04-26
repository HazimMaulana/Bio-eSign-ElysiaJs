import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const userRoutes = new Elysia({ prefix: "/users" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        username: true,
        role: true,
        email: true,
        isActive: true,
        createdAt: true,
      },
    });
    return users;
  })
  .get("/:id", async ({ params, set }) => {
    const user = await prisma.user.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        username: true,
        role: true,
        email: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!user) {
      set.status = 404;
      return { error: "User not found" };
    }
    return user;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const passwordHash = await Bun.password.hash(body.password);
    const user = await prisma.user.create({
      data: {
        username: body.username,
        passwordHash,
        email: body.email,
        role: body.role,
        isActive: body.isActive ?? true,
      },
      select: {
        id: true,
        username: true,
        role: true,
        email: true,
        isActive: true,
        createdAt: true,
      },
    });
    set.status = 201;
    return user;
  }, {
    body: t.Object({
      username: t.String(),
      password: t.String(),
      email: t.String(),
      role: t.Optional(
        t.Union([
          t.Literal("SUPERADMIN"),
          t.Literal("FACULTY_ADMIN"),
          t.Literal("LECTURER"),
          t.Literal("STUDENT"),
        ])
      ),
      isActive: t.Optional(t.Boolean()),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await prisma.user.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "User not found" };
    }
    const data: Record<string, unknown> = {};
    if (body.username !== undefined) data.username = body.username;
    if (body.email !== undefined) data.email = body.email;
    if (body.role !== undefined) data.role = body.role;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.password !== undefined) {
      data.passwordHash = await Bun.password.hash(body.password);
    }
    const user = await prisma.user.update({
      where: { id: params.id },
      data,
      select: {
        id: true,
        username: true,
        role: true,
        email: true,
        isActive: true,
        createdAt: true,
      },
    });
    return user;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      username: t.Optional(t.String()),
      password: t.Optional(t.String()),
      email: t.Optional(t.String()),
      role: t.Optional(
        t.Union([
          t.Literal("SUPERADMIN"),
          t.Literal("FACULTY_ADMIN"),
          t.Literal("LECTURER"),
          t.Literal("STUDENT"),
        ])
      ),
      isActive: t.Optional(t.Boolean()),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await prisma.user.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "User not found" };
    }
    await prisma.user.delete({ where: { id: params.id } });
    return { message: "User deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
