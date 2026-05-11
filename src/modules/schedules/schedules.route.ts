import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { jwtPlugin, authGuard } from "../../middleware/auth";

async function resolveScheduleData(body: {
  courseCode?: string;
  course_code?: string;
  lecturerNidn?: string;
  lecturer_nidn?: string;
  deviceCode?: string;
  device_code?: string;
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  roomName?: string | null;
}) {
  const data: Record<string, unknown> = {};

  const courseCode = body.courseCode ?? body.course_code;
  if (courseCode !== undefined) {
    const course = await prisma.course.findUnique({
      where: { code: courseCode },
      select: { id: true },
    });
    if (!course) {
      return { ok: false as const, status: 404, error: "Course code not found" };
    }
    data.courseId = course.id;
  }

  const lecturerNidn = body.lecturerNidn ?? body.lecturer_nidn;
  if (lecturerNidn !== undefined) {
    const lecturer = await prisma.lecturer.findUnique({
      where: { nidn: lecturerNidn },
      select: { id: true },
    });
    if (!lecturer) {
      return { ok: false as const, status: 404, error: "Lecturer NIDN not found" };
    }
    data.lecturerId = lecturer.id;
  }

  const deviceCode = body.deviceCode ?? body.device_code;
  if (deviceCode !== undefined) {
    const device = await prisma.device.findUnique({
      where: { deviceId: deviceCode },
      select: { id: true },
    });
    if (!device) {
      return { ok: false as const, status: 404, error: "Device code not found" };
    }
    data.deviceId = device.id;
  }

  if (body.dayOfWeek !== undefined) data.dayOfWeek = body.dayOfWeek;
  if (body.startTime !== undefined) data.startTime = new Date(body.startTime);
  if (body.endTime !== undefined) data.endTime = new Date(body.endTime);
  if (body.roomName !== undefined) data.roomName = body.roomName;

  return { ok: true as const, data };
}

export const scheduleRoutes = new Elysia({ prefix: "/schedules" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    const schedules = await prisma.schedule.findMany({
      orderBy: { createdAt: "desc" },
      include: { course: true, lecturer: true, device: true },
    });
    return schedules;
  })
  .get("/:id", async ({ params, set }) => {
    const schedule = await prisma.schedule.findUnique({
      where: { id: params.id },
      include: { course: true, lecturer: true, device: true },
    });
    if (!schedule) {
      set.status = 404;
      return { error: "Schedule not found" };
    }
    return schedule;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const result = await resolveScheduleData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }
    if (!result.data.courseId || !result.data.lecturerId || !result.data.deviceId) {
      set.status = 400;
      return {
        error: "courseCode, lecturerNidn, and deviceCode are required",
      };
    }

    const schedule = await prisma.schedule.create({
      data: {
        ...result.data,
        courseId: result.data.courseId as string,
        lecturerId: result.data.lecturerId as string,
        deviceId: result.data.deviceId as string,
        dayOfWeek: body.dayOfWeek,
        startTime: new Date(body.startTime),
        endTime: new Date(body.endTime),
        roomName: body.roomName,
      },
      include: { course: true, lecturer: true, device: true },
    });
    set.status = 201;
    return schedule;
  }, {
    body: t.Object({
      courseCode: t.Optional(t.String()),
      course_code: t.Optional(t.String()),
      lecturerNidn: t.Optional(t.String()),
      lecturer_nidn: t.Optional(t.String()),
      deviceCode: t.Optional(t.String()),
      device_code: t.Optional(t.String()),
      dayOfWeek: t.Number({ minimum: 0, maximum: 6 }),
      startTime: t.String(),
      endTime: t.String(),
      roomName: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await prisma.schedule.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Schedule not found" };
    }
    const result = await resolveScheduleData(body);
    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    const schedule = await prisma.schedule.update({
      where: { id: params.id },
      data: result.data,
      include: { course: true, lecturer: true, device: true },
    });
    return schedule;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      courseCode: t.Optional(t.String()),
      course_code: t.Optional(t.String()),
      lecturerNidn: t.Optional(t.String()),
      lecturer_nidn: t.Optional(t.String()),
      deviceCode: t.Optional(t.String()),
      device_code: t.Optional(t.String()),
      dayOfWeek: t.Optional(t.Number({ minimum: 0, maximum: 6 })),
      startTime: t.Optional(t.String()),
      endTime: t.Optional(t.String()),
      roomName: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await prisma.schedule.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Schedule not found" };
    }
    await prisma.schedule.delete({ where: { id: params.id } });
    return { message: "Schedule deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/:id/activations", async ({ params, body, set }) => {
    const schedule = await prisma.schedule.findUnique({
      where: { id: params.id },
      include: { device: true },
    });

    if (!schedule) {
      set.status = 404;
      return { error: "Schedule not found" };
    }

    const deviceCode = body.deviceCode ?? body.device_code ?? schedule.device?.deviceId;
    if (!deviceCode) {
      set.status = 400;
      return { error: "deviceCode is required" };
    }

    await redis.set(
      `active_schedule:${deviceCode}`,
      params.id,
      "EX",
      14400
    );
    set.status = 201;
    return { message: "Schedule activation created", deviceCode, scheduleId: params.id };
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      deviceCode: t.Optional(t.String()),
      device_code: t.Optional(t.String()),
    }),
  });
