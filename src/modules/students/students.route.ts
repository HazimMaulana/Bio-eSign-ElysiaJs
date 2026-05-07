import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { decryptTemplateBytes } from "../../lib/crypto";

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

async function findStudentIdentity(identifier: string) {
  return await prisma.student.findFirst({
    where: {
      OR: [{ id: identifier }, { nim: identifier }],
    },
    select: { id: true },
  });
}

async function buildStudentData(body: {
  nim?: string;
  name?: string;
  email?: string | null;
  isActive?: boolean;
  departmentId?: string | null;
  department_id?: string | null;
  departmentCode?: string | null;
  department_code?: string | null;
}) {
  const data: {
    nim?: string;
    name?: string;
    email?: string | null;
    isActive?: boolean;
    departmentId?: string | null;
  } = {
    ...(body.nim !== undefined ? { nim: body.nim } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
  };

  if (
    body.departmentCode !== undefined ||
    body.department_code !== undefined ||
    body.departmentId !== undefined ||
    body.department_id !== undefined
  ) {
    const departmentCode = getDepartmentCode(body);

    if (departmentCode === null || departmentCode === undefined) {
      data.departmentId = null;
    } else {
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
  }

  return { ok: true as const, data };
}

export const studentRoutes = new Elysia({ prefix: "/students" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const students = await prisma.student.findMany({
      orderBy: { createdAt: "desc" },
      include: { department: { include: { faculty: true } } },
    });
    return students;
  })
  .get("/:id", async ({ params, set }) => {
    const student = await prisma.student.findFirst({
      where: {
        OR: [{ id: params.id }, { nim: params.id }],
      },
      include: {
        department: { include: { faculty: true } },
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
  .get("/:id/fingerprints/:slot/template", async ({ params, set }) => {
    const student = await prisma.student.findFirst({
      where: { 
        OR: [
          { id: params.id },
          { nim: params.id }
        ] 
      }
    });

    if (!student) {
      set.status = 404;
      return { error: "Student not found" };
    }

    const fingerprint = await prisma.studentFingerprint.findUnique({
      where: {
        studentId_slot: {
          studentId: student.id,
          slot: params.slot,
        },
      },
    });

    if (!fingerprint || !fingerprint.templateEncBytes) {
      set.status = 404;
      return { error: "Fingerprint template binary not found for this slot" };
    }

    const decryptedBytes = await decryptTemplateBytes(
      fingerprint.templateEncBytes,
      fingerprint.encryptionIv,
      fingerprint.encryptionTag
    );

    // Mengembalikan langsung bentuk Raw Binary (Buffer) untuk dirender/diunduh postman
    set.headers["Content-Type"] = "application/octet-stream";
    return decryptedBytes;
  }, {
    params: t.Object({
      id: t.String(),
      slot: t.Numeric(),
    }),
  })
  .post("/", async ({ body, set }) => {
    const result = await buildStudentData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    const student = await prisma.student.create({
      data: {
        ...result.data,
        nim: body.nim,
        name: body.name,
        isActive: body.isActive ?? true,
      },
      include: { department: { include: { faculty: true } } },
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
      department_id: t.Optional(t.Union([t.String(), t.Null()])),
      departmentCode: t.Optional(t.Union([t.String(), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await findStudentIdentity(params.id);
    if (!existing) {
      set.status = 404;
      return { error: "Student not found" };
    }
    const result = await buildStudentData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    const student = await prisma.student.update({
      where: { id: existing.id },
      data: result.data,
      include: { department: { include: { faculty: true } } },
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
      department_id: t.Optional(t.Union([t.String(), t.Null()])),
      departmentCode: t.Optional(t.Union([t.String(), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await findStudentIdentity(params.id);
    if (!existing) {
      set.status = 404;
      return { error: "Student not found" };
    }
    await prisma.student.delete({ where: { id: existing.id } });
    return { message: "Student deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
