import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { jwtPlugin, authGuard } from "../../middleware/auth";

export const deviceRoutes = new Elysia({ prefix: "/devices" })
  .use(jwtPlugin)
  .onBeforeHandle(authGuard)
  .get("/", async () => {
    return await prisma.device.findMany({
      orderBy: { createdAt: "desc" },
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
  .get("/:id", async ({ params, set }) => {
    const device = await prisma.device.findUnique({
      where: { id: params.id },
      include: {
        schedules: { include: { course: true, lecturer: true } },
      },
    });
    if (!device) {
      set.status = 404;
      return { error: "Device not found" };
    }
    return device;
  }, {
    params: t.Object({ id: t.String() }),
  })
  .post("/", async ({ body, set }) => {
    const device = await prisma.device.create({
      data: {
        deviceId: body.deviceId,
        locationName: body.locationName,
        status: body.status ?? "OFFLINE",
        firmwareVersion: body.firmwareVersion,
      },
    });
    set.status = 201;
    return device;
  }, {
    body: t.Object({
      deviceId: t.String(),
      locationName: t.Optional(t.Union([t.String(), t.Null()])),
      status: t.Optional(
        t.Union([
          t.Literal("ONLINE"),
          t.Literal("OFFLINE"),
          t.Literal("MAINTENANCE"),
          t.Literal("ERROR"),
        ])
      ),
      firmwareVersion: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .put("/:id", async ({ params, body, set }) => {
    const existing = await prisma.device.findUnique({ where: { id: params.id } });
    if (!existing) {
      set.status = 404;
      return { error: "Device not found" };
    }
    const device = await prisma.device.update({
      where: { id: params.id },
      data: body,
    });
    return device;
  }, {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      locationName: t.Optional(t.Union([t.String(), t.Null()])),
      status: t.Optional(
        t.Union([
          t.Literal("ONLINE"),
          t.Literal("OFFLINE"),
          t.Literal("MAINTENANCE"),
          t.Literal("ERROR"),
        ])
      ),
      firmwareVersion: t.Optional(t.Union([t.String(), t.Null()])),
    }),
  })
  .delete("/:id", async ({ params, set }) => {
    const existing = await prisma.device.findUnique({
      where: { id: params.id },
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
    await prisma.device.delete({ where: { id: params.id } });
    return { message: "Device deleted" };
  }, {
    params: t.Object({ id: t.String() }),
  });
