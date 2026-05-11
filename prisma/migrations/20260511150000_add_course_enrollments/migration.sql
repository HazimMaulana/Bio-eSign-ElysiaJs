CREATE TABLE "course_enrollments" (
  "id" TEXT NOT NULL,
  "course_id" TEXT NOT NULL,
  "student_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "course_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "course_enrollments_course_id_student_id_key"
ON "course_enrollments"("course_id", "student_id");

CREATE INDEX "course_enrollments_student_id_idx"
ON "course_enrollments"("student_id");

ALTER TABLE "course_enrollments"
ADD CONSTRAINT "course_enrollments_course_id_fkey"
FOREIGN KEY ("course_id") REFERENCES "courses"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_enrollments"
ADD CONSTRAINT "course_enrollments_student_id_fkey"
FOREIGN KEY ("student_id") REFERENCES "students"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
