import { prisma } from "../../lib/prisma";

type SiaAttendancePushConfig =
  | {
      enabled: true;
      endpoint: string;
      token?: string;
      timeoutMs: number;
    }
  | {
      enabled: false;
      reason: string;
    };

type SiaAttendancePushResult =
  | {
      ok: true;
      skipped: true;
      reason: string;
    }
  | {
      ok: true;
      skipped: false;
      endpoint: string;
      httpStatus: number;
      payload: Record<string, unknown>;
      responseBody: unknown;
    }
  | {
      ok: false;
      skipped: false;
      endpoint?: string;
      httpStatus?: number;
      error: string;
      payload?: Record<string, unknown>;
      responseBody?: unknown;
    };

function parseBooleanEnv(value: string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getSiaAttendancePushConfig(): SiaAttendancePushConfig {
  const enabled = parseBooleanEnv(
    process.env.SIA_ATTENDANCE_PUSH_ENABLED,
    true
  );

  if (!enabled) {
    return {
      enabled: false,
      reason: "SIA_ATTENDANCE_PUSH_ENABLED is false",
    };
  }

  const endpoint = process.env.SIA_ATTENDANCE_API_URL?.trim();
  if (!endpoint) {
    return {
      enabled: false,
      reason: "SIA_ATTENDANCE_API_URL is not set",
    };
  }

  const timeoutMs = Number(process.env.SIA_ATTENDANCE_PUSH_TIMEOUT_MS ?? 10000);

  return {
    enabled: true,
    endpoint,
    token: process.env.SIA_ATTENDANCE_API_TOKEN || process.env.SIA_API_TOKEN,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
  };
}

async function readResponseBody(response: Response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function findAttendanceRecordForSia(recordId: string) {
  return await prisma.attendanceRecord.findUnique({
    where: { id: recordId },
    include: {
      student: true,
      attendanceSession: {
        include: {
          courseClass: {
            include: {
              course: true,
              lecturer: true,
              semester: true,
              device: true,
            },
          },
        },
      },
    },
  });
}

type AttendanceRecordForSia = NonNullable<
  Awaited<ReturnType<typeof findAttendanceRecordForSia>>
>;

export function buildSiaAttendancePayload(record: AttendanceRecordForSia) {
  const session = record.attendanceSession;
  const courseClass = session.courseClass;

  // Ubah mapping ini nanti ketika kontrak body API SIA sudah final.
  return {
    source: "bioesign",
    event: "attendance_recorded",
    attendance_record_id: record.id,
    attendance_session_id: session.id,
    meeting_number: session.meetingNumber,
    checked_at: record.checkedAt.toISOString(),
    status: record.status,
    attendance_source: record.source,
    match_score: record.matchScore,
    student: {
      id: record.student.id,
      nim: record.student.nim,
      name: record.student.name,
      email: record.student.email,
    },
    course_class: {
      id: courseClass.id,
      code: courseClass.code,
      name: courseClass.name,
    },
    course: {
      id: courseClass.course.id,
      code: courseClass.course.code,
      name: courseClass.course.name,
    },
    lecturer: courseClass.lecturer
      ? {
          id: courseClass.lecturer.id,
          nidn: courseClass.lecturer.nidn,
          name: courseClass.lecturer.name,
        }
      : null,
    semester: courseClass.semester
      ? {
          id: courseClass.semester.id,
          code: courseClass.semester.code,
          name: courseClass.semester.name,
          academic_year: courseClass.semester.academicYear,
        }
      : null,
    device: courseClass.device
      ? {
          id: courseClass.device.id,
          device_id: courseClass.device.deviceId,
        }
      : {
          id: null,
          device_id: courseClass.deviceCode,
        },
    raw_payload: record.rawPayload,
  };
}

export async function postSiaAttendancePayload(
  payload: Record<string, unknown>
): Promise<SiaAttendancePushResult> {
  const config = getSiaAttendancePushConfig();
  if (!config.enabled) {
    return {
      ok: true,
      skipped: true,
      reason: config.reason,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        endpoint: config.endpoint,
        httpStatus: response.status,
        error: `SIA attendance API returned HTTP ${response.status}`,
        payload,
        responseBody,
      };
    }

    return {
      ok: true,
      skipped: false,
      endpoint: config.endpoint,
      httpStatus: response.status,
      payload,
      responseBody,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      endpoint: config.endpoint,
      error:
        error instanceof Error
          ? error.message
          : "Failed to post attendance to SIA",
      payload,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function pushAttendanceRecordToSia(
  attendanceRecordId: string
): Promise<SiaAttendancePushResult> {
  const record = await findAttendanceRecordForSia(attendanceRecordId);
  if (!record) {
    return {
      ok: false,
      skipped: false,
      error: "Attendance record not found",
    };
  }

  return await postSiaAttendancePayload(buildSiaAttendancePayload(record));
}
