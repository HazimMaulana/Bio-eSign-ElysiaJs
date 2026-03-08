import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma";
import { jwtPlugin, authGuard } from "../middleware/auth";

export const courseRoutes = new Elysia({ prefix: "/courses" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const courses = await prisma.course.findMany({
      orderBy: { createdAt: "desc" },
    });
    return courses;
  })
  .get("/:id", async ({ params, set }) => {
    const course = await prisma.course.findUnique({
      where: { id: params.id },
      include: {
        schedules: { include: { lecturer: true, device: true } },
      },
    });
    if (!course) {
      set.status = 404;
      return { error: "Course not found" };
    }
    return course;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const course = await prisma.course.create({
      data: {
        code: body.code,
        name: body.name,
        credits: body.credits ?? 3,
      },
    });
    set.status = 201;
    return course;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
      credits: t.Optional(t.Number()),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await prisma.course.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Course not found" };
    }
    const course = await prisma.course.update({
      where: { id: params.id },
      data: body,
    });
    return course;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      credits: t.Optional(t.Number()),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await prisma.course.findUnique({
      where: { id: params.id },
      include: { _count: { select: { schedules: true } } },
    });
    if (!existing) {
      set.status = 404;
      return { error: "Course not found" };
    }
    if (existing._count.schedules > 0) {
      set.status = 409;
      return {
        error: "Cannot delete course with linked schedules",
        schedules: existing._count.schedules,
      };
    }
    await prisma.course.delete({ where: { id: params.id } });
    return { message: "Course deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
