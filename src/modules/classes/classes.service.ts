import { prisma } from "../../lib/prisma";
import { decryptTemplate, decryptTemplateBytes } from "../../lib/crypto";
import { getMqttServerTopic, publishMqtt, publishMqttBinary } from "../../lib/mqtt";
import { redis } from "../../lib/redis";

type ClassInput = {
  code?: string;
  name?: string;
  departmentCode?: string | null;
  deviceCode?: string | null;
};

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

const classInclude = {
  department: {
    include: {
      faculty: true,
    },
  },
  device: true,
};

function getPrismaErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function normalizeOptionalText(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildClassData(input: ClassInput, partial = false) {
  const data: Record<string, unknown> = {};

  if (!partial || input.code !== undefined) {
    data.code = normalizeOptionalText(input.code);
  }

  if (!partial || input.name !== undefined) {
    data.name = normalizeOptionalText(input.name);
  }

  if (input.departmentCode !== undefined) {
    data.departmentCode = normalizeOptionalText(input.departmentCode);
  }

  if (input.deviceCode !== undefined) {
    data.deviceCode = normalizeOptionalText(input.deviceCode);
  }

  return data;
}

async function validateDepartmentCode(departmentCode: string | null | undefined) {
  if (!departmentCode) return null;

  const department = await prisma.department.findUnique({
    where: { code: departmentCode },
    select: { code: true },
  });

  return department ? null : "Department code not found";
}

async function validateDeviceCode(deviceCode: string | null | undefined) {
  if (!deviceCode) return null;

  const device = await prisma.device.findUnique({
    where: { deviceId: deviceCode },
    select: { deviceId: true },
  });

  return device ? null : "Device code not found";
}

async function findClassIdentity(identifier: string) {
  return await prisma.class.findFirst({
    where: {
      OR: [{ id: identifier }, { code: identifier }],
    },
    select: {
      id: true,
      code: true,
      deviceCode: true,
      departmentCode: true,
    },
  });
}

function chunkTemplateBytes(template: Buffer, chunkSize: number) {
  const chunks: Buffer[] = [];
  for (let i = 0; i < template.length; i += chunkSize) {
    chunks.push(template.subarray(i, i + chunkSize));
  }
  return chunks;
}

async function getFingerprintTemplateBytes(fingerprint: {
  templateEnc?: string | null;
  templateEncBytes?: Uint8Array | Buffer | null;
  encryptionIv: string;
  encryptionTag: string;
}) {
  if (fingerprint.templateEncBytes) {
    return await decryptTemplateBytes(
      fingerprint.templateEncBytes,
      fingerprint.encryptionIv,
      fingerprint.encryptionTag
    );
  }

  if (fingerprint.templateEnc) {
    const legacyBase64 = await decryptTemplate(
      fingerprint.templateEnc,
      fingerprint.encryptionIv,
      fingerprint.encryptionTag
    );
    return Buffer.from(legacyBase64, "base64");
  }

  return null;
}

function getKampusCommandTopic(deviceCode: string) {
  return `${DEVICE_TOPIC_PREFIX}/device/${deviceCode}/command`;
}

async function resolveActiveClassCodeForDevice(
  deviceCode: string,
  requestedClassCode?: string
) {
  if (requestedClassCode) return requestedClassCode;

  const inMemoryClassCode = activeClassByDevice.get(deviceCode);
  if (inMemoryClassCode) return inMemoryClassCode;

  const cachedClassCode = await redis.get(`active_class:${deviceCode}`);
  if (cachedClassCode && cachedClassCode !== "STANDBY") return cachedClassCode;

  return DEFAULT_ACTIVE_CLASS_CODE;
}

async function getStudentsForClassDepartment(departmentCode: string | null) {
  return await prisma.student.findMany({
    where: departmentCode ? { department: { code: departmentCode } } : {},
    orderBy: { nim: "asc" },
    include: {
      fingerprints: {
        orderBy: { slot: "asc" },
      },
    },
  });
}

export async function listAttendanceClasses() {
  return await prisma.class.findMany({
    orderBy: { code: "asc" },
    include: classInclude,
  });
}

export async function getAttendanceClass(identifier: string) {
  return await prisma.class.findFirst({
    where: {
      OR: [{ id: identifier }, { code: identifier }],
    },
    include: classInclude,
  });
}

export async function getAttendanceClassByCode(code: string) {
  return await getAttendanceClass(code);
}

export async function createAttendanceClass(
  input: Required<Pick<ClassInput, "code" | "name">> & ClassInput
) {
  const data = buildClassData(input);
  if (!data.code) {
    return { ok: false as const, status: 400, error: "code is required" };
  }
  if (!data.name) {
    return { ok: false as const, status: 400, error: "name is required" };
  }

  const departmentError = await validateDepartmentCode(
    data.departmentCode as string | null | undefined
  );
  if (departmentError) {
    return { ok: false as const, status: 404, error: departmentError };
  }

  const deviceError = await validateDeviceCode(data.deviceCode as string | null | undefined);
  if (deviceError) {
    return { ok: false as const, status: 404, error: deviceError };
  }

  try {
    const classRecord = await prisma.class.create({
      data: data as {
        code: string;
        name: string;
        departmentCode?: string | null;
        deviceCode?: string | null;
      },
      include: classInclude,
    });

    return { ok: true as const, attendanceClass: classRecord };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2002") {
      return { ok: false as const, status: 409, error: "Class code already exists" };
    }

    throw error;
  }
}

export async function updateAttendanceClass(identifier: string, input: ClassInput) {
  const existing = await findClassIdentity(identifier);
  if (!existing) {
    return { ok: false as const, status: 404, error: "Class not found" };
  }

  const data = buildClassData(input, true);
  if (data.code === null) {
    return { ok: false as const, status: 400, error: "code cannot be empty" };
  }
  if (data.name === null) {
    return { ok: false as const, status: 400, error: "name cannot be empty" };
  }

  const departmentError = await validateDepartmentCode(
    data.departmentCode as string | null | undefined
  );
  if (departmentError) {
    return { ok: false as const, status: 404, error: departmentError };
  }

  const deviceError = await validateDeviceCode(data.deviceCode as string | null | undefined);
  if (deviceError) {
    return { ok: false as const, status: 404, error: deviceError };
  }

  try {
    const classRecord = await prisma.class.update({
      where: { id: existing.id },
      data,
      include: classInclude,
    });

    return { ok: true as const, attendanceClass: classRecord };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2002") {
      return { ok: false as const, status: 409, error: "Class code already exists" };
    }

    throw error;
  }
}

export async function deleteAttendanceClass(identifier: string) {
  const existing = await findClassIdentity(identifier);
  if (!existing) {
    return { ok: false as const, status: 404, error: "Class not found" };
  }

  await prisma.class.delete({ where: { id: existing.id } });

  return {
    ok: true as const,
    message: "Class deleted",
    id: existing.id,
    code: existing.code,
  };
}

export async function syncAttendanceClassToDevice(
  classIdentifier: string,
  deviceCode?: string,
  options: { chunkSize?: number } = {}
) {
  const classRecord = await prisma.class.findFirst({
    where: {
      OR: [{ id: classIdentifier }, { code: classIdentifier }],
    },
  });

  if (!classRecord) {
    return { ok: false as const, status: 404, error: "Class not found" };
  }

  const resolvedDeviceCode = deviceCode ?? classRecord.deviceCode;
  if (!resolvedDeviceCode) {
    return { ok: false as const, status: 400, error: "device_code is required" };
  }

  const device = await prisma.device.findUnique({
    where: { deviceId: resolvedDeviceCode },
  });

  if (!device) {
    return { ok: false as const, status: 404, error: "Device code not found" };
  }

  const chunkSize = Math.max(64, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const students = await getStudentsForClassDepartment(classRecord.departmentCode);
  const sentAt = new Date().toISOString();
  const commandTopic = getMqttServerTopic(device.deviceId, "class/command");
  const manifestTopic = getMqttServerTopic(device.deviceId, "template/manifest");
  const dataTopic = getMqttServerTopic(device.deviceId, "template/data");

  const roster = students.map((student) => ({
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
    class_code: classRecord.code,
    class_name: classRecord.name,
    department_code: classRecord.departmentCode,
    student_count: roster.length,
    students: roster,
    sent_at: sentAt,
  });

  let fingerprintCount = 0;
  let chunkCount = 0;
  let skippedEmptyTemplates = 0;

  for (const student of students) {
    for (const fingerprint of student.fingerprints) {
      const template = await getFingerprintTemplateBytes(fingerprint);

      if (!template) {
        skippedEmptyTemplates++;
        continue;
      }

      const chunks = chunkTemplateBytes(template, chunkSize);
      fingerprintCount++;
      chunkCount += chunks.length;

      await publishMqtt(manifestTopic, {
        device_id: device.deviceId,
        class_code: classRecord.code,
        class_name: classRecord.name,
        department_code: classRecord.departmentCode,
        student_id: student.id,
        nim: student.nim,
        name: student.name,
        slot: fingerprint.slot,
        fingerprint_id: fingerprint.fingerprintIdOnDevice,
        chunk_size: chunkSize,
        total_chunks: chunks.length,
        total_size: template.byteLength,
        source: "backend_class_sync",
        sent_at: sentAt,
      });

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        await publishMqttBinary(
          `${dataTopic}/${chunkIndex + 1}`,
          chunks[chunkIndex]
        );
      }
    }
  }

  return {
    ok: true as const,
    deviceCode: device.deviceId,
    classCode: classRecord.code,
    className: classRecord.name,
    departmentCode: classRecord.departmentCode,
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
  classIdentifier: string,
  deviceCode?: string
) {
  const classRecord = await prisma.class.findFirst({
    where: {
      OR: [{ id: classIdentifier }, { code: classIdentifier }],
    },
  });

  if (!classRecord) {
    return { ok: false as const, status: 404, error: "Class not found" };
  }

  const resolvedDeviceCode = deviceCode ?? classRecord.deviceCode;
  if (!resolvedDeviceCode) {
    return { ok: false as const, status: 400, error: "device_code is required" };
  }

  const device = await prisma.device.findUnique({
    where: { deviceId: resolvedDeviceCode },
  });

  if (!device) {
    return { ok: false as const, status: 404, error: "Device code not found" };
  }

  const students = await getStudentsForClassDepartment(classRecord.departmentCode);
  const chunkSize = DEFAULT_CHUNK_SIZE;
  const sentAt = new Date().toISOString();
  const syncId = `class-${classRecord.code}-${device.deviceId}-${Date.now()}`;
  const commandTopic = getKampusCommandTopic(device.deviceId);
  const commandPayload = {
    command: "SET_ACTIVE_CLASS",
    device_id: device.deviceId,
    class_code: classRecord.code,
    class_name: classRecord.name,
    department_code: classRecord.departmentCode,
    student_count: students.length,
    sent_at: sentAt,
  };

  await redis.set(`active_class:${device.deviceId}`, classRecord.code);
  activeClassByDevice.set(device.deviceId, classRecord.code);
  await publishMqtt(commandTopic, commandPayload);

  const catalogStudents = students.map((student) => ({
    nim: student.nim,
    nama: student.name,
    name: student.name,
    fingerprints: student.fingerprints
      .map((fingerprint) => fingerprint.fingerprintIdOnDevice)
      .filter((fingerprintId): fingerprintId is number => fingerprintId !== null),
  }));

  await publishMqtt(DEVICE_TOPICS.catalog, {
    active_class: classRecord.code,
    class_code: classRecord.code,
    class_name: classRecord.name,
    department_code: classRecord.departmentCode,
    device_id: device.deviceId,
    students: catalogStudents,
    sent_at: sentAt,
  });

  const templateMessages: Array<{
    template_uid: string;
    fingerprint_id: number;
    chunk_total: number;
    chunks: Buffer[];
  }> = [];

  for (const student of students) {
    for (const fingerprint of student.fingerprints) {
      if (fingerprint.fingerprintIdOnDevice === null) continue;

      const template = await getFingerprintTemplateBytes(fingerprint);

      if (!template) continue;

      const chunks = chunkTemplateBytes(template, chunkSize);
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
    active_class: classRecord.code,
    class_code: classRecord.code,
    class_name: classRecord.name,
    department_code: classRecord.departmentCode,
    total_templates: templateMessages.length,
    templates: templateMessages.map((template) => ({
      template_uid: template.template_uid,
      fingerprint_id: template.fingerprint_id,
      chunk_total: template.chunk_total,
      binary: true,
    })),
    sent_at: sentAt,
  });

  let chunkCount = 0;
  for (const template of templateMessages) {
    for (let index = 0; index < template.chunks.length; index++) {
      chunkCount++;
      await publishMqttBinary(
        `${DEVICE_TOPICS.templateChunk}/${syncId}/${template.template_uid}/${index + 1}`,
        template.chunks[index]
      );
    }
  }

  return {
    ok: true as const,
    deviceCode: device.deviceId,
    classCode: classRecord.code,
    className: classRecord.name,
    departmentCode: classRecord.departmentCode,
    studentCount: students.length,
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
  deviceCode: string,
  requestedClassCode?: string
) {
  const classCode = await resolveActiveClassCodeForDevice(
    deviceCode,
    requestedClassCode
  );

  return await changeActiveClassOnDevice(classCode, deviceCode);
}

export async function setDeviceStandby(deviceCode: string) {
  const device = await prisma.device.findUnique({ where: { deviceId: deviceCode } });

  if (!device) {
    return { ok: false as const, status: 404, error: "Device code not found" };
  }

  activeClassByDevice.delete(device.deviceId);
  await redis.set(`active_class:${device.deviceId}`, "STANDBY");

  const sentAt = new Date().toISOString();
  const commandTopic = getKampusCommandTopic(device.deviceId);
  const payload = {
    command: "STANDBY",
    device_id: device.deviceId,
    clear_templates: true,
    sent_at: sentAt,
  };

  await publishMqtt(commandTopic, payload);

  return {
    ok: true as const,
    deviceCode: device.deviceId,
    topic: commandTopic,
    payload,
  };
}
