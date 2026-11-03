import type { Pool } from 'pg'

// Additive, idempotent and independent of medical records and expert knowledge.
export const migrateContactAnalytics = (db: Pool) => db.query(`
CREATE TABLE IF NOT EXISTS contact_click_events (
  event_id uuid PRIMARY KEY,
  event text NOT NULL CHECK(event = 'whatsapp_click'),
  visitor_hash text NOT NULL CHECK(length(visitor_hash)=64),
  session_hash text NOT NULL CHECK(length(session_hash)=64),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  locale text NOT NULL CHECK(locale IN ('zh','en','id','ms','pt')),
  topic text NOT NULL,
  page text NOT NULL,
  entry text NOT NULL,
  country text NOT NULL DEFAULT '',
  utm_source text NOT NULL DEFAULT '',
  utm_medium text NOT NULL DEFAULT '',
  utm_campaign text NOT NULL DEFAULT '',
  utm_content text NOT NULL DEFAULT '',
  utm_term text NOT NULL DEFAULT '',
  source_id text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS contact_click_date ON contact_click_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS contact_click_campaign_date ON contact_click_events(utm_source,utm_campaign,occurred_at DESC);
CREATE INDEX IF NOT EXISTS contact_click_locale_topic_date ON contact_click_events(locale,topic,occurred_at DESC);
`)
