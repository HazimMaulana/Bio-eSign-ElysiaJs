import { Elysia, t } from "elysia";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import {
  startDeviceRegistration,
  storeRegistrationTemplateFromBinary,
} from "./registration.service";

function formValueToString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function formValueToNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

function formValueToOptionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = formValueToNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const registrationRoutes = new Elysia({ prefix: "/register" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .post("/start", async ({ body, set }) => {
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
  })
  .post("/template", async ({ body, set }) => {
    const form = body as Record<string, unknown>;
    const template = form.template;

    if (!(template instanceof File)) {
      set.status = 400;
      return { error: "template file is required" };
    }

    const result = await storeRegistrationTemplateFromBinary({
      nim: formValueToString(form.nim),
      name: formValueToString(form.name ?? form.nama),
      slot: formValueToNumber(form.slot),
      fingerprintId: formValueToOptionalNumber(
        form.fingerprintId ?? form.fingerprint_id ?? form.finger_id
      ),
      templateBytes: await template.arrayBuffer(),
      deviceId: formValueToString(form.deviceId ?? form.device_id),
      classCode: formValueToString(form.classCode ?? form.class_code),
    });

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    return result;
  }, {
    parse: "multipart/form-data",
  });
