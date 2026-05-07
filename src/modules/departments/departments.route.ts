import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

function mapDepartmentBody(body: {
  code?: string;
  name?: string;
  facultyId?: string | null;
  faculty_id?: string | null;
  facultyCode?: string | null;
  faculty_code?: string | null;
}) {
  const facultyCode =
    body.facultyCode ?? body.faculty_code ?? body.facultyId ?? body.faculty_id;

  return {
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.facultyCode !== undefined ||
    body.faculty_code !== undefined ||
    body.facultyId !== undefined ||
    body.faculty_id !== undefined
      ? { facultyId: facultyCode ?? null }
      : {}),
  };
}

async function findDepartmentIdentity(identifier: string) {
  return await prisma.department.findFirst({
    where: {
      OR: [{ id: identifier }, { code: identifier }],
    },
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
  facultyId?: string | null;
  faculty_id?: string | null;
  facultyCode?: string | null;
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

export const departmentRoutes = new Elysia({ prefix: "/departments" })
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
  .get("/:id", async ({ params, set }) => {
    const department = await prisma.department.findFirst({
      where: {
        OR: [{ id: params.id }, { code: params.id }],
      },
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
    params: t.Object({ id: t.String() }),
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
      facultyId: t.Optional(t.Union([t.String(), t.Null()])),
      faculty_id: t.Optional(t.Union([t.String(), t.Null()])),
      facultyCode: t.Optional(t.Union([t.String(), t.Null()])),
      faculty_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await findDepartmentIdentity(params.id);
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
    params: t.Object({ id: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      facultyId: t.Optional(t.Union([t.String(), t.Null()])),
      faculty_id: t.Optional(t.Union([t.String(), t.Null()])),
      facultyCode: t.Optional(t.Union([t.String(), t.Null()])),
      faculty_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const identity = await findDepartmentIdentity(params.id);

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
    params: t.Object({ id: t.String() }),
  });
