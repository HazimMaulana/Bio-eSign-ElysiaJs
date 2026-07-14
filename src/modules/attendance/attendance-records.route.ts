import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const attendanceRecordRoutes = new Elysia({
  prefix: "/attendance-records",
  tags: ["Attendance"],
})
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/dashboard", async ({ query }) => {
    const from = query.from ? new Date(query.from) : new Date();
    if (!query.from) from.setHours(0, 0, 0, 0);
    const to = query.to ? new Date(query.to) : new Date();

    const dateFilter = { gte: from, lte: to };
    const [totalRecords, uniqueStudents, statusCounts, activeSessions, recentRecords, recentEvents] =
      await Promise.all([
        prisma.attendanceRecord.count({ where: { checkedAt: dateFilter } }),
        prisma.attendanceRecord.findMany({
          where: { checkedAt: dateFilter },
          distinct: ["studentId"],
          select: { studentId: true },
        }),
        prisma.attendanceRecord.groupBy({
          by: ["status"],
          where: { checkedAt: dateFilter },
          _count: { _all: true },
        }),
        prisma.attendanceSession.count({ where: { status: "OPEN" } }),
        prisma.attendanceRecord.findMany({
          take: query.limit ?? 20,
          where: { checkedAt: dateFilter },
          orderBy: { checkedAt: "desc" },
          include: {
            student: { select: { nim: true, name: true } },
            attendanceSession: {
              include: {
                courseClass: {
                  include: { course: true, device: true },
                },
              },
            },
          },
        }),
        prisma.attendanceEvent.findMany({
          take: query.limit ?? 20,
          where: { eventTime: dateFilter },
          orderBy: { eventTime: "desc" },
          include: {
            student: { select: { nim: true, name: true } },
            device: { select: { deviceId: true, status: true } },
          },
        }),
      ]);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        total_records: totalRecords,
        unique_students: uniqueStudents.length,
        active_sessions: activeSessions,
        by_status: Object.fromEntries(
          statusCounts.map((item) => [item.status, item._count._all])
        ),
      },
      recent_records: recentRecords,
      recent_events: recentEvents.map((event) => ({
        ...event,
        id: event.id.toString(),
      })),
    };
  }, {
    query: t.Object({
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 })),
    }),
    detail: {
      summary: "Dashboard ringkas dan log aktivitas presensi",
    },
  })
  .get("/", async ({ query }) => {
    return await prisma.attendanceRecord.findMany({
      take: query.limit ?? 50,
      where: {
        ...(query.course_class_code
          ? {
              attendanceSession: {
                courseClass: {
                  code: query.course_class_code,
                },
              },
            }
          : {}),
        ...(query.session_id
          ? { attendanceSessionId: query.session_id }
          : {}),
        ...(query.nim
          ? {
              student: {
                nim: query.nim,
              },
            }
          : {}),
      },
      orderBy: { checkedAt: "desc" },
      include: {
        student: true,
        attendanceSession: {
          include: {
            courseClass: {
              include: { course: true, semester: true, lecturer: true },
            },
          },
        },
      },
    });
  }, {
    query: t.Object({
      limit: t.Optional(t.Number({ minimum: 1, maximum: 1000, default: 50 })),
      course_class_code: t.Optional(t.String()),
      session_id: t.Optional(t.String()),
      nim: t.Optional(t.String()),
    }),
  });
