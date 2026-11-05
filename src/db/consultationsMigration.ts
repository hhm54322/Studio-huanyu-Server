/** Additive M06/M08 migration; safe to deploy without touching report tables. */
export const consultationMigrationSql = `
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
ALTER TABLE consultation_submissions
  ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS topic TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS report_status TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS budget TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS time_window TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'zh',
  ADD COLUMN IF NOT EXISTS flow_mode TEXT NOT NULL DEFAULT 'quick',
  ADD COLUMN IF NOT EXISTS handoff_reason TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS source_context TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_consultation_submissions_status_created_at
  ON consultation_submissions (status, created_at DESC);
`
