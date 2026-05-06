import { Elysia, t } from "elysia";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import {
  changeActiveClassOnDevice,
  getAttendanceClassByCode,
  listAttendanceClasses,
  setDeviceStandby,
  syncAttendanceClassToDevice,
} from "./classes.service";

export const classRoutes = new Elysia({ prefix: "/classes" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    return await listAttendanceClasses();
  })
  .get("/:code", async ({ params, set }) => {
    const attendanceClass = await getAttendanceClassByCode(params.code);
    if (!attendanceClass) {
      set.status = 404;
      return { error: "Class not found" };
    }

    return attendanceClass;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .post("/:code/sync-device", async ({ params, body, set }) => {
    const result = await syncAttendanceClassToDevice(params.code, body.deviceId, {
      chunkSize: body.chunkSize,
    });

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return result;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      deviceId: t.String(),
      chunkSize: t.Optional(t.Number({ minimum: 64 })),
    }),
  })
  .post("/:code/activate-device", async ({ params, body, set }) => {
    const result = await changeActiveClassOnDevice(params.code, body.deviceId);

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return result;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      deviceId: t.String(),
    }),
  })
  .post("/standby-device", async ({ body, set }) => {
    const result = await setDeviceStandby(body.deviceId);

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return result;
  }, {
    body: t.Object({
      deviceId: t.String(),
    }),
  });
