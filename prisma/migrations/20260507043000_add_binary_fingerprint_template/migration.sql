ALTER TABLE "student_fingerprints"
  ADD COLUMN "template_enc_bytes" BYTEA,
  ALTER COLUMN "template_enc" DROP NOT NULL;
