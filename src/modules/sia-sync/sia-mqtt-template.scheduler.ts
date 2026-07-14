import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { syncStudentRosterToDevice } from "../classes/classes.service";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_LEAD_MINUTES = 10;

let schedulerStarted = false;
let syncRunning = false;

function getNumericSiaClassId(schedule: {
  classId: string | null;
  rawPayload: unknown;
}) {
  const raw = schedule.rawPayload && typeof schedule.rawPayload === "object"
    ? schedule.rawPayload as Record<string, unknown>
    : {};
  const candidates = [schedule.classId, raw.id_kelas, raw.class_id];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value > 0) return value;
  }

  return null;
}

async function getScheduleDeviceCode(classCode: string) {
  const attendanceClass = await prisma.class.findUnique({
    where: { code: classCode },
    select: { deviceCode: true },
  });
  if (attendanceClass?.deviceCode) return attendanceClass.deviceCode;

  const courseClass = await prisma.courseClass.findUnique({
    where: { code: classCode },
    select: { deviceCode: true },
  });
  return courseClass?.deviceCode ?? null;
}

async function getScheduleStudents(schedule: {
  classId: string | null;
  classCode: string;
  className: string;
  courseId: string;
  rawPayload: unknown;
}) {
  const siaClassId = getNumericSiaClassId(schedule);
  const rosterLinks = await prisma.siaClassStudent.findMany({
    where: siaClassId
      ? { siaClassId }
      : {
          kodeMk: schedule.courseId,
          OR: [
            { namaKelas: schedule.classCode },
            { namaKelas: schedule.className },
          ],
        },
    orderBy: { student: { nim: "asc" } },
    include: {
      student: {
        include: {
          fingerprints: { orderBy: { slot: "asc" } },
        },
      },
    },
  });

  if (rosterLinks.length > 0) {
    return rosterLinks.map((link) => link.student);
  }

  const localCourseClass = await prisma.courseClass.findFirst({
    where: {
      OR: [
        { code: schedule.classCode },
        {
          course: { code: schedule.courseId },
          name: schedule.className,
        },
      ],
    },
    include: {
      enrollments: {
        where: { status: "ACTIVE" },
        orderBy: { student: { nim: "asc" } },
        include: {
          student: {
            include: {
              fingerprints: { orderBy: { slot: "asc" } },
            },
          },
        },
      },
    },
  });

  return localCourseClass?.enrollments.map((item) => item.student) ?? [];
}

export async function runScheduledMqttTemplateSync(now = new Date()) {
  if (syncRunning) {
    return { skipped: true as const, reason: "sync_already_running" };
  }

  syncRunning = true;
  try {
    const leadMinutes = Math.max(
      0,
      Number(process.env.MQTT_SCHEDULE_LEAD_MINUTES ?? DEFAULT_LEAD_MINUTES)
    );
    const windowEndsAt = new Date(now.getTime() + leadMinutes * 60_000);
    const schedules = await prisma.siaScheduleClone.findMany({
      where: {
        startsAt: { lte: windowEndsAt },
        endsAt: { gt: now },
      },
      orderBy: { startsAt: "asc" },
    });

    const results: Array<Record<string, unknown>> = [];
    const claimedDevices = new Set<string>();

    for (const schedule of schedules) {
      const deviceCode = await getScheduleDeviceCode(schedule.classCode);
      if (!deviceCode) {
        results.push({
          schedule_id: schedule.sourceScheduleId,
          class_code: schedule.classCode,
          status: "skipped",
          reason: "class_has_no_device",
        });
        continue;
      }

      if (claimedDevices.has(deviceCode)) {
        results.push({
          schedule_id: schedule.sourceScheduleId,
          class_code: schedule.classCode,
          device_code: deviceCode,
          status: "skipped",
          reason: "device_already_claimed_by_earlier_schedule",
        });
        continue;
      }
      claimedDevices.add(deviceCode);

      const cacheKey = `scheduled_template_sync:${deviceCode}`;
      const alreadySyncedSchedule = await redis.get(cacheKey);
      if (alreadySyncedSchedule === schedule.sourceScheduleId) {
        results.push({
          schedule_id: schedule.sourceScheduleId,
          class_code: schedule.classCode,
          device_code: deviceCode,
          status: "unchanged",
        });
        continue;
      }

      const students = await getScheduleStudents(schedule);
      const sync = await syncStudentRosterToDevice({
        classCode: schedule.classCode,
        className: `${schedule.courseName} - ${schedule.className}`,
        departmentCode: schedule.departmentCode,
        deviceCode,
        students,
      });

      if (!sync.ok) {
        results.push({
          schedule_id: schedule.sourceScheduleId,
          class_code: schedule.classCode,
          device_code: deviceCode,
          status: "failed",
          reason: sync.error,
        });
        continue;
      }

      const ttlSeconds = Math.max(
        60,
        Math.ceil((schedule.endsAt.getTime() - now.getTime()) / 1000) + 3600
      );
      await redis.set(cacheKey, schedule.sourceScheduleId, "EX", ttlSeconds);
      results.push({
        schedule_id: schedule.sourceScheduleId,
        class_code: schedule.classCode,
        device_code: deviceCode,
        status: "synced",
        student_count: students.length,
        template_count: sync.templateCount,
        chunk_count: sync.chunkCount,
      });
    }

    return {
      skipped: false as const,
      checked_at: now.toISOString(),
      lead_minutes: leadMinutes,
      active_schedule_count: schedules.length,
      results,
    };
  } finally {
    syncRunning = false;
  }
}

export function startScheduledMqttTemplateSync() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  if ((process.env.MQTT_SCHEDULE_SYNC_ENABLED ?? "true").toLowerCase() === "false") {
    console.log("[MQTT] Scheduled template sync disabled");
    return;
  }

  const intervalMs = Math.max(
    5_000,
    Number(process.env.MQTT_SCHEDULE_SYNC_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  );
  const run = () => {
    void runScheduledMqttTemplateSync().then((result) => {
      if (!result.skipped && result.results.some((item) => item.status === "synced")) {
        console.log("[MQTT] Scheduled template sync completed", result.results);
      }
    }).catch((error) => {
      console.error("[MQTT] Scheduled template sync failed:", error);
    });
  };

  run();
  setInterval(run, intervalMs);
  console.log(`[MQTT] Scheduled template sync checks every ${intervalMs}ms`);
}
