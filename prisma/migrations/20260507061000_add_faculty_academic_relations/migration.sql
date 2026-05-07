-- CreateTable
CREATE TABLE "faculties" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faculties_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "departments"
ADD COLUMN "faculty_id" TEXT;

-- AlterTable
ALTER TABLE "courses"
ADD COLUMN "department_id" TEXT;

-- AlterTable
ALTER TABLE "attendance_classes"
ADD COLUMN "department_id" TEXT,
ADD COLUMN "course_id" TEXT;

-- AlterTable
ALTER TABLE "devices"
ADD COLUMN "class_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "faculties_code_key" ON "faculties"("code");

-- CreateIndex
CREATE INDEX "departments_faculty_id_idx" ON "departments"("faculty_id");

-- CreateIndex
CREATE INDEX "courses_department_id_idx" ON "courses"("department_id");

-- CreateIndex
CREATE INDEX "attendance_classes_department_id_idx" ON "attendance_classes"("department_id");

-- CreateIndex
CREATE INDEX "attendance_classes_course_id_idx" ON "attendance_classes"("course_id");

-- CreateIndex
CREATE INDEX "devices_class_id_idx" ON "devices"("class_id");

-- AddForeignKey
ALTER TABLE "departments"
ADD CONSTRAINT "departments_faculty_id_fkey"
FOREIGN KEY ("faculty_id") REFERENCES "faculties"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses"
ADD CONSTRAINT "courses_department_id_fkey"
FOREIGN KEY ("department_id") REFERENCES "departments"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_classes"
ADD CONSTRAINT "attendance_classes_department_id_fkey"
FOREIGN KEY ("department_id") REFERENCES "departments"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_classes"
ADD CONSTRAINT "attendance_classes_course_id_fkey"
FOREIGN KEY ("course_id") REFERENCES "courses"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices"
ADD CONSTRAINT "devices_class_id_fkey"
FOREIGN KEY ("class_id") REFERENCES "attendance_classes"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
