import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const attendanceRoutes = new Elysia({ prefix: "/attendance-events", tags: ["Attendance"] })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async ({ query }) => {
    return await prisma.attendanceEvent.findMany({
      take: query.limit ?? 10,
      orderBy: { eventTime: "desc" },
      include: { student: true, device: true },
    });
  }, {
    query: t.Object({
      limit: t.Optional(t.Number({ minimum: 1, maximum: 1000, default: 10 })),
    }),
  })
  .post("/", async ({ body, set }) => {
    const event = await prisma.attendanceEvent.create({
      data: {
        studentId: body.student_id,
        deviceId: body.device_id,
        scheduleId: body.schedule_id,
        action: body.action as "CHECK_IN" | "CHECK_OUT",
        matchScore: body.match_score,
      },
    });
    set.status = 201;
    return event;
  }, {
    body: t.Object({
      student_id: t.String(),
      device_id: t.String(),
      schedule_id: t.Optional(t.Union([t.String(), t.Null()])),
      action: t.Union([t.Literal("CHECK_IN"), t.Literal("CHECK_OUT")]),
      match_score: t.Optional(t.Number()),
    }),
  });
