CREATE TABLE "sia_schedule_clones" (
  "id" TEXT NOT NULL,
  "source_schedule_id" TEXT NOT NULL,
  "department_id" TEXT,
  "department_code" TEXT NOT NULL,
  "department_name" TEXT NOT NULL,
  "class_id" TEXT,
  "class_code" TEXT NOT NULL,
  "class_name" TEXT NOT NULL,
  "course_id" TEXT NOT NULL,
  "course_name" TEXT NOT NULL,
  "lecturer_id" TEXT NOT NULL,
  "lecturer_name" TEXT NOT NULL,
  "scheduled_date" TIMESTAMP(3) NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "room_name" TEXT,
  "sync_batch_id" TEXT NOT NULL,
  "last_sync_status" TEXT NOT NULL DEFAULT 'SYNCED',
  "raw_payload" JSONB NOT NULL,
  "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "sia_schedule_clones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sia_schedule_clones_source_schedule_id_key"
ON "sia_schedule_clones"("source_schedule_id");

CREATE INDEX "sia_schedule_clones_scheduled_date_idx"
ON "sia_schedule_clones"("scheduled_date");

CREATE INDEX "sia_schedule_clones_department_code_idx"
ON "sia_schedule_clones"("department_code");

CREATE INDEX "sia_schedule_clones_class_code_idx"
ON "sia_schedule_clones"("class_code");

CREATE INDEX "sia_schedule_clones_course_id_idx"
ON "sia_schedule_clones"("course_id");

CREATE INDEX "sia_schedule_clones_lecturer_id_idx"
ON "sia_schedule_clones"("lecturer_id");
