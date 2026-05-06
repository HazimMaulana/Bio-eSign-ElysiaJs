import { Database } from "bun:sqlite";
import { prisma } from "../lib/prisma";
import { encryptTemplateBytes } from "../lib/crypto";

const DEFAULT_DB_PATH =
  "C:\\Users\\ASUS\\Documents\\SEMPRO AMIN\\code\\BETA\\data\\presensi.db";
const dbPath = process.env.PRESENSI_DB_PATH ?? DEFAULT_DB_PATH;
const LEGACY_SOURCE = "presensi.db";

type LegacyStudent = {
  id: number;
  name: string;
  nim: string;
  created_at: string;
  updated_at: string;
};

type LegacyClass = {
  id: number;
  code: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type LegacyClassStudent = {
  class_id: number;
  student_id: number;
};

type LegacyFingerprint = {
  student_id: number;
  slot: number;
  fingerprint_id: number | null;
  template_b64: string;
  created_at: string;
  updated_at: string;
};

type LegacyAttendance = {
  id: number;
  device_id: string;
  fingerprint_id: number;
  status: string;
  action: string;
  match_score: number | null;
  event_time: string;
  source_topic: string;
  received_at: string;
  raw_payload: string;
  class_code: string | null;
};

function parseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

async function upsertFingerprint(
  studentId: string,
  fingerprint: LegacyFingerprint
) {
  const existing = await prisma.studentFingerprint.findUnique({
    where: {
      studentId_slot: {
        studentId,
        slot: fingerprint.slot,
      },
    },
  });

  const shouldRefreshTemplate = !existing || fingerprint.template_b64.length > 0;

  if (!shouldRefreshTemplate) {
    await prisma.studentFingerprint.update({
      where: {
        studentId_slot: {
          studentId,
          slot: fingerprint.slot,
        },
      },
      data: {
        fingerprintIdOnDevice: fingerprint.fingerprint_id,
      },
    });
    return;
  }

  const templateBytes = Buffer.from(fingerprint.template_b64, "base64");
  const encrypted = await encryptTemplateBytes(templateBytes);

  await prisma.studentFingerprint.upsert({
    where: {
      studentId_slot: {
        studentId,
        slot: fingerprint.slot,
      },
    },
    update: {
      fingerprintIdOnDevice: fingerprint.fingerprint_id,
      templateEnc: null,
      templateEncBytes: encrypted.encrypted,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    },
    create: {
      studentId,
      slot: fingerprint.slot,
      fingerprintIdOnDevice: fingerprint.fingerprint_id,
      templateEnc: null,
      templateEncBytes: encrypted.encrypted,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    },
  });
}

async function main() {
  const legacy = new Database(dbPath, { readonly: true });

  const students = legacy.query("SELECT * FROM students ORDER BY id").all() as LegacyStudent[];
  const classes = legacy.query("SELECT * FROM classes ORDER BY id").all() as LegacyClass[];
  const classStudents = legacy
    .query("SELECT * FROM class_students ORDER BY id")
    .all() as LegacyClassStudent[];
  const fingerprints = legacy
    .query("SELECT * FROM student_fingerprints ORDER BY id")
    .all() as LegacyFingerprint[];
  const events = legacy
    .query("SELECT * FROM attendance_events ORDER BY id")
    .all() as LegacyAttendance[];

  const studentIdByLegacyId = new Map<number, string>();
  const studentIdByNim = new Map<string, string>();
  const classIdByLegacyId = new Map<number, string>();
  const fingerprintStudentIdByDeviceId = new Map<number, string>();

  const deviceIds = [...new Set(events.map((event) => event.device_id))];
  const devices = await Promise.all(
    deviceIds.map((deviceId) =>
      prisma.device.upsert({
        where: { deviceId },
        update: {},
        create: {
          deviceId,
          locationName: "Dummy imported from presensi.db",
          status: "OFFLINE",
        },
      })
    )
  );
  const deviceDbIdByDeviceId = new Map(
    devices.map((device) => [device.deviceId, device.id])
  );

  for (const student of students) {
    const saved = await prisma.student.upsert({
      where: { nim: student.nim },
      update: {
        name: student.name,
        isActive: true,
      },
      create: {
        nim: student.nim,
        name: student.name,
        isActive: true,
      },
    });

    studentIdByLegacyId.set(student.id, saved.id);
    studentIdByNim.set(student.nim, saved.id);
  }

  for (const attendanceClass of classes) {
    const saved = await prisma.attendanceClass.upsert({
      where: { code: attendanceClass.code },
      update: {
        name: attendanceClass.name,
      },
      create: {
        code: attendanceClass.code,
        name: attendanceClass.name,
      },
    });

    classIdByLegacyId.set(attendanceClass.id, saved.id);
  }

  for (const classStudent of classStudents) {
    const classId = classIdByLegacyId.get(classStudent.class_id);
    const studentId = studentIdByLegacyId.get(classStudent.student_id);

    if (!classId || !studentId) continue;

    await prisma.attendanceClassStudent.upsert({
      where: {
        classId_studentId: {
          classId,
          studentId,
        },
      },
      update: {},
      create: {
        classId,
        studentId,
      },
    });
  }

  for (const fingerprint of fingerprints) {
    const studentId = studentIdByLegacyId.get(fingerprint.student_id);
    if (!studentId) continue;

    await upsertFingerprint(studentId, fingerprint);

    if (fingerprint.fingerprint_id !== null) {
      fingerprintStudentIdByDeviceId.set(fingerprint.fingerprint_id, studentId);
    }
  }

  await prisma.$executeRaw`
    DELETE FROM "attendance_events"
    WHERE "raw_payload"->>'legacy_source' = ${LEGACY_SOURCE}
  `;

  for (const event of events) {
    const rawPayload = parseJson(event.raw_payload);
    const fallbackNim =
      typeof rawPayload.nim === "string" ? rawPayload.nim : undefined;
    const studentId =
      fingerprintStudentIdByDeviceId.get(event.fingerprint_id) ??
      (fallbackNim ? studentIdByNim.get(fallbackNim) : undefined) ??
      null;
    const deviceDbId = deviceDbIdByDeviceId.get(event.device_id);

    if (!deviceDbId) continue;

    await prisma.attendanceEvent.create({
      data: {
        studentId,
        deviceId: deviceDbId,
        action: event.action === "check_out" ? "CHECK_OUT" : "CHECK_IN",
        matchScore: event.match_score,
        eventTime: new Date(event.event_time),
        rawPayload: {
          ...rawPayload,
          legacy_source: LEGACY_SOURCE,
          legacy_event_id: event.id,
          legacy_status: event.status,
          legacy_source_topic: event.source_topic,
          legacy_received_at: event.received_at,
          legacy_class_code: event.class_code,
          fingerprint_id: event.fingerprint_id,
        },
      },
    });
  }

  legacy.close();

  console.log("Imported dummy presensi data");
  console.log(`- students: ${students.length}`);
  console.log(`- classes: ${classes.length}`);
  console.log(`- fingerprints: ${fingerprints.length}`);
  console.log(`- attendance_events: ${events.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
