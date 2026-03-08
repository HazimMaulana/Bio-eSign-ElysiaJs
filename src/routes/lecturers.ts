import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma";
import { jwtPlugin, authGuard } from "../middleware/auth";

export const lecturerRoutes = new Elysia({ prefix: "/lecturers" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const lecturers = await prisma.lecturer.findMany({
      orderBy: { createdAt: "desc" },
      include: { department: true },
    });
    return lecturers;
  })
  .get("/:id", async ({ params, set }) => {
    const lecturer = await prisma.lecturer.findUnique({
      where: { id: params.id },
      include: {
        department: true,
        schedules: { include: { course: true, device: true } },
      },
    });
    if (!lecturer) {
      set.status = 404;
      return { error: "Lecturer not found" };
    }
    return lecturer;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const lecturer = await prisma.lecturer.create({
      data: {
        nidn: body.nidn,
        name: body.name,
        email: body.email,
        departmentId: body.departmentId,
      },
      include: { department: true },
    });
    set.status = 201;
    return lecturer;
  }, {
    body: t.Object({
      nidn: t.String(),
      name: t.String(),
      email: t.String(),
      departmentId: t.String(),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await prisma.lecturer.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Lecturer not found" };
    }
    const lecturer = await prisma.lecturer.update({
      where: { id: params.id },
      data: body,
      include: { department: true },
    });
    return lecturer;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      nidn: t.Optional(t.String()),
      name: t.Optional(t.String()),
      email: t.Optional(t.String()),
      departmentId: t.Optional(t.String()),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await prisma.lecturer.findUnique({
      where: { id: params.id },
      include: { _count: { select: { schedules: true } } },
    });
    if (!existing) {
      set.status = 404;
      return { error: "Lecturer not found" };
    }
    if (existing._count.schedules > 0) {
      set.status = 409;
      return {
        error: "Cannot delete lecturer with linked schedules",
        schedules: existing._count.schedules,
      };
    }
    await prisma.lecturer.delete({ where: { id: params.id } });
    return { message: "Lecturer deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
