import { Elysia, t } from "elysia";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { jwtPlugin, authGuard } from "../middleware/auth";

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
    const schedule = await prisma.schedule.create({
      data: {
        courseId: body.courseId,
        lecturerId: body.lecturerId,
        deviceId: body.deviceId,
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
      courseId: t.String(),
      lecturerId: t.String(),
      deviceId: t.String(),
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
    const data: Record<string, unknown> = {};
    if (body.courseId !== undefined) data.courseId = body.courseId;
    if (body.lecturerId !== undefined) data.lecturerId = body.lecturerId;
    if (body.deviceId !== undefined) data.deviceId = body.deviceId;
    if (body.dayOfWeek !== undefined) data.dayOfWeek = body.dayOfWeek;
    if (body.startTime !== undefined) data.startTime = new Date(body.startTime);
    if (body.endTime !== undefined) data.endTime = new Date(body.endTime);
    if (body.roomName !== undefined) data.roomName = body.roomName;
    const schedule = await prisma.schedule.update({
      where: { id: params.id },
      data,
      include: { course: true, lecturer: true, device: true },
    });
    return schedule;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      courseId: t.Optional(t.String()),
      lecturerId: t.Optional(t.String()),
      deviceId: t.Optional(t.String()),
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
  .post("/activate", async ({ body }) => {
    await redis.set(
      `active_schedule:${body.deviceId}`,
      body.scheduleId,
      "EX",
      14400
    );
    return { message: "Schedule activated", deviceId: body.deviceId, scheduleId: body.scheduleId };
  }, {
    body: t.Object({
      deviceId: t.String(),
      scheduleId: t.String(),
    }),
  });
