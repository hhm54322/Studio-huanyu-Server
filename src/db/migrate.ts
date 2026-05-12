import { closePool, pool } from './pool.js'

const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS report_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_no TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL,
  full_name TEXT NOT NULL,
  gender TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  nationality TEXT NOT NULL,
  id_type TEXT,
  id_number TEXT,
  phone TEXT,
  email TEXT NOT NULL,
  city TEXT NOT NULL,
  preferred_language TEXT NOT NULL,
  visit_purpose TEXT NOT NULL,
  chief_complaint TEXT NOT NULL,
  selected_regions JSONB NOT NULL DEFAULT '[]'::jsonb,
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
`

try {
  await pool.query(sql)
  console.log('Database migration completed.')
} finally {
  await closePool()
}
