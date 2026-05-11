import { Elysia, t } from "elysia";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { startDeviceRegistration } from "./registration.service";

export const registrationRoutes = new Elysia({ prefix: "/fingerprint-registrations" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .post("/", async ({ body, set }) => {
    const result = await startDeviceRegistration({
      deviceId: body.deviceId,
      nim: body.nim,
      name: body.name ?? body.nama ?? "",
      slot: body.slot,
      classCode: body.classCode ?? body.class_code,
    });

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return result;
  }, {
    body: t.Object({
      deviceId: t.String(),
      nim: t.String(),
      name: t.Optional(t.String()),
      nama: t.Optional(t.String()),
      slot: t.Optional(t.Number({ minimum: 1, maximum: 3 })),
      classCode: t.Optional(t.String()),
      class_code: t.Optional(t.String()),
    }),
  });
