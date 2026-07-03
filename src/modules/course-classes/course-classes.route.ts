import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { syncStudentRosterToDevice } from "../classes/classes.service";

const courseClassInclude = {
  course: { include: { department: { include: { faculty: true } } } },
  lecturer: true,
  semester: true,
  device: true,
  enrollments: {
    include: { student: true },
    orderBy: { createdAt: "asc" as const },
  },
};

function normalizeText(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getStudentNims(body: {
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

async function validateStudentNims(studentNims: string[]) {
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

async function findCourseClassIdentity(code: string) {
  return await prisma.courseClass.findUnique({
    where: { code },
    select: { id: true, code: true, courseId: true, deviceCode: true },
  });
}

async function getEnrollmentResponse(courseClassId: string) {
  return await prisma.courseClass.findUniqueOrThrow({
    where: { id: courseClassId },
    include: courseClassInclude,
  });
}

async function resolveCourseClassData(body: {
  code?: string;
  name?: string;
  course_code?: string;
  lecturer_nidn?: string | null;
  semester_code?: string | null;
  device_code?: string | null;
  day_of_week?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  room_name?: string | null;
  capacity?: number | null;
}, partial = false) {
  const data: Record<string, unknown> = {};

  if (!partial || body.code !== undefined) {
    const code = normalizeText(body.code);
    if (!code) {
      return { ok: false as const, status: 400, error: "code is required" };
    }
    data.code = code;
  }

  if (!partial || body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) {
      return { ok: false as const, status: 400, error: "name is required" };
    }
    data.name = name;
  }

  if (!partial || body.course_code !== undefined) {
    const courseCode = normalizeText(body.course_code);
    if (!courseCode) {
      return { ok: false as const, status: 400, error: "course_code is required" };
    }

    const course = await prisma.course.findUnique({
      where: { code: courseCode },
      select: { id: true },
    });

    if (!course) {
      return { ok: false as const, status: 404, error: "Course code not found" };
    }

    data.courseId = course.id;
  }

  if (body.lecturer_nidn !== undefined) {
    const lecturerNidn = normalizeText(body.lecturer_nidn);
    if (lecturerNidn === null) {
      data.lecturerId = null;
    } else {
      const lecturer = await prisma.lecturer.findUnique({
        where: { nidn: lecturerNidn },
        select: { id: true },
      });
      if (!lecturer) {
        return { ok: false as const, status: 404, error: "Lecturer NIDN not found" };
      }
      data.lecturerId = lecturer.id;
    }
  }

  if (body.semester_code !== undefined) {
    const semesterCode = normalizeText(body.semester_code);
    if (semesterCode === null) {
      data.semesterId = null;
    } else {
      const semester = await prisma.semester.findUnique({
        where: { code: semesterCode },
        select: { id: true },
      });
      if (!semester) {
        return { ok: false as const, status: 404, error: "Semester code not found" };
      }
      data.semesterId = semester.id;
    }
  }

  if (body.device_code !== undefined) {
    const deviceCode = normalizeText(body.device_code);
    if (deviceCode === null) {
      data.deviceCode = null;
    } else {
      const device = await prisma.device.findUnique({
        where: { deviceId: deviceCode },
        select: { deviceId: true },
      });
      if (!device) {
        return { ok: false as const, status: 404, error: "Device code not found" };
      }
      data.deviceCode = device.deviceId;
    }
  }

  if (body.day_of_week !== undefined) data.dayOfWeek = body.day_of_week;
  if (body.start_time !== undefined) {
    data.startTime = body.start_time === null ? null : new Date(body.start_time);
  }
  if (body.end_time !== undefined) {
    data.endTime = body.end_time === null ? null : new Date(body.end_time);
  }
  if (body.room_name !== undefined) data.roomName = normalizeText(body.room_name);
  if (body.capacity !== undefined) data.capacity = body.capacity;

  return { ok: true as const, data };
}

async function activateCourseClass(code: string, options: {
  meeting_number?: number;
  opened_by_lecturer_nidn?: string;
}) {
  const courseClass = await prisma.courseClass.findUnique({
    where: { code },
    include: {
      course: true,
      lecturer: true,
      semester: true,
      device: true,
      enrollments: {
        where: { status: "ACTIVE" },
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

  if (!courseClass) {
    return { ok: false as const, status: 404, error: "Course class not found" };
  }

  if (!courseClass.deviceCode) {
    return {
      ok: false as const,
      status: 400,
      error: "Course class device is not set",
    };
  }

  let openedByLecturerId: string | null = null;
  if (options.opened_by_lecturer_nidn) {
    const lecturer = await prisma.lecturer.findUnique({
      where: { nidn: options.opened_by_lecturer_nidn },
      select: { id: true },
    });

    if (!lecturer) {
      return { ok: false as const, status: 404, error: "Lecturer NIDN not found" };
    }

    openedByLecturerId = lecturer.id;
  }

  const session = await prisma.$transaction(async (tx) => {
    await tx.attendanceSession.updateMany({
      where: {
        status: "OPEN",
        courseClass: {
          deviceCode: courseClass.deviceCode,
        },
      },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
      },
    });

    return await tx.attendanceSession.create({
      data: {
        courseClassId: courseClass.id,
        openedByLecturerId,
        meetingNumber: options.meeting_number,
      },
    });
  });

  await redis.set(
    `active_attendance_session:${courseClass.deviceCode}`,
    session.id,
    "EX",
    14400
  );
  await redis.set(
    `active_course_class:${courseClass.deviceCode}`,
    courseClass.code,
    "EX",
    14400
  );

  const activation = await syncStudentRosterToDevice({
    classCode: courseClass.code,
    className: `${courseClass.course.name} - ${courseClass.name}`,
    departmentCode: courseClass.course.departmentCode,
    deviceCode: courseClass.deviceCode,
    students: courseClass.enrollments.map((enrollment) => enrollment.student),
  });

  if (!activation.ok) return activation;

  return {
    ok: true as const,
    session,
    course_class: {
      id: courseClass.id,
      code: courseClass.code,
      name: courseClass.name,
      course_code: courseClass.course.code,
      course_name: courseClass.course.name,
      semester_code: courseClass.semester?.code ?? null,
      lecturer_nidn: courseClass.lecturer?.nidn ?? null,
      device_code: courseClass.deviceCode,
      enrolled_students: courseClass.enrollments.length,
    },
    activation,
  };
}

export const courseClassRoutes = new Elysia({
  prefix: "/course-classes",
  tags: ["Course Classes"],
})
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    return await prisma.courseClass.findMany({
      orderBy: { createdAt: "desc" },
      include: courseClassInclude,
    });
  })
  .post("/", async ({ body, set }) => {
    const result = await resolveCourseClassData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    const courseClass = await prisma.courseClass.create({
      data: result.data as {
        code: string;
        name: string;
        courseId: string;
        lecturerId?: string | null;
        semesterId?: string | null;
        deviceCode?: string | null;
        dayOfWeek?: number | null;
        startTime?: Date | null;
        endTime?: Date | null;
        roomName?: string | null;
        capacity?: number | null;
      },
      include: courseClassInclude,
    });

    set.status = 201;
    return courseClass;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
      course_code: t.String(),
      lecturer_nidn: t.Optional(t.Union([t.String(), t.Null()])),
      semester_code: t.Optional(t.Union([t.String(), t.Null()])),
      device_code: t.Optional(t.Union([t.String(), t.Null()])),
      day_of_week: t.Optional(t.Union([t.Number({ minimum: 0, maximum: 6 }), t.Null()])),
      start_time: t.Optional(t.Union([t.String(), t.Null()])),
      end_time: t.Optional(t.Union([t.String(), t.Null()])),
      room_name: t.Optional(t.Union([t.String(), t.Null()])),
      capacity: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
    }),
  })
  .get("/:code", async ({ params, set }) => {
    const courseClass = await prisma.courseClass.findUnique({
      where: { code: params.code },
      include: courseClassInclude,
    });

    if (!courseClass) {
      set.status = 404;
      return { error: "Course class not found" };
    }

    return courseClass;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .put("/:code", async ({ params, body, set }) => {
    const existing = await findCourseClassIdentity(params.code);
    if (!existing) {
      set.status = 404;
      return { error: "Course class not found" };
    }

    const result = await resolveCourseClassData(body, true);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return await prisma.courseClass.update({
      where: { id: existing.id },
      data: result.data,
      include: courseClassInclude,
    });
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      course_code: t.Optional(t.String()),
      lecturer_nidn: t.Optional(t.Union([t.String(), t.Null()])),
      semester_code: t.Optional(t.Union([t.String(), t.Null()])),
      device_code: t.Optional(t.Union([t.String(), t.Null()])),
      day_of_week: t.Optional(t.Union([t.Number({ minimum: 0, maximum: 6 }), t.Null()])),
      start_time: t.Optional(t.Union([t.String(), t.Null()])),
      end_time: t.Optional(t.Union([t.String(), t.Null()])),
      room_name: t.Optional(t.Union([t.String(), t.Null()])),
      capacity: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
    }),
  })
  .delete("/:code", async ({ params, set }) => {
    const existing = await findCourseClassIdentity(params.code);
    if (!existing) {
      set.status = 404;
      return { error: "Course class not found" };
    }

    await prisma.courseClass.delete({ where: { id: existing.id } });
    return { message: "Course class deleted" };
  }, {
    params: t.Object({ code: t.String() }),
  })
  .get("/:code/enrollments", async ({ params, set }) => {
    const identity = await findCourseClassIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course class not found" };
    }

    return await getEnrollmentResponse(identity.id);
  }, {
    params: t.Object({ code: t.String() }),
  })
  .post("/:code/enrollments", async ({ params, body, set }) => {
    const identity = await findCourseClassIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course class not found" };
    }

    const studentNims = getStudentNims(body);
    if (studentNims.length === 0) {
      set.status = 400;
      return { error: "nim or student_nims is required" };
    }

    const validation = await validateStudentNims(studentNims);
    if (!validation.ok) {
      set.status = validation.status;
      return {
        error: validation.error,
        missingNims: "missingNims" in validation ? validation.missingNims : undefined,
      };
    }

    await prisma.courseEnrollment.createMany({
      data: validation.students.map((student) => ({
        courseId: identity.courseId,
        courseClassId: identity.id,
        studentId: student.id,
      })),
      skipDuplicates: true,
    });

    set.status = 201;
    return await getEnrollmentResponse(identity.id);
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      nim: t.Optional(t.String()),
      nims: t.Optional(t.Array(t.String())),
      student_nims: t.Optional(t.Array(t.String())),
    }),
  })
  .put("/:code/enrollments", async ({ params, body, set }) => {
    const identity = await findCourseClassIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course class not found" };
    }

    const studentNims = getStudentNims(body);
    if (studentNims.length === 0) {
      set.status = 400;
      return { error: "nim or student_nims is required" };
    }

    const validation = await validateStudentNims(studentNims);
    if (!validation.ok) {
      set.status = validation.status;
      return {
        error: validation.error,
        missingNims: "missingNims" in validation ? validation.missingNims : undefined,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.courseEnrollment.deleteMany({
        where: { courseClassId: identity.id },
      });

      if (validation.students.length > 0) {
        await tx.courseEnrollment.createMany({
          data: validation.students.map((student) => ({
            courseId: identity.courseId,
            courseClassId: identity.id,
            studentId: student.id,
          })),
          skipDuplicates: true,
        });
      }
    });

    return await getEnrollmentResponse(identity.id);
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      nim: t.Optional(t.String()),
      nims: t.Optional(t.Array(t.String())),
      student_nims: t.Optional(t.Array(t.String())),
    }),
  })
  .delete("/:code/enrollments/:nim", async ({ params, set }) => {
    const identity = await findCourseClassIdentity(params.code);
    if (!identity) {
      set.status = 404;
      return { error: "Course class not found" };
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
        courseClassId: identity.id,
        studentId: student.id,
      },
    });

    return await getEnrollmentResponse(identity.id);
  }, {
    params: t.Object({
      code: t.String(),
      nim: t.String(),
    }),
  })
  .post("/:code/activations", async ({ params, body, set }) => {
    const result = await activateCourseClass(params.code, body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return result;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      meeting_number: t.Optional(t.Number({ minimum: 1 })),
      opened_by_lecturer_nidn: t.Optional(t.String()),
    }),
  })
  .post("/:code/attendance-sessions/:session_id/close", async ({ params, set }) => {
    const courseClass = await prisma.courseClass.findUnique({
      where: { code: params.code },
      select: { id: true, deviceCode: true },
    });

    if (!courseClass) {
      set.status = 404;
      return { error: "Course class not found" };
    }

    const session = await prisma.attendanceSession.findFirst({
      where: {
        id: params.session_id,
        courseClassId: courseClass.id,
      },
    });

    if (!session) {
      set.status = 404;
      return { error: "Attendance session not found" };
    }

    const closed = await prisma.attendanceSession.update({
      where: { id: session.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
      },
    });

    if (courseClass.deviceCode) {
      const activeSessionId = await redis.get(
        `active_attendance_session:${courseClass.deviceCode}`
      );
      if (activeSessionId === session.id) {
        await redis.del(
          `active_attendance_session:${courseClass.deviceCode}`,
          `active_course_class:${courseClass.deviceCode}`
        );
      }
    }

    return closed;
  }, {
    params: t.Object({
      code: t.String(),
      session_id: t.String(),
    }),
  });
