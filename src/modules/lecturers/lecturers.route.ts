import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

function getDepartmentCode(body: {
  departmentId?: string | null;
  department_id?: string | null;
  departmentCode?: string | null;
  department_code?: string | null;
}) {
  return (
    body.departmentCode ??
    body.department_code ??
    body.departmentId ??
    body.department_id
  );
}

async function findLecturerIdentity(identifier: string) {
  return await prisma.lecturer.findFirst({
    where: {
      OR: [{ id: identifier }, { nidn: identifier }],
    },
    select: { id: true },
  });
}

async function buildLecturerData(body: {
  nidn?: string;
  name?: string;
  email?: string;
  departmentId?: string | null;
  department_id?: string | null;
  departmentCode?: string | null;
  department_code?: string | null;
}) {
  const data: {
    nidn?: string;
    name?: string;
    email?: string;
    departmentId?: string;
  } = {
    ...(body.nidn !== undefined ? { nidn: body.nidn } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
  };

  if (
    body.departmentCode !== undefined ||
    body.department_code !== undefined ||
    body.departmentId !== undefined ||
    body.department_id !== undefined
  ) {
    const departmentCode = getDepartmentCode(body);

    if (!departmentCode) {
      return {
        ok: false as const,
        status: 400,
        error: "department_code is required",
      };
    }

    const department = await prisma.department.findUnique({
      where: { code: departmentCode },
      select: { id: true },
    });

    if (!department) {
      return {
        ok: false as const,
        status: 404,
        error: "Department code not found",
      };
    }

    data.departmentId = department.id;
  }

  return { ok: true as const, data };
}

export const lecturerRoutes = new Elysia({ prefix: "/lecturers" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const lecturers = await prisma.lecturer.findMany({
      orderBy: { createdAt: "desc" },
      include: { department: { include: { faculty: true } } },
    });
    return lecturers;
  })
  .get("/:id", async ({ params, set }) => {
    const lecturer = await prisma.lecturer.findFirst({
      where: {
        OR: [{ id: params.id }, { nidn: params.id }],
      },
      include: {
        department: { include: { faculty: true } },
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
    const result = await buildLecturerData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }
    if (!result.data.departmentId) {
      set.status = 400;
      return { error: "department_code is required" };
    }

    const lecturer = await prisma.lecturer.create({
      data: {
        nidn: body.nidn,
        name: body.name,
        email: body.email,
        department: {
          connect: { id: result.data.departmentId },
        },
      },
      include: { department: { include: { faculty: true } } },
    });
    set.status = 201;
    return lecturer;
  }, {
    body: t.Object({
      nidn: t.String(),
      name: t.String(),
      email: t.String(),
      departmentId: t.Optional(t.String()),
      department_id: t.Optional(t.String()),
      departmentCode: t.Optional(t.String()),
      department_code: t.Optional(t.String()),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await findLecturerIdentity(params.id);
    if (!existing) {
      set.status = 404;
      return { error: "Lecturer not found" };
    }
    const result = await buildLecturerData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    const lecturer = await prisma.lecturer.update({
      where: { id: existing.id },
      data: result.data,
      include: { department: { include: { faculty: true } } },
    });
    return lecturer;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      nidn: t.Optional(t.String()),
      name: t.Optional(t.String()),
      email: t.Optional(t.String()),
      departmentId: t.Optional(t.String()),
      department_id: t.Optional(t.String()),
      departmentCode: t.Optional(t.String()),
      department_code: t.Optional(t.String()),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const identity = await findLecturerIdentity(params.id);
    if (!identity) {
      set.status = 404;
      return { error: "Lecturer not found" };
    }

    const existing = await prisma.lecturer.findUnique({
      where: { id: identity.id },
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
    await prisma.lecturer.delete({ where: { id: identity.id } });
    return { message: "Lecturer deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
