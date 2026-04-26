import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const departmentRoutes = new Elysia({ prefix: "/departments" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const departments = await prisma.department.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { students: true, lecturers: true } },
      },
    });
    return departments;
  })
  .get("/:id", async ({ params, set }) => {
    const department = await prisma.department.findUnique({
      where: { id: params.id },
      include: {
        _count: { select: { students: true, lecturers: true } },
      },
    });
    if (!department) {
      set.status = 404;
      return { error: "Department not found" };
    }
    return department;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const department = await prisma.department.create({
      data: { code: body.code, name: body.name },
    });
    set.status = 201;
    return department;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await prisma.department.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Department not found" };
    }
    const department = await prisma.department.update({
      where: { id: params.id },
      data: body,
    });
    return department;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await prisma.department.findUnique({
      where: { id: params.id },
      include: { _count: { select: { students: true, lecturers: true } } },
    });
    if (!existing) {
      set.status = 404;
      return { error: "Department not found" };
    }
    if (existing._count.students > 0 || existing._count.lecturers > 0) {
      set.status = 409;
      return {
        error: "Cannot delete department with linked students or lecturers",
        students: existing._count.students,
        lecturers: existing._count.lecturers,
      };
    }
    await prisma.department.delete({ where: { id: params.id } });
    return { message: "Department deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
