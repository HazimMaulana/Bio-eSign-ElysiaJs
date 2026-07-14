import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { pushAttendanceRecordToSia } from "./sia-attendance-push.service";
import { syncSiaSchedules } from "./sia-sync.service";
import { runScheduledMqttTemplateSync } from "./sia-mqtt-template.scheduler";

export const siaSyncRoutes = new Elysia({ prefix: "/sia", tags: ["SIA Sync"] })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/schedules", async ({ query }) => {
    const schedules = await prisma.siaScheduleClone.findMany({
      where: {
        ...(query.date ? { scheduledDate: new Date(`${query.date}T00:00:00`) } : {}),
        ...(query.department_code ? { departmentCode: query.department_code } : {}),
        ...(query.class_code ? { classCode: query.class_code } : {}),
      },
      orderBy: [{ scheduledDate: "asc" }, { startsAt: "asc" }],
    });

    return schedules;
  }, {
    query: t.Object({
      date: t.Optional(t.String()),
      department_code: t.Optional(t.String()),
      class_code: t.Optional(t.String()),
    }),
  })
  .post("/sync", async ({ body }) => {
    return await syncSiaSchedules({ forceDummy: body?.force_dummy });
  }, {
    body: t.Optional(t.Object({
      force_dummy: t.Optional(t.Boolean()),
    })),
    detail: {
      summary: "Trigger manual sync jadwal dari SIA ke tabel clone",
    },
  })
  .post("/mqtt-template-sync", async () => {
    return await runScheduledMqttTemplateSync();
  }, {
    detail: {
      summary: "Trigger pengiriman roster dan template MQTT untuk jadwal SIA aktif",
    },
  })
  .post("/attendance-records/:id/push", async ({ params, set }) => {
    const result = await pushAttendanceRecordToSia(params.id);

    if (!result.ok) {
      set.status = result.httpStatus ?? 502;
      return result;
    }

    if (result.skipped) {
      set.status = 202;
    }

    return result;
  }, {
    params: t.Object({
      id: t.String(),
    }),
    detail: {
      summary: "Test push satu attendance record ke API SIA",
    },
  });
