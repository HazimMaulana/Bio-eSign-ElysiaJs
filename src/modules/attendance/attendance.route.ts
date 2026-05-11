import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const attendanceRoutes = new Elysia({ prefix: "/attendance-events" })
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
        studentId: body.studentId,
        deviceId: body.deviceId,
        scheduleId: body.scheduleId,
        action: body.action as "CHECK_IN" | "CHECK_OUT",
        matchScore: body.matchScore,
      },
    });
    set.status = 201;
    return event;
  }, {
    body: t.Object({
      studentId: t.String(),
      deviceId: t.String(),
      scheduleId: t.Optional(t.Union([t.String(), t.Null()])),
      action: t.Union([t.Literal("CHECK_IN"), t.Literal("CHECK_OUT")]),
      matchScore: t.Optional(t.Number()),
    }),
  });
