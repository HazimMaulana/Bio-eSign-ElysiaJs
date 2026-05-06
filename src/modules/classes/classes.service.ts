import { prisma } from "../../lib/prisma";
import { decryptTemplate } from "../../lib/crypto";
import { getMqttServerTopic, publishMqtt } from "../../lib/mqtt";
import { redis } from "../../lib/redis";

const DEFAULT_CHUNK_SIZE = Math.max(
  64,
  Number(process.env.MQTT_TEMPLATE_CHUNK_SIZE ?? 512)
);
const DEVICE_TOPIC_PREFIX = process.env.MQTT_DEVICE_TOPIC_PREFIX ?? "presence";
const DEVICE_TOPICS = {
  catalog: `${DEVICE_TOPIC_PREFIX}/mahasiswa/catalog`,
  templateManifest: `${DEVICE_TOPIC_PREFIX}/mahasiswa/templates/manifest`,
  templateChunk: `${DEVICE_TOPIC_PREFIX}/mahasiswa/templates/chunk`,
} as const;
const DEFAULT_ACTIVE_CLASS_CODE = process.env.MQTT_DEFAULT_CLASS_CODE ?? "A";
const activeClassByDevice = new Map<string, string>();

function chunkTemplate(template: string, chunkSize: number) {
  const chunks: string[] = [];
  for (let i = 0; i < template.length; i += chunkSize) {
    chunks.push(template.slice(i, i + chunkSize));
  }
  return chunks;
}

function getKampusCommandTopic(deviceId: string) {
  return `${DEVICE_TOPIC_PREFIX}/device/${deviceId}/command`;
}

async function resolveActiveClassCodeForDevice(
  deviceId: string,
  requestedClassCode?: string
) {
  if (requestedClassCode) return requestedClassCode;

  const inMemoryClassCode = activeClassByDevice.get(deviceId);
  if (inMemoryClassCode) return inMemoryClassCode;

  const cachedClassCode = await redis.get(`active_class:${deviceId}`);
  return cachedClassCode ?? DEFAULT_ACTIVE_CLASS_CODE;
}

export async function listAttendanceClasses() {
  return await prisma.attendanceClass.findMany({
    orderBy: { code: "asc" },
    include: {
      _count: {
        select: { students: true },
      },
    },
  });
}

export async function getAttendanceClassByCode(code: string) {
  return await prisma.attendanceClass.findUnique({
    where: { code },
    include: {
      students: {
        orderBy: { student: { nim: "asc" } },
        include: {
          student: {
            include: {
              fingerprints: {
                orderBy: { slot: "asc" },
                select: {
                  id: true,
                  slot: true,
                  fingerprintIdOnDevice: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

export async function syncAttendanceClassToDevice(
  classCode: string,
  deviceId: string,
  options: { chunkSize?: number } = {}
) {
  const chunkSize = Math.max(64, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const [attendanceClass, device] = await Promise.all([
    prisma.attendanceClass.findUnique({
      where: { code: classCode },
      include: {
        students: {
          orderBy: { student: { nim: "asc" } },
          include: {
            student: {
              include: {
                fingerprints: {
                  orderBy: { slot: "asc" },
                },
              },
            },
          },
        },
      },
    }),
    prisma.device.findUnique({ where: { deviceId } }),
  ]);

  if (!attendanceClass) {
    return { ok: false as const, status: 404, error: "Class not found" };
  }

  if (!device) {
    return { ok: false as const, status: 404, error: "Device not found" };
  }

  const sentAt = new Date().toISOString();
  const commandTopic = getMqttServerTopic(device.deviceId, "class/command");
  const manifestTopic = getMqttServerTopic(device.deviceId, "template/manifest");
  const dataTopic = getMqttServerTopic(device.deviceId, "template/data");

  const roster = attendanceClass.students.map(({ student }) => ({
    student_id: student.id,
    nim: student.nim,
    name: student.name,
    fingerprints: student.fingerprints.map((fingerprint) => ({
      slot: fingerprint.slot,
      fingerprint_id: fingerprint.fingerprintIdOnDevice,
    })),
  }));

  await publishMqtt(commandTopic, {
    command: "SYNC_CLASS_ROSTER",
    device_id: device.deviceId,
    class_code: attendanceClass.code,
    class_name: attendanceClass.name,
    student_count: roster.length,
    students: roster,
    sent_at: sentAt,
  });

  let fingerprintCount = 0;
  let chunkCount = 0;
  let skippedEmptyTemplates = 0;

  for (const { student } of attendanceClass.students) {
    for (const fingerprint of student.fingerprints) {
      const template = await decryptTemplate(
        fingerprint.templateEnc,
        fingerprint.encryptionIv,
        fingerprint.encryptionTag
      );

      if (!template) {
        skippedEmptyTemplates++;
        continue;
      }

      const chunks = chunkTemplate(template, chunkSize);
      fingerprintCount++;
      chunkCount += chunks.length;

      await publishMqtt(manifestTopic, {
        device_id: device.deviceId,
        class_code: attendanceClass.code,
        class_name: attendanceClass.name,
        student_id: student.id,
        nim: student.nim,
        name: student.name,
        slot: fingerprint.slot,
        fingerprint_id: fingerprint.fingerprintIdOnDevice,
        chunk_size: chunkSize,
        total_chunks: chunks.length,
        total_size: template.length,
        source: "backend_class_sync",
        sent_at: sentAt,
      });

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        await publishMqtt(dataTopic, {
          device_id: device.deviceId,
          class_code: attendanceClass.code,
          student_id: student.id,
          nim: student.nim,
          name: student.name,
          slot: fingerprint.slot,
          fingerprint_id: fingerprint.fingerprintIdOnDevice,
          chunk_index: chunkIndex,
          total_chunks: chunks.length,
          data: chunks[chunkIndex],
        });
      }
    }
  }

  return {
    ok: true as const,
    deviceId: device.deviceId,
    classCode: attendanceClass.code,
    className: attendanceClass.name,
    studentCount: roster.length,
    fingerprintCount,
    chunkCount,
    skippedEmptyTemplates,
    topics: {
      command: commandTopic,
      manifest: manifestTopic,
      data: dataTopic,
    },
  };
}

export async function changeActiveClassOnDevice(
  classCode: string,
  deviceId: string
) {
  const chunkSize = DEFAULT_CHUNK_SIZE;
  const [attendanceClass, device] = await Promise.all([
    prisma.attendanceClass.findUnique({
      where: { code: classCode },
      include: {
        students: {
          orderBy: { student: { nim: "asc" } },
          include: {
            student: {
              include: {
                fingerprints: {
                  orderBy: { slot: "asc" },
                },
              },
            },
          },
        },
      },
    }),
    prisma.device.findUnique({ where: { deviceId } }),
  ]);

  if (!attendanceClass) {
    return { ok: false as const, status: 404, error: "Class not found" };
  }

  if (!device) {
    return { ok: false as const, status: 404, error: "Device not found" };
  }

  const sentAt = new Date().toISOString();
  const syncId = `class-${attendanceClass.code}-${device.deviceId}-${Date.now()}`;
  const commandTopic = getKampusCommandTopic(device.deviceId);
  const commandPayload = {
    command: "SET_ACTIVE_CLASS",
    device_id: device.deviceId,
    class_code: attendanceClass.code,
    class_name: attendanceClass.name,
    student_count: attendanceClass.students.length,
    sent_at: sentAt,
  };

  await redis.set(`active_class:${device.deviceId}`, attendanceClass.code);
  activeClassByDevice.set(device.deviceId, attendanceClass.code);
  await publishMqtt(commandTopic, commandPayload);

  const students = attendanceClass.students.map(({ student }) => ({
    nim: student.nim,
    nama: student.name,
    name: student.name,
    fingerprints: student.fingerprints
      .map((fingerprint) => fingerprint.fingerprintIdOnDevice)
      .filter((fingerprintId): fingerprintId is number => fingerprintId !== null),
  }));

  await publishMqtt(DEVICE_TOPICS.catalog, {
    active_class: attendanceClass.code,
    class_code: attendanceClass.code,
    class_name: attendanceClass.name,
    device_id: device.deviceId,
    students,
    sent_at: sentAt,
  });

  const templateMessages: Array<{
    template_uid: string;
    fingerprint_id: number;
    chunk_total: number;
    chunks: string[];
  }> = [];

  for (const { student } of attendanceClass.students) {
    for (const fingerprint of student.fingerprints) {
      if (fingerprint.fingerprintIdOnDevice === null) continue;

      const template = await decryptTemplate(
        fingerprint.templateEnc,
        fingerprint.encryptionIv,
        fingerprint.encryptionTag
      );

      if (!template) continue;

      const chunks = chunkTemplate(template, chunkSize);
      if (chunks.length === 0) continue;

      templateMessages.push({
        template_uid: `${student.nim}-slot-${fingerprint.slot}`,
        fingerprint_id: fingerprint.fingerprintIdOnDevice,
        chunk_total: chunks.length,
        chunks,
      });
    }
  }

  await publishMqtt(DEVICE_TOPICS.templateManifest, {
    sync_id: syncId,
    device_id: device.deviceId,
    active_class: attendanceClass.code,
    class_code: attendanceClass.code,
    class_name: attendanceClass.name,
    total_templates: templateMessages.length,
    templates: templateMessages.map((template) => ({
      template_uid: template.template_uid,
      fingerprint_id: template.fingerprint_id,
      chunk_total: template.chunk_total,
    })),
    sent_at: sentAt,
  });

  let chunkCount = 0;
  for (const template of templateMessages) {
    for (let index = 0; index < template.chunks.length; index++) {
      chunkCount++;
      await publishMqtt(DEVICE_TOPICS.templateChunk, {
        sync_id: syncId,
        device_id: device.deviceId,
        template_uid: template.template_uid,
        fingerprint_id: template.fingerprint_id,
        chunk_index: index + 1,
        chunk_total: template.chunk_total,
        chunk: template.chunks[index],
        sent_at: sentAt,
      });
    }
  }

  return {
    ok: true as const,
    deviceId: device.deviceId,
    classCode: attendanceClass.code,
    className: attendanceClass.name,
    studentCount: attendanceClass.students.length,
    templateCount: templateMessages.length,
    chunkCount,
    topics: {
      command: commandTopic,
      catalog: DEVICE_TOPICS.catalog,
      manifest: DEVICE_TOPICS.templateManifest,
      chunk: DEVICE_TOPICS.templateChunk,
    },
    payload: commandPayload,
  };
}

export async function syncClassForDeviceRequest(
  deviceId: string,
  requestedClassCode?: string
) {
  const classCode = await resolveActiveClassCodeForDevice(
    deviceId,
    requestedClassCode
  );

  return await changeActiveClassOnDevice(classCode, deviceId);
}
