import { closePool, pool } from './pool.js'

const sql = `
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
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  preferred_language TEXT NOT NULL DEFAULT '',
  visit_purpose TEXT NOT NULL,
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

ALTER TABLE report_submissions
  ALTER COLUMN date_of_birth DROP NOT NULL,
  ALTER COLUMN nationality SET DEFAULT '',
  ALTER COLUMN email SET DEFAULT '',
  ALTER COLUMN city SET DEFAULT '',
  ALTER COLUMN preferred_language SET DEFAULT '',
  ALTER COLUMN chief_complaint SET DEFAULT '';

ALTER TABLE report_submissions
  ADD COLUMN IF NOT EXISTS uploaded_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parsed_files JSONB NOT NULL DEFAULT '[]'::jsonb;

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
`

try {
  await pool.query(sql)
  console.log('Database migration completed.')
} finally {
  await closePool()
}
