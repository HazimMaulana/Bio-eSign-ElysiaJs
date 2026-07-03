import { prisma } from "../../lib/prisma";
import { encryptTemplateBytes } from "../../lib/crypto";
import { getMqttDeviceTopic, publishMqtt } from "../../lib/mqtt";

type StoreRegistrationTemplateInput = {
  nim: string;
  name: string;
  slot: number;
  fingerprintId?: number | null;
  templateBytes: Buffer | Uint8Array;
  deviceId?: string;
  classCode?: string;
};

function getCommandTopic(deviceId: string) {
  return getMqttDeviceTopic(deviceId, "command");
}

function normalizeSlot(slot: number) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 3) {
    throw new Error("slot must be an integer between 1 and 3");
  }

  return slot;
}

function normalizeFingerprintId(fingerprintId?: number | null) {
  if (fingerprintId === undefined || fingerprintId === null) return null;
  if (!Number.isInteger(fingerprintId) || fingerprintId < 1 || fingerprintId > 65535) {
    throw new Error("fingerprintId must be an integer between 1 and 65535");
  }

  return fingerprintId;
}

export async function startDeviceRegistration(input: {
  deviceId?: string;
  nim: string;
  slot?: number;
  classCode?: string;
}) {
  let slot: number;
  try {
    slot = normalizeSlot(input.slot ?? 1);
  } catch (error) {
    return {
      ok: false as const,
      status: 400,
      error: error instanceof Error ? error.message : "Invalid registration slot",
    };
  }

  const nim = input.nim.trim();
  if (!nim) {
    return { ok: false as const, status: 400, error: "nim is required" };
  }

  const classCode = input.classCode?.trim();
  if (!classCode) {
    return { ok: false as const, status: 400, error: "class_code is required" };
  }

  const classRecord = await prisma.class.findUnique({
    where: { code: classCode },
    select: {
      code: true,
      deviceCode: true,
    },
  });

  if (!classRecord) {
    return { ok: false as const, status: 404, error: "Class not found" };
  }

  const resolvedDeviceId = input.deviceId?.trim() || classRecord.deviceCode;
  if (!resolvedDeviceId) {
    return {
      ok: false as const,
      status: 400,
      error: "Class device is not set. Send device_id or assign a device to this class first",
    };
  }

  const device = await prisma.device.findUnique({
    where: { deviceId: resolvedDeviceId },
  });

  if (!device) {
    return { ok: false as const, status: 404, error: "Device not found" };
  }

  const student = await prisma.student.findUnique({
    where: { nim },
    select: {
      id: true,
      nim: true,
      name: true,
      isActive: true,
    },
  });

  if (!student) {
    return { ok: false as const, status: 404, error: "Student NIM not found" };
  }

  if (!student.isActive) {
    return { ok: false as const, status: 400, error: "Student is inactive" };
  }

  const topic = getCommandTopic(device.deviceId);
  const payload = {
    command: "REGISTER",
    status: "register",
    device_id: device.deviceId,
    nim: student.nim,
    name: student.name,
    slot,
    class_code: classRecord.code,
    sent_at: new Date().toISOString(),
  };

  await publishMqtt(topic, payload);

  return {
    ok: true as const,
    deviceId: device.deviceId,
    studentId: student.id,
    nim: student.nim,
    name: student.name,
    slot,
    topic,
    payload,
  };
}

export async function storeRegistrationTemplate(input: StoreRegistrationTemplateInput) {
  let slot: number;
  let fingerprintId: number | null;
  try {
    slot = normalizeSlot(input.slot);
    fingerprintId = normalizeFingerprintId(input.fingerprintId);
  } catch (error) {
    return {
      ok: false as const,
      status: 400,
      error: error instanceof Error ? error.message : "Invalid registration template metadata",
    };
  }
  const name = input.name.trim();
  const nim = input.nim.trim();

  if (!nim) {
    return { ok: false as const, status: 400, error: "nim is required" };
  }

  if (!name) {
    return { ok: false as const, status: 400, error: "name is required" };
  }

  if (!input.templateBytes || input.templateBytes.byteLength === 0) {
    return { ok: false as const, status: 400, error: "template is required" };
  }

  const student = await prisma.student.upsert({
    where: { nim },
    update: { name, isActive: true },
    create: { nim, name, isActive: true },
  });

  const { encrypted, iv, tag } = await encryptTemplateBytes(input.templateBytes);
  const fingerprint = await prisma.studentFingerprint.upsert({
    where: {
      studentId_slot: {
        studentId: student.id,
        slot,
      },
    },
    update: {
      fingerprintIdOnDevice: fingerprintId,
      templateEnc: null,
      templateEncBytes: encrypted,
      encryptionIv: iv,
      encryptionTag: tag,
    },
    create: {
      studentId: student.id,
      slot,
      fingerprintIdOnDevice: fingerprintId,
      templateEnc: null,
      templateEncBytes: encrypted,
      encryptionIv: iv,
      encryptionTag: tag,
    },
  });

  await prisma.securityAuditLog.create({
    data: {
      actionType: "REGISTER_FINGERPRINT",
      description: `Registered fingerprint slot ${slot} for ${nim}`,
    },
  });

  return {
    ok: true as const,
    studentId: student.id,
    fingerprintId: fingerprint.id,
    nim: student.nim,
    name: student.name,
    slot: fingerprint.slot,
    fingerprintIdOnDevice: fingerprint.fingerprintIdOnDevice,
  };
}

export async function storeRegistrationTemplateFromBinary(input: {
  nim: string;
  name: string;
  slot: number;
  fingerprintId?: number | null;
  templateBytes: ArrayBuffer;
  deviceId?: string;
  classCode?: string;
}) {
  return await storeRegistrationTemplate({
    nim: input.nim,
    name: input.name,
    slot: input.slot,
    fingerprintId: input.fingerprintId,
    templateBytes: Buffer.from(input.templateBytes),
    deviceId: input.deviceId,
    classCode: input.classCode,
  });
}
