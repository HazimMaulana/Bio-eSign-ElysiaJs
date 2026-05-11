import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { jwtPlugin, authGuard } from "../../middleware/auth";

function mapDeviceBody(body: {
  deviceId?: string;
  device_id?: string;
  deviceCode?: string;
  device_code?: string;
  status?: "ONLINE" | "OFFLINE" | "MAINTENANCE" | "ERROR";
  firmwareVersion?: string | null;
  firmware_version?: string | null;
}) {
  const deviceCode =
    body.deviceCode ?? body.device_code ?? body.deviceId ?? body.device_id;

  return {
    ...(body.deviceCode !== undefined ||
    body.device_code !== undefined ||
    body.deviceId !== undefined ||
    body.device_id !== undefined
      ? { deviceId: deviceCode }
      : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.firmwareVersion !== undefined || body.firmware_version !== undefined
      ? { firmwareVersion: body.firmwareVersion ?? body.firmware_version ?? null }
      : {}),
  };
}

async function findDeviceIdentity(deviceId: string) {
  return await prisma.device.findUnique({
    where: { deviceId },
    select: { id: true },
  });
}

export const deviceRoutes = new Elysia({ prefix: "/devices" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
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
  })
  .get("/online", async () => {
    const keys = await redis.keys("device:*:status");
    const onlineDeviceIds: string[] = [];
    for (const key of keys) {
      const deviceId = key.split(":")[1];
      onlineDeviceIds.push(deviceId);
    }
    return { online: onlineDeviceIds, count: onlineDeviceIds.length };
  })
  .get("/:deviceCode", async ({ params, set }) => {
    const device = await prisma.device.findUnique({
      where: { deviceId: params.deviceCode },
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
    params: t.Object({ deviceCode: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const data = mapDeviceBody(body);

    if (!data.deviceId) {
      set.status = 400;
      return { error: "device_code is required" };
    }

    const device = await prisma.device.create({
      data: {
        ...data,
        deviceId: data.deviceId,
        status: body.status ?? "OFFLINE",
      },
      include: { classes: true },
    });
    set.status = 201;
    return device;
  }, {
    body: t.Object({
      deviceId: t.Optional(t.String()),
      device_id: t.Optional(t.String()),
      deviceCode: t.Optional(t.String()),
      device_code: t.Optional(t.String()),
      status: t.Optional(
        t.Union([
          t.Literal("ONLINE"),
          t.Literal("OFFLINE"),
          t.Literal("MAINTENANCE"),
          t.Literal("ERROR"),
        ])
      ),
      firmwareVersion: t.Optional(t.Union([t.String(), t.Null()])),
      firmware_version: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:deviceCode", async ({ params, body, set }) => {
    const existing = await findDeviceIdentity(params.deviceCode);
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
    params: t.Object({ deviceCode: t.String() }),
    body: t.Object({
      deviceId: t.Optional(t.String()),
      device_id: t.Optional(t.String()),
      deviceCode: t.Optional(t.String()),
      device_code: t.Optional(t.String()),
      status: t.Optional(
        t.Union([
          t.Literal("ONLINE"),
          t.Literal("OFFLINE"),
          t.Literal("MAINTENANCE"),
          t.Literal("ERROR"),
        ])
      ),
      firmwareVersion: t.Optional(t.Union([t.String(), t.Null()])),
      firmware_version: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:deviceCode", async ({ params, set }) => {
    const identity = await findDeviceIdentity(params.deviceCode);

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
    params: t.Object({ deviceCode: t.String() }),
  });
