import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

async function findFacultyIdentity(code: string) {
  return await prisma.faculty.findUnique({
    where: { code },
    select: { id: true },
  });
}

export const facultyRoutes = new Elysia({ prefix: "/faculties", tags: ["Faculties"] })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    return await prisma.faculty.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { departments: true } },
      },
    });
  })
  .get("/:code", async ({ params, set }) => {
    const faculty = await prisma.faculty.findUnique({
      where: { code: params.code },
      include: {
        departments: {
          orderBy: { name: "asc" },
          include: {
            _count: {
              select: {
                students: true,
                lecturers: true,
                courses: true,
                classes: true,
              },
            },
          },
        },
        _count: { select: { departments: true } },
      },
    });

    if (!faculty) {
      set.status = 404;
      return { error: "Faculty not found" };
    }

    return faculty;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const faculty = await prisma.faculty.create({
      data: {
        code: body.code,
        name: body.name,
      },
      include: {
        _count: { select: { departments: true } },
      },
    });

    set.status = 201;
    return faculty;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
    }),
  })
  .put("/:code", async ({ params, body, set }) => {
    const existing = await findFacultyIdentity(params.code);

    if (!existing) {
      set.status = 404;
      return { error: "Faculty not found" };
    }

    const faculty = await prisma.faculty.update({
      where: { id: existing.id },
      data: body,
      include: {
        _count: { select: { departments: true } },
      },
    });

    return faculty;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
    }),
  })
  .delete("/:code", async ({ params, set }) => {
    const identity = await findFacultyIdentity(params.code);

    if (!identity) {
      set.status = 404;
      return { error: "Faculty not found" };
    }

    const existing = await prisma.faculty.findUnique({
      where: { id: identity.id },
      include: { _count: { select: { departments: true } } },
    });

    if (!existing) {
      set.status = 404;
      return { error: "Faculty not found" };
    }

    if (existing._count.departments > 0) {
      set.status = 409;
      return {
        error: "Cannot delete faculty with linked departments",
        departments: existing._count.departments,
      };
    }

    await prisma.faculty.delete({ where: { id: identity.id } });
    return { message: "Faculty deleted" };
  }, {
    params: t.Object({ code: t.String() }),
  });
