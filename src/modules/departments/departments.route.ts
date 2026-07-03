import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

function mapDepartmentBody(body: {
  code?: string;
  name?: string;
  faculty_code?: string | null;
}) {
  return {
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.faculty_code !== undefined
      ? { facultyId: body.faculty_code ?? null }
      : {}),
  };
}

async function findDepartmentIdentity(code: string) {
  return await prisma.department.findUnique({
    where: { code },
    select: { id: true },
  });
}

async function resolveFacultyIdentity(identifier: string) {
  return await prisma.faculty.findUnique({
    where: { code: identifier },
    select: { id: true },
  });
}

async function buildDepartmentData(body: {
  code?: string;
  name?: string;
  faculty_code?: string | null;
}) {
  const data = mapDepartmentBody(body);

  if ("facultyId" in data && data.facultyId !== null && data.facultyId !== undefined) {
    const faculty = await resolveFacultyIdentity(data.facultyId);

    if (!faculty) {
      return {
        ok: false as const,
        status: 404,
        error: "Faculty code not found",
      };
    }

    data.facultyId = faculty.id;
  }

  return { ok: true as const, data };
}

export const departmentRoutes = new Elysia({ prefix: "/departments", tags: ["Departments"] })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const departments = await prisma.department.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        faculty: true,
        _count: { select: { students: true, lecturers: true, courses: true, classes: true } },
      },
    });
    return departments;
  })
  .get("/:code", async ({ params, set }) => {
    const department = await prisma.department.findUnique({
      where: { code: params.code },
      include: {
        faculty: true,
        courses: { orderBy: { name: "asc" } },
        classes: { orderBy: { name: "asc" } },
        _count: { select: { students: true, lecturers: true, courses: true, classes: true } },
      },
    });
    if (!department) {
      set.status = 404;
      return { error: "Department not found" };
    }
    return department;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const result = await buildDepartmentData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    const department = await prisma.department.create({
      data: result.data as {
        code: string;
        name: string;
        facultyId?: string | null;
      },
      include: { faculty: true },
    });
    set.status = 201;
    return department;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
      faculty_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:code", async ({ params, body, set }) => {
    const existing = await findDepartmentIdentity(params.code);
    if (!existing) {
      set.status = 404;
      return { error: "Department not found" };
    }
    const result = await buildDepartmentData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    const department = await prisma.department.update({
      where: { id: existing.id },
      data: result.data,
      include: { faculty: true },
    });
    return department;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      faculty_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:code", async ({ params, set }) => {
    const identity = await findDepartmentIdentity(params.code);

    if (!identity) {
      set.status = 404;
      return { error: "Department not found" };
    }

    const existing = await prisma.department.findUnique({
      where: { id: identity.id },
      include: {
        _count: {
          select: { students: true, lecturers: true, courses: true, classes: true },
        },
      },
    });
    if (!existing) {
      set.status = 404;
      return { error: "Department not found" };
    }
    if (
      existing._count.students > 0 ||
      existing._count.lecturers > 0 ||
      existing._count.courses > 0 ||
      existing._count.classes > 0
    ) {
      set.status = 409;
      return {
        error: "Cannot delete department with linked students, lecturers, courses, or classes",
        students: existing._count.students,
        lecturers: existing._count.lecturers,
        courses: existing._count.courses,
        classes: existing._count.classes,
      };
    }
    await prisma.department.delete({ where: { id: identity.id } });
    return { message: "Department deleted" };
  }, {
    params: t.Object({ code: t.String() }),
  });
