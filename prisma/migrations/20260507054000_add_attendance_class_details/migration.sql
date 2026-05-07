-- AlterTable
ALTER TABLE "attendance_classes"
ADD COLUMN "lecturer_id" TEXT,
ADD COLUMN "time" TEXT,
ADD COLUMN "day_of_week" INTEGER,
ADD COLUMN "room_name" TEXT;

-- CreateIndex
CREATE INDEX "attendance_classes_lecturer_id_idx" ON "attendance_classes"("lecturer_id");

-- AddForeignKey
ALTER TABLE "attendance_classes"
ADD CONSTRAINT "attendance_classes_lecturer_id_fkey"
FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
