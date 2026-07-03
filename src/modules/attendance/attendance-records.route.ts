import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const attendanceRecordRoutes = new Elysia({
  prefix: "/attendance-records",
  tags: ["Attendance"],
})
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
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
