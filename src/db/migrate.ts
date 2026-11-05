import { closePool, pool } from './pool.js'
import { consultationMigrationSql } from './consultationsMigration.js'
import { migrateExpertReview } from '../expert/migration.js'
import { migrateContactAnalytics } from '../analytics/migration.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const baseMigrationSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS report_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_no TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL,
  full_name TEXT NOT NULL,
  gender TEXT NOT NULL,
  date_of_birth DATE,
  nationality TEXT NOT NULL DEFAULT '',
  id_type TEXT,
  id_number TEXT,
  phone TEXT,
  email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  preferred_language TEXT NOT NULL DEFAULT '',
  visit_purpose TEXT NOT NULL,
  care_need TEXT NOT NULL DEFAULT '',
  care_need_other TEXT NOT NULL DEFAULT '',
  expected_treatment_time TEXT NOT NULL DEFAULT '',
  chief_complaint TEXT NOT NULL DEFAULT '',
  selected_regions JSONB NOT NULL DEFAULT '[]'::jsonb,
  uploaded_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  parsed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  report_status TEXT NOT NULL DEFAULT 'submitted',
  report_result JSONB,
  source TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_submissions_created_at
  ON report_submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_submissions_status
  ON report_submissions (report_status);

CREATE TABLE IF NOT EXISTS professional_report_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_no TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL,
  full_name TEXT NOT NULL,
  gender TEXT NOT NULL,
  date_of_birth DATE,
  nationality TEXT NOT NULL DEFAULT '',
  phone TEXT,
  email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  preferred_language TEXT NOT NULL DEFAULT '',
  visit_purpose TEXT NOT NULL,
  care_need TEXT NOT NULL DEFAULT '',
  care_need_other TEXT NOT NULL DEFAULT '',
  expected_treatment_time TEXT NOT NULL DEFAULT '',
  diagnosis TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  chief_complaint TEXT NOT NULL DEFAULT '',
  pathology_summary TEXT NOT NULL DEFAULT '',
  imaging_summary TEXT NOT NULL DEFAULT '',
  genetic_summary TEXT NOT NULL DEFAULT '',
  treatment_history TEXT NOT NULL DEFAULT '',
  medication_history TEXT NOT NULL DEFAULT '',
  comorbidities TEXT NOT NULL DEFAULT '',
  allergy_history TEXT NOT NULL DEFAULT '',
  budget_range TEXT NOT NULL DEFAULT '',
  insurance_type TEXT NOT NULL DEFAULT '',
  desired_city TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'routine',
  selected_regions JSONB NOT NULL DEFAULT '[]'::jsonb,
  uploaded_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  parsed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  report_status TEXT NOT NULL DEFAULT 'submitted',
  report_result JSONB,
  source TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_professional_report_submissions_created_at
  ON professional_report_submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_professional_report_submissions_status
  ON professional_report_submissions (report_status);

CREATE TABLE IF NOT EXISTS consultation_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  concern TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted',
  source TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultation_submissions_created_at
  ON consultation_submissions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_consultation_submissions_contact_created_at
  ON consultation_submissions (contact, created_at DESC);

CREATE TABLE IF NOT EXISTS dental_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_no TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL DEFAULT '',
  budget TEXT NOT NULL DEFAULT '',
  visit_time TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  uploaded_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'submitted',
  source TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dental_assessments_created_at
  ON dental_assessments (created_at DESC);

ALTER TABLE consultation_submissions
  ADD COLUMN IF NOT EXISTS request_id TEXT;

UPDATE consultation_submissions
SET request_id = gen_random_uuid()::text
WHERE request_id IS NULL;

ALTER TABLE consultation_submissions
  ALTER COLUMN request_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consultation_submissions_request_id
  ON consultation_submissions (request_id);

ALTER TABLE dental_assessments
  ADD COLUMN IF NOT EXISTS request_id TEXT;

UPDATE dental_assessments
SET request_id = gen_random_uuid()::text
WHERE request_id IS NULL;

ALTER TABLE dental_assessments
  ALTER COLUMN request_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dental_assessments_request_id
  ON dental_assessments (request_id);

ALTER TABLE report_submissions
  ALTER COLUMN date_of_birth DROP NOT NULL,
  ALTER COLUMN nationality SET DEFAULT '',
  ALTER COLUMN email SET DEFAULT '',
  ALTER COLUMN city SET DEFAULT '',
  ALTER COLUMN preferred_language SET DEFAULT '',
  ALTER COLUMN chief_complaint SET DEFAULT '';

ALTER TABLE report_submissions
  ADD COLUMN IF NOT EXISTS uploaded_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parsed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS care_need TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS care_need_other TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS expected_treatment_time TEXT NOT NULL DEFAULT '';

ALTER TABLE professional_report_submissions
  ALTER COLUMN phone DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS care_need TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS care_need_other TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS expected_treatment_time TEXT NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_report_submissions_updated_at ON report_submissions;
CREATE TRIGGER trg_report_submissions_updated_at
BEFORE UPDATE ON report_submissions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_professional_report_submissions_updated_at ON professional_report_submissions;
CREATE TRIGGER trg_professional_report_submissions_updated_at
BEFORE UPDATE ON professional_report_submissions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_consultation_submissions_updated_at ON consultation_submissions;
CREATE TRIGGER trg_consultation_submissions_updated_at
BEFORE UPDATE ON consultation_submissions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_dental_assessments_updated_at ON dental_assessments;
CREATE TRIGGER trg_dental_assessments_updated_at
BEFORE UPDATE ON dental_assessments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
`

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  await pool.query(baseMigrationSql)
  await pool.query(consultationMigrationSql)
  await migrateExpertReview(pool)
  await migrateContactAnalytics(pool)
  console.log('Database migration completed.')
} finally {
  await closePool()
}
}
