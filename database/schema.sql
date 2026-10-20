-- Apply to development. Production schema changes are handled by Publish.
CREATE TABLE IF NOT EXISTS app_documents (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS site_presence (
  session_id text PRIMARY KEY,
  visitor_id text NOT NULL,
  path text NOT NULL,
  visible boolean NOT NULL DEFAULT true,
  wallet text,
  chain text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_presence_last_seen_idx ON site_presence(last_seen);
CREATE INDEX IF NOT EXISTS site_presence_visitor_idx ON site_presence(visitor_id);
CREATE TABLE IF NOT EXISTS site_visits (
  visitor_id text NOT NULL,
  visit_id text PRIMARY KEY,
  path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_visits_created_idx ON site_visits(created_at);