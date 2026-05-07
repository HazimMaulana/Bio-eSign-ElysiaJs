ALTER TABLE "courses" DROP CONSTRAINT IF EXISTS "courses_department_id_fkey";

ALTER TABLE "courses"
ADD COLUMN "department_code" TEXT;

UPDATE "courses" c
SET "department_code" = d."code"
FROM "departments" d
WHERE c."department_id" = d."id";

ALTER TABLE "courses"
DROP COLUMN IF EXISTS "credits",
DROP COLUMN IF EXISTS "department_id";

DROP INDEX IF EXISTS "courses_department_id_idx";

CREATE INDEX IF NOT EXISTS "courses_department_code_idx" ON "courses"("department_code");

ALTER TABLE "courses"
ADD CONSTRAINT "courses_department_code_fkey"
FOREIGN KEY ("department_code") REFERENCES "departments"("code")
ON DELETE SET NULL ON UPDATE CASCADE;
