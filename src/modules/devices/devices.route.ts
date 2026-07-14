import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { getMqttDeviceTopic, publishMqtt } from "../../lib/mqtt";
import { jwtPlugin, authGuard } from "../../middleware/auth";
import { assignDeviceToClass, setDeviceStandby } from "../classes/classes.service";

function mapDeviceBody(body: {
  device_id?: string;
  device_code?: string;
  status?: "ONLINE" | "OFFLINE" | "MAINTENANCE" | "ERROR";
  firmware_version?: string | null;
}) {
  const deviceCode = body.device_code ?? body.device_id;

  return {
    ...(body.device_code !== undefined ||
    body.device_id !== undefined
      ? { deviceId: deviceCode }
      : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.firmware_version !== undefined
      ? { firmwareVersion: body.firmware_version ?? null }
      : {}),
  };
}

async function findDeviceIdentity(deviceId: string) {
  return await prisma.device.findUnique({
    where: { deviceId },
    select: { id: true },
  });
}

type FirmwareUpdateCommandBody = {
  firmware_url: string;
  firmware_version?: string;
  checksum?: string | null;
  force?: boolean;
};

type FirmwareUpdateTargetBody = FirmwareUpdateCommandBody & {
  device_ids?: string[];
  class_codes?: string[];
  department_codes?: string[];
};

function normalizeDeviceIds(deviceIds: string[]) {
  return Array.from(
    new Set(
      deviceIds
        .map((deviceId) => deviceId.trim())
        .filter((deviceId) => deviceId.length > 0)
    )
  );
}

async function publishFirmwareUpdateCommand(
  deviceId: string,
  body: FirmwareUpdateCommandBody
) {
  const topic = getMqttDeviceTopic(deviceId, "command");
  const sentAt = new Date().toISOString();
  const payload = {
    command: "FIRMWARE_UPDATE",
    device_id: deviceId,
    firmware_url: body.firmware_url,
    firmware_version: body.firmware_version ?? undefined,
    checksum: body.checksum ?? undefined,
    force: body.force ?? false,
    sent_at: sentAt,
  };

  await publishMqtt(topic, payload);

  return {
    deviceId,
    topic,
    payload,
  };
}

async function resolveExistingDeviceIds(deviceIds: string[]) {
  const normalized = normalizeDeviceIds(deviceIds);
  if (normalized.length === 0) {
    return { valid: [] as string[], missing: [] as string[] };
  }

  const devices = await prisma.device.findMany({
    where: { deviceId: { in: normalized } },
    select: { deviceId: true },
  });

  const valid = devices.map((device) => device.deviceId);
  const validSet = new Set(valid);
  const missing = normalized.filter((deviceId) => !validSet.has(deviceId));

  return { valid, missing };
}

async function resolveTargetDeviceIds(body: FirmwareUpdateTargetBody) {
  const requestedDeviceIds = normalizeDeviceIds(body.device_ids ?? []);
  const requestedClassCodes = normalizeDeviceIds(body.class_codes ?? []);
  const requestedDepartmentCodes = normalizeDeviceIds(body.department_codes ?? []);

  const directDeviceIds = requestedDeviceIds;

  const classes = requestedClassCodes.length > 0
    ? await prisma.class.findMany({
        where: { code: { in: requestedClassCodes } },
        select: { code: true, deviceCode: true },
      })
    : [];

  const departmentClasses = requestedDepartmentCodes.length > 0
    ? await prisma.class.findMany({
        where: {
          departmentCode: { in: requestedDepartmentCodes },
          deviceCode: { not: null },
        },
        select: { code: true, deviceCode: true },
      })
    : [];

  const fromClasses = classes
    .map((item) => item.deviceCode)
    .filter((deviceId): deviceId is string => typeof deviceId === "string" && deviceId.length > 0);

  const fromDepartments = departmentClasses
    .map((item) => item.deviceCode)
    .filter((deviceId): deviceId is string => typeof deviceId === "string" && deviceId.length > 0);

  const requested = normalizeDeviceIds([
    ...directDeviceIds,
    ...fromClasses,
    ...fromDepartments,
  ]);

  const { valid, missing } = await resolveExistingDeviceIds(requested);

  return {
    requested,
    valid,
    missing,
    breakdown: {
      direct_device_ids: directDeviceIds,
      class_codes: requestedClassCodes,
      department_codes: requestedDepartmentCodes,
      class_device_ids: normalizeDeviceIds(fromClasses),
      department_device_ids: normalizeDeviceIds(fromDepartments),
    },
  };
}

export const deviceRoutes = new Elysia({ prefix: "/devices", tags: ["Devices"] })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async ({ query }) => {
    if (query.online) {
      const keys = await redis.keys("device:*:status");
      const onlineDeviceIds = keys.map((key) => key.split(":")[1]);
      return await prisma.device.findMany({
        where: { deviceId: { in: onlineDeviceIds } },
        orderBy: { createdAt: "desc" },
        include: {
          classes: {
            include: {
              department: true,
            },
          },
        },
      });
    }

    return await prisma.device.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        classes: {
          include: {
            department: true,
          },
        },
      },
    });
  }, {
    query: t.Object({
      online: t.Optional(t.Boolean()),
    }),
  })
  .get("/:device_code", async ({ params, set }) => {
    const device = await prisma.device.findUnique({
      where: { deviceId: params.device_code },
      include: {
        classes: {
          include: {
            department: true,
          },
        },
        schedules: { include: { course: true, lecturer: true } },
      },
    });
    if (!device) {
      set.status = 404;
      return { error: "Device not found" };
    }
    return device;
  }, {
    params: t.Object({ device_code: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const deviceId = body.device_id.trim();
    const classCode = body.class_code.trim();

    if (!deviceId) {
      set.status = 400;
      return { error: "device_id is required" };
    }

    if (!classCode) {
      set.status = 400;
      return { error: "class_code is required" };
    }

    await prisma.device.upsert({
      where: { deviceId },
      update: {},
      create: {
        deviceId,
        status: "OFFLINE",
      },
    });

    const assignment = await assignDeviceToClass(deviceId, classCode);

    if (!assignment.ok) {
      set.status = assignment.status;
      return { error: assignment.error };
    }

    set.status = 201;
    return assignment;
  }, {
    body: t.Object({
      device_id: t.String(),
      class_code: t.String(),
    }),
  })
  .put("/:device_code", async ({ params, body, set }) => {
    const existing = await findDeviceIdentity(params.device_code);
    if (!existing) {
      set.status = 404;
      return { error: "Device not found" };
    }
    const device = await prisma.device.update({
      where: { id: existing.id },
      data: mapDeviceBody(body),
      include: { classes: true },
    });
    return device;
  }, {
    params: t.Object({ device_code: t.String() }),
    body: t.Object({
      device_id: t.Optional(t.String()),
      device_code: t.Optional(t.String()),
      status: t.Optional(
        t.Union([
          t.Literal("ONLINE"),
          t.Literal("OFFLINE"),
          t.Literal("MAINTENANCE"),
          t.Literal("ERROR"),
        ])
      ),
      firmware_version: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .post("/firmware-updates", async ({ body, set }) => {
    const hasTargets =
      (body.device_ids?.length ?? 0) > 0 ||
      (body.class_codes?.length ?? 0) > 0 ||
      (body.department_codes?.length ?? 0) > 0;

    if (!hasTargets) {
      set.status = 400;
      return {
        error: "At least one target list is required",
      };
    }

    const { requested, valid, missing, breakdown } = await resolveTargetDeviceIds(body);

    if (valid.length === 0) {
      set.status = 404;
      return {
        error: "No matching devices found",
        missing_device_ids: missing,
        target_breakdown: breakdown,
      };
    }

    const published = [] as Array<{
      deviceId: string;
      topic: string;
      payload: Record<string, unknown>;
    }>;

    for (const deviceId of valid) {
      published.push(await publishFirmwareUpdateCommand(deviceId, body));
    }

    set.status = missing.length > 0 ? 207 : 201;
    return {
      message: "Firmware update command published",
      requested_device_ids: requested,
      published_device_ids: valid,
      missing_device_ids: missing,
      target_breakdown: breakdown,
      published,
    };
  }, {
    body: t.Object({
      device_ids: t.Optional(t.Array(t.String())),
      class_codes: t.Optional(t.Array(t.String())),
      department_codes: t.Optional(t.Array(t.String())),
      firmware_url: t.String(),
      firmware_version: t.Optional(t.String()),
      checksum: t.Optional(t.Union([t.String(), t.Null()])),
      force: t.Optional(t.Boolean()),
    }),
  })
  .post("/:device_code/commands", async ({ params, body, set }) => {
    if (body.type !== "STANDBY") {
      const result = await publishFirmwareUpdateCommand(params.device_code, {
        firmware_url: body.firmware_url,
        firmware_version: body.firmware_version,
        checksum: body.checksum,
        force: body.force,
      });

      set.status = 201;
      return {
        type: body.type,
        ...result,
      };
    }

    const result = await setDeviceStandby(params.device_code);

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return {
      ...result,
      type: body.type,
    };
  }, {
    params: t.Object({ device_code: t.String() }),
    body: t.Union([
      t.Object({
        type: t.Literal("STANDBY"),
      }),
      t.Object({
        type: t.Literal("FIRMWARE_UPDATE"),
        firmware_url: t.String(),
        firmware_version: t.Optional(t.String()),
        checksum: t.Optional(t.Union([t.String(), t.Null()])),
        force: t.Optional(t.Boolean()),
      }),
    ]),
  })
  .post("/:device_code/class-assignments", async ({ params, body, set }) => {
    const classCode = body.class_code;
    if (!classCode) {
      set.status = 400;
      return { error: "class_code is required" };
    }

    const result = await assignDeviceToClass(
      params.device_code,
      classCode,
      { exclusive: body.exclusive }
    );

    if (!result.ok) {
      set.status = result.status;
      return { error: result.error };
    }

    set.status = 201;
    return result;
  }, {
    params: t.Object({ device_code: t.String() }),
    body: t.Object({
      class_code: t.Optional(t.String()),
      exclusive: t.Optional(t.Boolean()),
    }),
  })
  .delete("/:device_code", async ({ params, set }) => {
    const identity = await findDeviceIdentity(params.device_code);

    if (!identity) {
      set.status = 404;
      return { error: "Device not found" };
    }

    const existing = await prisma.device.findUnique({
      where: { id: identity.id },
      include: { _count: { select: { schedules: true, attendances: true } } },
    });
    if (!existing) {
      set.status = 404;
      return { error: "Device not found" };
    }
    if (existing._count.schedules > 0 || existing._count.attendances > 0) {
      set.status = 409;
      return {
        error: "Cannot delete device with linked schedules or attendance records",
        schedules: existing._count.schedules,
        attendances: existing._count.attendances,
      };
    }
    await prisma.device.delete({ where: { id: identity.id } });
    return { message: "Device deleted" };
  }, {
    params: t.Object({ device_code: t.String() }),
  });
