import { prisma } from "../../lib/prisma";
import { randomUUID } from "crypto";

export interface SiaSchedulePayload {
  source_schedule_id: string;
  department_id?: string | null;
  department_code: string;
  department_name: string;
  class_id?: string | null;
  class_code: string;
  class_name: string;
  course_id: string;
  course_name: string;
  lecturer_id: string;
  lecturer_name: string;
  date: string;
  start_time: string;
  end_time: string;
  room_name?: string | null;
}

interface SyncSiaOptions {
  forceDummy?: boolean;
}

const DUMMY_SIA_SCHEDULES: SiaSchedulePayload[] = [
  {
    source_schedule_id: "SIA-2026-IF-A-IF101-001",
    department_id: "SIA-DEPT-IF",
    department_code: "IF",
    department_name: "Informatika",
    class_id: "SIA-CLASS-IF-A",
    class_code: "IF-A",
    class_name: "Informatika A",
    course_id: "IF101",
    course_name: "Algoritma dan Pemrograman",
    lecturer_id: "D-001",
    lecturer_name: "Dr. Budi Santoso",
    date: "2026-07-03",
    start_time: "08:00",
    end_time: "09:40",
    room_name: "Lab Komputasi 1",
  },
  {
    source_schedule_id: "SIA-2026-IF-B-IF203-001",
    department_id: "SIA-DEPT-IF",
    department_code: "IF",
    department_name: "Informatika",
    class_id: "SIA-CLASS-IF-B",
    class_code: "IF-B",
    class_name: "Informatika B",
    course_id: "IF203",
    course_name: "Basis Data",
    lecturer_id: "D-014",
    lecturer_name: "Dr. Siti Rahma",
    date: "2026-07-03",
    start_time: "10:00",
    end_time: "11:40",
    room_name: "Ruang 2.4",
  },
];

function buildLocalDateTime(date: string, time: string) {
  return new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`);
}

function normalizeScheduleDate(date: string) {
  return new Date(`${date}T00:00:00`);
}

function getSiaApiHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (process.env.SIA_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.SIA_API_TOKEN}`;
  }

  return headers;
}

function parseSiaResponse(payload: unknown): SiaSchedulePayload[] {
  if (Array.isArray(payload)) return payload as SiaSchedulePayload[];

  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as SiaSchedulePayload[];
  }

  throw new Error("SIA API response must be an array or { data: [] }");
}

export async function fetchSiaSchedules(options: SyncSiaOptions = {}) {
  const apiUrl = process.env.SIA_API_URL;
  if (!apiUrl || options.forceDummy) {
    return DUMMY_SIA_SCHEDULES;
  }

  const response = await fetch(apiUrl, {
    headers: getSiaApiHeaders(),
  });

  if (!response.ok) {
    throw new Error(`SIA API failed with HTTP ${response.status}`);
  }

  return parseSiaResponse(await response.json());
}

export async function syncSiaSchedules(options: SyncSiaOptions = {}) {
  const schedules = await fetchSiaSchedules(options);
  const batchId = randomUUID();
  const syncedAt = new Date();

  const existing = await prisma.siaScheduleClone.findMany({
    where: {
      sourceScheduleId: {
        in: schedules.map((schedule) => schedule.source_schedule_id),
      },
    },
    select: { sourceScheduleId: true },
  });
  const existingIds = new Set(existing.map((item) => item.sourceScheduleId));

  for (const schedule of schedules) {
    await prisma.siaScheduleClone.upsert({
      where: { sourceScheduleId: schedule.source_schedule_id },
      update: {
        departmentId: schedule.department_id ?? null,
        departmentCode: schedule.department_code,
        departmentName: schedule.department_name,
        classId: schedule.class_id ?? null,
        classCode: schedule.class_code,
        className: schedule.class_name,
        courseId: schedule.course_id,
        courseName: schedule.course_name,
        lecturerId: schedule.lecturer_id,
        lecturerName: schedule.lecturer_name,
        scheduledDate: normalizeScheduleDate(schedule.date),
        startsAt: buildLocalDateTime(schedule.date, schedule.start_time),
        endsAt: buildLocalDateTime(schedule.date, schedule.end_time),
        roomName: schedule.room_name ?? null,
        syncBatchId: batchId,
        lastSyncStatus: "SYNCED",
        rawPayload: schedule as object,
        lastSyncedAt: syncedAt,
      },
      create: {
        sourceScheduleId: schedule.source_schedule_id,
        departmentId: schedule.department_id ?? null,
        departmentCode: schedule.department_code,
        departmentName: schedule.department_name,
        classId: schedule.class_id ?? null,
        classCode: schedule.class_code,
        className: schedule.class_name,
        courseId: schedule.course_id,
        courseName: schedule.course_name,
        lecturerId: schedule.lecturer_id,
        lecturerName: schedule.lecturer_name,
        scheduledDate: normalizeScheduleDate(schedule.date),
        startsAt: buildLocalDateTime(schedule.date, schedule.start_time),
        endsAt: buildLocalDateTime(schedule.date, schedule.end_time),
        roomName: schedule.room_name ?? null,
        syncBatchId: batchId,
        lastSyncStatus: "SYNCED",
        rawPayload: schedule as object,
        lastSyncedAt: syncedAt,
      },
    });
  }

  return {
    batch_id: batchId,
    source: process.env.SIA_API_URL && !options.forceDummy ? "api" : "dummy",
    pulled: schedules.length,
    created: schedules.filter((schedule) => !existingIds.has(schedule.source_schedule_id)).length,
    updated: schedules.filter((schedule) => existingIds.has(schedule.source_schedule_id)).length,
    synced_at: syncedAt.toISOString(),
  };
}
