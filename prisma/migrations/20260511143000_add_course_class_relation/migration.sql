ALTER TABLE "courses"
ADD COLUMN "class_code" TEXT;

CREATE INDEX IF NOT EXISTS "courses_class_code_idx" ON "courses"("class_code");

ALTER TABLE "courses"
ADD CONSTRAINT "courses_class_code_fkey"
FOREIGN KEY ("class_code") REFERENCES "classes"("code")
ON DELETE SET NULL ON UPDATE CASCADE;
