-- API keys for public consumers and internal services
CREATE TABLE IF NOT EXISTS api_keys (
  id            BIGSERIAL PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  owner         TEXT NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'public',
  rate_limit    INTEGER NOT NULL DEFAULT 30,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);
