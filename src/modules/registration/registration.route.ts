import { Elysia, t } from "elysia";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { startDeviceRegistration } from "./registration.service";

export const registrationRoutes = new Elysia({
  prefix: "/fingerprint-registrations",
  tags: ["Fingerprint Registrations"],
})
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .post("/", async ({ body, set }) => {
    const result = await startDeviceRegistration({
      deviceId: body.device_id,
      nim: body.nim,
      slot: body.slot,
      classCode: body.class_code,
    });

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return result;
  }, {
    body: t.Object({
      class_code: t.String(),
      nim: t.String(),
      device_id: t.Optional(t.String()),
      slot: t.Optional(t.Number({ minimum: 1, maximum: 3 })),
    }),
  });
