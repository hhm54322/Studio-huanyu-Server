import type { Pool } from 'pg'

// Separate additive migration: never rewrite historical patient reports.
export const migrateExpertReview = async (db: Pool) => db.query(`
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS expert_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL UNIQUE,
 display_name text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('expert','admin','knowledge_confirmer','data_curator')),
 active boolean NOT NULL DEFAULT true, test_account boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expert_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES expert_accounts(id),
 csrf_token text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expert_sessions_account ON expert_sessions(account_id);
CREATE TABLE IF NOT EXISTS expert_case_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text NOT NULL CHECK(mode IN ('free','professional')),
 source_id uuid NOT NULL, submission_no text NOT NULL, fingerprint text NOT NULL,
 report jsonb NOT NULL, input jsonb NOT NULL, modules jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(mode, source_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS expert_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_version_id uuid NOT NULL REFERENCES expert_case_versions(id),
 expert_id uuid NOT NULL REFERENCES expert_accounts(id), version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted')),
 notes jsonb NOT NULL DEFAULT '[]', confirmed jsonb NOT NULL DEFAULT '[]', drafts jsonb NOT NULL DEFAULT '{}',
 submitted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(case_version_id, expert_id)
);
CREATE TABLE IF NOT EXISTS expert_knowledge (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), review_id uuid NOT NULL REFERENCES expert_reviews(id),
 note_id uuid NOT NULL, case_version_id uuid NOT NULL REFERENCES expert_case_versions(id),
 version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending_confirmation'
   CHECK(status IN ('pending_confirmation','expert_published','approved','rejected','withdrawn')),
 title text NOT NULL, disease_key text NOT NULL, module_key text NOT NULL,
 guidance text NOT NULL, evidence text NOT NULL, applicability text NOT NULL, exclusions text NOT NULL,
 keywords jsonb NOT NULL DEFAULT '[]', required_terms jsonb NOT NULL DEFAULT '[]', excluded_terms jsonb NOT NULL DEFAULT '[]', valid_until timestamptz,
 confirmed_by uuid REFERENCES expert_accounts(id), confirmed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(review_id,note_id),
 CHECK(status != 'approved' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS expert_knowledge_approved ON expert_knowledge(disease_key,status);
CREATE TABLE IF NOT EXISTS expert_knowledge_vectors (
 knowledge_id uuid NOT NULL REFERENCES expert_knowledge(id), knowledge_version integer NOT NULL,
 model text NOT NULL, content_hash text NOT NULL, embedding jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(knowledge_id,knowledge_version,model,content_hash)
);
ALTER TABLE expert_knowledge DROP CONSTRAINT IF EXISTS expert_knowledge_status_check;
ALTER TABLE expert_knowledge ADD CONSTRAINT expert_knowledge_status_check
 CHECK(status IN ('pending_confirmation','expert_published','approved','rejected','withdrawn'));
CREATE TABLE IF NOT EXISTS expert_attachment_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_version_id uuid NOT NULL REFERENCES expert_case_versions(id),
 file_index integer NOT NULL CHECK(file_index >= 0), source_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending_redaction' CHECK(status IN ('pending_redaction','approved')),
 pages jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 1,
 confirmed_by uuid REFERENCES expert_accounts(id), confirmed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(case_version_id,file_index),
 CHECK(status != 'approved' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS expert_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES expert_accounts(id),
 action text NOT NULL, resource_id text NOT NULL DEFAULT '', metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expert_generation_knowledge (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submission_no text NOT NULL, mode text NOT NULL,
 citations jsonb NOT NULL DEFAULT '[]', status text NOT NULL CHECK(status IN ('context_ready','completed','failed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE expert_generation_knowledge ADD COLUMN IF NOT EXISTS retrieval jsonb NOT NULL DEFAULT '{}';
`)
