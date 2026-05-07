import { prisma } from "../../lib/prisma";
import { encryptTemplateBytes } from "../../lib/crypto";
import { publishMqtt } from "../../lib/mqtt";

const DEVICE_TOPIC_PREFIX = process.env.MQTT_DEVICE_TOPIC_PREFIX ?? "presence";

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
  return `${DEVICE_TOPIC_PREFIX}/device/${deviceId}/command`;
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
  deviceId: string;
  nim: string;
  name: string;
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
  const name = input.name.trim();
  if (!nim) {
    return { ok: false as const, status: 400, error: "nim is required" };
  }
  if (!name) {
    return { ok: false as const, status: 400, error: "name is required" };
  }

  const device = await prisma.device.findUnique({
    where: { deviceId: input.deviceId },
  });

  if (!device) {
    return { ok: false as const, status: 404, error: "Device not found" };
  }

  const student = await prisma.student.upsert({
    where: { nim },
    update: { name, isActive: true },
    create: { nim, name, isActive: true },
  });

  const topic = getCommandTopic(device.deviceId);
  const payload = {
    command: "REGISTER",
    status: "register",
    device_id: device.deviceId,
    nim: student.nim,
    nama: student.name,
    name: student.name,
    slot,
    class_code: input.classCode,
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
