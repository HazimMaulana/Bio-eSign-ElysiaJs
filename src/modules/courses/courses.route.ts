import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { changeActiveClassOnDevice } from "../classes/classes.service";

function mapCourseBody(body: {
  code?: string;
  name?: string;
  credits?: number | null;
  department_code?: string | null;
  class_code?: string | null;
}) {
  return {
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.credits !== undefined ? { credits: body.credits ?? null } : {}),
    ...(body.department_code !== undefined
      ? { departmentCode: body.department_code ?? null }
      : {}),
    ...(body.class_code !== undefined
      ? { classCode: body.class_code ?? null }
      : {}),
  };
}

function getCourseStudentNims(body: {
  nim?: string;
  nims?: string[];
  student_nims?: string[];
}) {
  return [
    ...(body.nim !== undefined ? [body.nim] : []),
    ...(body.nims ?? []),
    ...(body.student_nims ?? []),
  ];
}

function getOptionalCourseStudentNims(body: {
  student_nims?: string[];
}) {
  if (body.student_nims !== undefined) return body.student_nims;
  return undefined;
}

async function findCourseIdentity(code: string) {
  return await prisma.course.findUnique({
    where: { code },
    select: { id: true, code: true },
  });
}

async function getCourseEnrollmentResponse(courseId: string) {
  return await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: {
      id: true,
      code: true,
      name: true,
      enrollments: {
        orderBy: { createdAt: "asc" },
        include: {
          student: {
            select: {
              id: true,
              nim: true,
              name: true,
              email: true,
              isActive: true,
            },
          },
        },
      },
    },
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

async function validateCourseClassCode(data: { classCode?: string | null }) {
  if (
    !("classCode" in data) ||
    data.classCode === null ||
    data.classCode === undefined
  ) {
    return { ok: true as const, data };
  }

  const attendanceClass = await prisma.class.findUnique({
    where: { code: data.classCode },
    select: { code: true },
  });

  if (!attendanceClass) {
    return {
      ok: false as const,
      status: 404,
      error: "Class code not found",
    };
  }

  return { ok: true as const, data };
}

async function validateCourseRelations(data: {
  departmentCode?: string | null;
  classCode?: string | null;
}) {
  const departmentResult = await validateCourseDepartmentCode(data);
  if (!departmentResult.ok) return departmentResult;

  return await validateCourseClassCode(data);
}

async function validateCourseStudentNims(studentNims: string[] | undefined) {
  if (studentNims === undefined) {
    return { ok: true as const, students: undefined };
  }

  const normalizedNims = studentNims.map((nim) => nim.trim());
  if (normalizedNims.some((nim) => !nim)) {
    return {
      ok: false as const,
      status: 400,
      error: "student_nims must not contain empty values",
    };
  }

  const uniqueNims = Array.from(new Set(normalizedNims));
  if (uniqueNims.length === 0) {
    return { ok: true as const, students: [] };
  }

  const students = await prisma.student.findMany({
    where: { nim: { in: uniqueNims } },
    select: { id: true, nim: true },
  });
  const foundNims = new Set(students.map((student) => student.nim));
  const missingNims = uniqueNims.filter((nim) => !foundNims.has(nim));

  if (missingNims.length > 0) {
    return {
      ok: false as const,
      status: 404,
      error: "Student NIM not found",
      missingNims,
    };
  }

  return { ok: true as const, students };
}

async function activateCourseDevice(code: string) {
  const course = await prisma.course.findUnique({
    where: { code },
    include: {
      class: {
        include: {
          device: true,
        },
      },
      enrollments: {
        include: {
          student: {
            include: {
              fingerprints: {
                orderBy: { slot: "asc" },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!course) {
    return { ok: false as const, status: 404, error: "Course not found" };
  }

  if (!course.class) {
    return {
      ok: false as const,
      status: 400,
      error: "Course class is not set",
    };
  }

  if (!course.class.deviceCode) {
    return {
      ok: false as const,
      status: 400,
      error: "Class device is not set",
    };
  }

  const activation = await changeActiveClassOnDevice(
    course.class.code,
    course.class.deviceCode,
    course.enrollments.map((enrollment) => enrollment.student)
  );

  if (!activation.ok) return activation;

  return {
    ok: true as const,
    course: {
      id: course.id,
      code: course.code,
      name: course.name,
      class_code: course.class.code,
      class_name: course.class.name,
      device_code: course.class.deviceCode,
      student_nims: course.enrollments.map((enrollment) => enrollment.student.nim),
    },
    activation,
  };
}

export const courseRoutes = new Elysia({ prefix: "/courses", tags: ["Courses"] })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const courses = await prisma.course.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        department: { include: { faculty: true } },
        class: { include: { device: true } },
        courseClasses: {
          include: { lecturer: true, semester: true, device: true },
          orderBy: { createdAt: "desc" },
        },
        enrollments: {
          include: { student: true },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { schedules: true } },
      },
    });
    return courses;
  })
  .get("/:code/enrollments", async ({ params, set }) => {
    const identity = await findCourseIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course not found" };
    }

    return await getCourseEnrollmentResponse(identity.id);
  }, {
    params: t.Object({ code: t.String() }),
  })
  .post("/:code/enrollments", async ({ params, body, set }) => {
    const identity = await findCourseIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course not found" };
    }

    const studentNims = getCourseStudentNims(body);
    if (studentNims.length === 0) {
      set.status = 400;
      return { error: "nim or student_nims is required" };
    }

    const enrollmentResult = await validateCourseStudentNims(studentNims);
    if (!enrollmentResult.ok) {
      set.status = enrollmentResult.status;
      return {
        error: enrollmentResult.error,
        missingNims: "missingNims" in enrollmentResult ? enrollmentResult.missingNims : undefined,
      };
    }
    const students = enrollmentResult.students ?? [];

    await prisma.courseEnrollment.createMany({
      data: students.map((student) => ({
        courseId: identity.id,
        studentId: student.id,
      })),
      skipDuplicates: true,
    });

    set.status = 201;
    return await getCourseEnrollmentResponse(identity.id);
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      nim: t.Optional(t.String()),
      nims: t.Optional(t.Array(t.String())),
      student_nims: t.Optional(t.Array(t.String())),
    }),
  })
  .put("/:code/enrollments", async ({ params, body, set }) => {
    const identity = await findCourseIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course not found" };
    }

    const hasEnrollmentInput =
      body.nim !== undefined ||
      body.nims !== undefined ||
      body.student_nims !== undefined;
    if (!hasEnrollmentInput) {
      set.status = 400;
      return { error: "nim or student_nims is required" };
    }

    const enrollmentResult = await validateCourseStudentNims(getCourseStudentNims(body));
    if (!enrollmentResult.ok) {
      set.status = enrollmentResult.status;
      return {
        error: enrollmentResult.error,
        missingNims: "missingNims" in enrollmentResult ? enrollmentResult.missingNims : undefined,
      };
    }
    const students = enrollmentResult.students ?? [];

    await prisma.$transaction(async (tx) => {
      await tx.courseEnrollment.deleteMany({
        where: { courseId: identity.id },
      });

      if (students.length > 0) {
        await tx.courseEnrollment.createMany({
          data: students.map((student) => ({
            courseId: identity.id,
            studentId: student.id,
          })),
          skipDuplicates: true,
        });
      }
    });

    return await getCourseEnrollmentResponse(identity.id);
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      nim: t.Optional(t.String()),
      nims: t.Optional(t.Array(t.String())),
      student_nims: t.Optional(t.Array(t.String())),
    }),
  })
  .delete("/:code/enrollments/:nim", async ({ params, set }) => {
    const identity = await findCourseIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course not found" };
    }

    const student = await prisma.student.findUnique({
      where: { nim: params.nim },
      select: { id: true },
    });
    if (!student) {
      set.status = 404;
      return { error: "Student NIM not found" };
    }

    await prisma.courseEnrollment.deleteMany({
      where: {
        courseId: identity.id,
        studentId: student.id,
      },
    });

    return await getCourseEnrollmentResponse(identity.id);
  }, {
    params: t.Object({
      code: t.String(),
      nim: t.String(),
    }),
  })
  .get("/:code", async ({ params, set }) => {
    const course = await prisma.course.findUnique({
      where: { code: params.code },
      include: {
        department: { include: { faculty: true } },
        class: { include: { device: true } },
        courseClasses: {
          include: { lecturer: true, semester: true, device: true },
          orderBy: { createdAt: "desc" },
        },
        enrollments: {
          include: {
            student: {
              include: {
                fingerprints: {
                  orderBy: { slot: "asc" },
                },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        schedules: { include: { lecturer: true, device: true } },
      },
    });
    if (!course) {
      set.status = 404;
      return { error: "Course not found" };
    }
    return course;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const dataResult = await validateCourseRelations(mapCourseBody(body));
    if (!dataResult.ok) {
      set.status = dataResult.status;
      return { error: dataResult.error };
    }
    const enrollmentResult = await validateCourseStudentNims(
      getOptionalCourseStudentNims(body)
    );
    if (!enrollmentResult.ok) {
      set.status = enrollmentResult.status;
      return {
        error: enrollmentResult.error,
        missingNims: "missingNims" in enrollmentResult ? enrollmentResult.missingNims : undefined,
      };
    }

    const course = await prisma.$transaction(async (tx) => {
      const created = await tx.course.create({
        data: {
          ...dataResult.data,
          code: body.code,
          name: body.name,
        },
        select: { id: true },
      });

      if (enrollmentResult.students && enrollmentResult.students.length > 0) {
        await tx.courseEnrollment.createMany({
          data: enrollmentResult.students.map((student) => ({
            courseId: created.id,
            studentId: student.id,
          })),
          skipDuplicates: true,
        });
      }

      return await tx.course.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          department: { include: { faculty: true } },
          class: { include: { device: true } },
          courseClasses: {
            include: { lecturer: true, semester: true, device: true },
            orderBy: { createdAt: "desc" },
          },
          enrollments: {
            include: { student: true },
            orderBy: { createdAt: "asc" },
          },
        },
      });
    });
    set.status = 201;
    return course;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
      credits: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
      class_code: t.Optional(t.Union([t.String(), t.Null()])),
      student_nims: t.Optional(t.Array(t.String())),
    }),
  })
  .put("/:code", async ({ params, body, set }) => {
    const existing = await findCourseIdentity(params.code);
    if (!existing) {
      set.status = 404;
      return { error: "Course not found" };
    }
    const dataResult = await validateCourseRelations(mapCourseBody(body));
    if (!dataResult.ok) {
      set.status = dataResult.status;
      return { error: dataResult.error };
    }
    const enrollmentResult = await validateCourseStudentNims(
      getOptionalCourseStudentNims(body)
    );
    if (!enrollmentResult.ok) {
      set.status = enrollmentResult.status;
      return {
        error: enrollmentResult.error,
        missingNims: "missingNims" in enrollmentResult ? enrollmentResult.missingNims : undefined,
      };
    }

    const course = await prisma.$transaction(async (tx) => {
      await tx.course.update({
        where: { id: existing.id },
        data: dataResult.data,
      });

      if (enrollmentResult.students !== undefined) {
        await tx.courseEnrollment.deleteMany({
          where: { courseId: existing.id },
        });

        if (enrollmentResult.students.length > 0) {
          await tx.courseEnrollment.createMany({
            data: enrollmentResult.students.map((student) => ({
              courseId: existing.id,
              studentId: student.id,
            })),
            skipDuplicates: true,
          });
        }
      }

      return await tx.course.findUniqueOrThrow({
        where: { id: existing.id },
        include: {
          department: { include: { faculty: true } },
          class: { include: { device: true } },
          courseClasses: {
            include: { lecturer: true, semester: true, device: true },
            orderBy: { createdAt: "desc" },
          },
          enrollments: {
            include: { student: true },
            orderBy: { createdAt: "asc" },
          },
        },
      });
    });
    return course;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      credits: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
      class_code: t.Optional(t.Union([t.String(), t.Null()])),
      student_nims: t.Optional(t.Array(t.String())),
    }),
  })
  .delete("/:code", async ({ params, set }) => {
    const identity = await findCourseIdentity(params.code);

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
    params: t.Object({ code: t.String() }),
  })
  .post("/:code/activations", async ({ params, set }) => {
    const result = await activateCourseDevice(params.code);

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return result;
  }, {
    params: t.Object({ code: t.String() }),
  });
