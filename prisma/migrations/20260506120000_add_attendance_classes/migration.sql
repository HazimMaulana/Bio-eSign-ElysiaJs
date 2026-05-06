-- CreateTable
CREATE TABLE "attendance_classes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_class_students" (
    "id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_class_students_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_classes_code_key" ON "attendance_classes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_class_students_class_id_student_id_key" ON "attendance_class_students"("class_id", "student_id");

-- CreateIndex
CREATE INDEX "attendance_class_students_student_id_idx" ON "attendance_class_students"("student_id");

-- AddForeignKey
ALTER TABLE "attendance_class_students" ADD CONSTRAINT "attendance_class_students_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "attendance_classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_class_students" ADD CONSTRAINT "attendance_class_students_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
