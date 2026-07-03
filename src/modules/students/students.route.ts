import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { decryptTemplateBytes } from "../../lib/crypto";
import { storeRegistrationTemplateFromBinary } from "../registration/registration.service";

function getDepartmentCode(body: {
  department_code?: string | null;
}) {
  return body.department_code;
}

async function findStudentIdentity(nim: string) {
  return await prisma.student.findUnique({
    where: { nim },
    select: { id: true },
  });
}

function formValueToString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function formValueToOptionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function buildStudentData(body: {
  nim?: string;
  name?: string;
  email?: string | null;
  is_active?: boolean;
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
    ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
  };

  if (body.department_code !== undefined) {
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

export const studentRoutes = new Elysia({ prefix: "/students", tags: ["Students"] })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const students = await prisma.student.findMany({
      orderBy: { createdAt: "desc" },
      include: { department: { include: { faculty: true } } },
    });
    return students;
  })
  .get("/:nim", async ({ params, set }) => {
    const student = await prisma.student.findUnique({
      where: { nim: params.nim },
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
    params: t.Object({ nim: t.String() }),
  })
  .get("/:nim/fingerprints/:slot/template", async ({ params, set }) => {
    const student = await prisma.student.findUnique({
      where: { nim: params.nim },
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
      nim: t.String(),
      slot: t.Numeric(),
    }),
  })
  .put("/:nim/fingerprints/:slot/template", async ({ params, body, set }) => {
    const form = body as Record<string, unknown>;
    const template = form.template;

    if (!(template instanceof File)) {
      set.status = 400;
      return { error: "template file is required" };
    }

    const student = await prisma.student.findUnique({
      where: { nim: params.nim },
      select: { name: true },
    });

    if (!student) {
      set.status = 404;
      return { error: "Student not found" };
    }

    const result = await storeRegistrationTemplateFromBinary({
      nim: params.nim,
      name: formValueToString(form.name ?? form.nama) || student.name,
      slot: params.slot,
      fingerprintId: formValueToOptionalNumber(
        form.fingerprint_id
      ),
      templateBytes: await template.arrayBuffer(),
      deviceId: formValueToString(form.device_id),
      classCode: formValueToString(form.class_code),
    });

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return result;
  }, {
    params: t.Object({
      nim: t.String(),
      slot: t.Numeric(),
    }),
    parse: "multipart/form-data",
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
        isActive: body.is_active ?? true,
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
      is_active: t.Optional(t.Boolean()),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:nim", async ({ params, body, set }) => {
    const existing = await findStudentIdentity(params.nim);
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
    params: t.Object({ nim: t.String() }),
    body: t.Object({
      nim: t.Optional(t.String()),
      name: t.Optional(t.String()),
      email: t.Optional(t.Union([t.String(), t.Null()])),
      is_active: t.Optional(t.Boolean()),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:nim", async ({ params, set }) => {
    const existing = await findStudentIdentity(params.nim);
    if (!existing) {
      set.status = 404;
      return { error: "Student not found" };
    }
    await prisma.student.delete({ where: { id: existing.id } });
    return { message: "Student deleted" };
  }, {
    params: t.Object({ nim: t.String() }),
  });
