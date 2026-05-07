-- Drop old class roster table; class membership details now live in attendance events/history.
DROP TABLE IF EXISTS "attendance_class_students";

-- Remove foreign keys that reference attendance_classes before reshaping the table.
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_class_id_fkey";
ALTER TABLE "attendance_classes" DROP CONSTRAINT IF EXISTS "attendance_classes_department_id_fkey";
ALTER TABLE "attendance_classes" DROP CONSTRAINT IF EXISTS "attendance_classes_course_id_fkey";
ALTER TABLE "attendance_classes" DROP CONSTRAINT IF EXISTS "attendance_classes_lecturer_id_fkey";

-- Rename attendance_classes to classes.
ALTER TABLE "attendance_classes" RENAME TO "classes";

-- Add code-based relations requested by the API contract.
ALTER TABLE "classes"
ADD COLUMN "department_code" TEXT,
ADD COLUMN "device_code" TEXT;

-- Preserve existing department linkage as department_code where possible.
UPDATE "classes" c
SET "department_code" = d."code"
FROM "departments" d
WHERE c."department_id" = d."id";

-- Preserve existing device assignment as device_code where possible.
UPDATE "classes" c
SET "device_code" = assigned."device_id"
FROM (
  SELECT DISTINCT ON ("class_id") "class_id", "device_id"
  FROM "devices"
  WHERE "class_id" IS NOT NULL
  ORDER BY "class_id", "created_at" DESC
) assigned
WHERE c."id" = assigned."class_id";

-- Drop columns that no longer belong to classes.
ALTER TABLE "classes"
DROP COLUMN IF EXISTS "department_id",
DROP COLUMN IF EXISTS "course_id",
DROP COLUMN IF EXISTS "lecturer_id",
DROP COLUMN IF EXISTS "time",
DROP COLUMN IF EXISTS "day_of_week",
DROP COLUMN IF EXISTS "room_name";

-- Devices are identified by code; remove location and reverse class id assignment.
ALTER TABLE "devices"
DROP COLUMN IF EXISTS "location_name",
DROP COLUMN IF EXISTS "class_id";

-- Remove stale indexes left from previous class shape.
DROP INDEX IF EXISTS "attendance_classes_department_id_idx";
DROP INDEX IF EXISTS "attendance_classes_course_id_idx";
DROP INDEX IF EXISTS "attendance_classes_lecturer_id_idx";
DROP INDEX IF EXISTS "devices_class_id_idx";

-- Create indexes and FK constraints for the simplified shape.
CREATE INDEX IF NOT EXISTS "classes_department_code_idx" ON "classes"("department_code");
CREATE INDEX IF NOT EXISTS "classes_device_code_idx" ON "classes"("device_code");

ALTER TABLE "classes"
ADD CONSTRAINT "classes_department_code_fkey"
FOREIGN KEY ("department_code") REFERENCES "departments"("code")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "classes"
ADD CONSTRAINT "classes_device_code_fkey"
FOREIGN KEY ("device_code") REFERENCES "devices"("device_id")
ON DELETE SET NULL ON UPDATE CASCADE;
