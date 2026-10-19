-- Schéma du jalon J1. Les tables des jalons suivants (projet, bloc, prise, mix) viendront s'ajouter.
CREATE TABLE IF NOT EXISTS media (
  id text PRIMARY KEY,
  project text,
  kind text NOT NULL,
  sha256 text,
  size bigint,
  mime text,
  filename text,
  storage_key text,
  status text NOT NULL DEFAULT 'pending',
  variant text NOT NULL DEFAULT 'original',
  parent_id text REFERENCES media(id),
  duration_s double precision,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_sha256 ON media (sha256) WHERE status = 'ready' AND variant = 'original';
CREATE INDEX IF NOT EXISTS media_parent ON media (parent_id);

CREATE TABLE IF NOT EXISTS media_chunk (
  media_id text NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  idx integer NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (media_id, idx)
);

CREATE TABLE IF NOT EXISTS voice (
  id text PRIMARY KEY,
  name text NOT NULL,
  language text NOT NULL DEFAULT 'fr',
  status text NOT NULL DEFAULT 'processing',
  consent_statement text NOT NULL,
  consent_at timestamptz NOT NULL,
  consent_ip text,
  default_reference_id text,
  preview_media_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voice_reference (
  id text PRIMARY KEY,
  voice_id text NOT NULL REFERENCES voice(id) ON DELETE CASCADE,
  media_id text NOT NULL REFERENCES media(id),
  clean_media_id text REFERENCES media(id),
  tag text NOT NULL,
  duration_s double precision,
  embedding jsonb,
  snr_db double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job (
  id text PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  progress double precision NOT NULL DEFAULT 0,
  input jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  items jsonb NOT NULL DEFAULT '[]',
  error jsonb,
  gpu_seconds double precision NOT NULL DEFAULT 0,
  cost_eur double precision NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS job_queued ON job (created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS idempotency (
  key text PRIMARY KEY,
  operation text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  voice_id text,
  detail jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS oauth_client (
  client_id text PRIMARY KEY,
  info jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_grant (
  code text PRIMARY KEY,
  client_id text NOT NULL,
  scopes text[] NOT NULL,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  resource text,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_token (
  token_hash text PRIMARY KEY,
  kind text NOT NULL,
  client_id text NOT NULL,
  scopes text[] NOT NULL,
  resource text,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);
