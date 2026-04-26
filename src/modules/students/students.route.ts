import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const studentRoutes = new Elysia({ prefix: "/students" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const students = await prisma.student.findMany({
      orderBy: { createdAt: "desc" },
      include: { department: true },
    });
    return students;
  })
  .get("/:id", async ({ params, set }) => {
    const student = await prisma.student.findUnique({
      where: { id: params.id },
      include: {
        department: true,
        fingerprints: {
          select: {
            id: true,
            slot: true,
            fingerprintIdOnDevice: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!student) {
      set.status = 404;
      return { error: "Student not found" };
    }
    return student;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const student = await prisma.student.create({
      data: {
        nim: body.nim,
        name: body.name,
        email: body.email,
        isActive: body.isActive ?? true,
        departmentId: body.departmentId,
      },
      include: { department: true },
    });
    set.status = 201;
    return student;
  }, {
    body: t.Object({
      nim: t.String(),
      name: t.String(),
      email: t.Optional(t.Union([t.String(), t.Null()])),
      isActive: t.Optional(t.Boolean()),
      departmentId: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await prisma.student.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Student not found" };
    }
    const student = await prisma.student.update({
      where: { id: params.id },
      data: body,
      include: { department: true },
    });
    return student;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      nim: t.Optional(t.String()),
      name: t.Optional(t.String()),
      email: t.Optional(t.Union([t.String(), t.Null()])),
      isActive: t.Optional(t.Boolean()),
      departmentId: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await prisma.student.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Student not found" };
    }
    await prisma.student.delete({ where: { id: params.id } });
    return { message: "Student deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
