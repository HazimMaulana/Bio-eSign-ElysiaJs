import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

function mapCourseBody(body: {
  code?: string;
  name?: string;
  departmentCode?: string | null;
  department_code?: string | null;
}) {
  return {
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.departmentCode !== undefined ||
    body.department_code !== undefined
      ? { departmentCode: body.departmentCode ?? body.department_code ?? null }
      : {}),
  };
}

async function findCourseIdentity(identifier: string) {
  return await prisma.course.findFirst({
    where: {
      OR: [{ id: identifier }, { code: identifier }],
    },
    select: { id: true },
  });
}

async function validateCourseDepartmentCode(data: { departmentCode?: string | null }) {
  if (
    !("departmentCode" in data) ||
    data.departmentCode === null ||
    data.departmentCode === undefined
  ) {
    return { ok: true as const, data };
  }

  const department = await prisma.department.findUnique({
    where: { code: data.departmentCode },
    select: { code: true },
  });

  if (!department) {
    return {
      ok: false as const,
      status: 404,
      error: "Department code not found",
    };
  }

  return { ok: true as const, data };
}

export const courseRoutes = new Elysia({ prefix: "/courses" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const courses = await prisma.course.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        department: { include: { faculty: true } },
        _count: { select: { schedules: true } },
      },
    });
    return courses;
  })
  .get("/:id", async ({ params, set }) => {
    const course = await prisma.course.findFirst({
      where: {
        OR: [{ id: params.id }, { code: params.id }],
      },
      include: {
        department: { include: { faculty: true } },
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
    const dataResult = await validateCourseDepartmentCode(mapCourseBody(body));
    if (!dataResult.ok) {
      set.status = dataResult.status;
      return { error: dataResult.error };
    }

    const course = await prisma.course.create({
      data: {
        ...dataResult.data,
        code: body.code,
        name: body.name,
      },
      include: { department: { include: { faculty: true } } },
    });
    set.status = 201;
    return course;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
      departmentCode: t.Optional(t.Union([t.String(), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await findCourseIdentity(params.id);
    if (!existing) {
      set.status = 404;
      return { error: "Course not found" };
    }
    const dataResult = await validateCourseDepartmentCode(mapCourseBody(body));
    if (!dataResult.ok) {
      set.status = dataResult.status;
      return { error: dataResult.error };
    }

    const course = await prisma.course.update({
      where: { id: existing.id },
      data: dataResult.data,
      include: { department: { include: { faculty: true } } },
    });
    return course;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      departmentCode: t.Optional(t.Union([t.String(), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const identity = await findCourseIdentity(params.id);

    if (!identity) {
      set.status = 404;
      return { error: "Course not found" };
    }

    const existing = await prisma.course.findUnique({
      where: { id: identity.id },
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
    await prisma.course.delete({ where: { id: identity.id } });
    return { message: "Course deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
