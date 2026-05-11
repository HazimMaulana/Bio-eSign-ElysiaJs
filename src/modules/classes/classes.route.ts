import { Elysia, t } from "elysia";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import {
  createAttendanceClass,
  deleteAttendanceClass,
  getAttendanceClass,
  listAttendanceClasses,
  syncAttendanceClassToDevice,
  updateAttendanceClass,
} from "./classes.service";

function mapAttendanceClassBody(body: {
  code?: string;
  name?: string;
  departmentCode?: string | null;
  department_code?: string | null;
  deviceCode?: string | null;
  device_code?: string | null;
}) {
  return {
    ...(body.code !== undefined ? { code: body.code } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.departmentCode !== undefined || body.department_code !== undefined
      ? {
          departmentCode:
            body.departmentCode ??
            body.department_code ??
            null,
        }
      : {}),
    ...(body.deviceCode !== undefined || body.device_code !== undefined
      ? { deviceCode: body.deviceCode ?? body.device_code ?? null }
      : {}),
  };
}

export const classRoutes = new Elysia({ prefix: "/classes" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    return await listAttendanceClasses();
  })
  .post("/", async ({ body, set }) => {
    const result = await createAttendanceClass(mapAttendanceClassBody(body) as {
      code: string;
      name: string;
    });

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return result.attendanceClass;
  }, {
    body: t.Object({
      code: t.String(),
      name: t.String(),
      departmentCode: t.Optional(t.Union([t.String(), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
      deviceCode: t.Optional(t.Union([t.String(), t.Null()])),
      device_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .get("/:code", async ({ params, set }) => {
    const attendanceClass = await getAttendanceClass(params.code);
    if (!attendanceClass) {
      set.status = 404;
      return { error: "Class not found" };
    }

    return attendanceClass;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .put("/:code", async ({ params, body, set }) => {
    const result = await updateAttendanceClass(params.code, mapAttendanceClassBody(body));

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return result.attendanceClass;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      code: t.Optional(t.String()),
      name: t.Optional(t.String()),
      departmentCode: t.Optional(t.Union([t.String(), t.Null()])),
      department_code: t.Optional(t.Union([t.String(), t.Null()])),
      deviceCode: t.Optional(t.Union([t.String(), t.Null()])),
      device_code: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:code", async ({ params, set }) => {
    const result = await deleteAttendanceClass(params.code);

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return result;
  }, {
    params: t.Object({ code: t.String() }),
  })
  .post("/:code/device-synchronizations", async ({ params, body, set }) => {
    const result = await syncAttendanceClassToDevice(params.code, body.deviceCode ?? body.device_code, {
      chunkSize: body.chunkSize,
    });

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return result;
  }, {
    params: t.Object({ code: t.String() }),
    body: t.Object({
      deviceCode: t.Optional(t.String()),
      device_code: t.Optional(t.String()),
      chunkSize: t.Optional(t.Number({ minimum: 64 })),
    }),
  });
