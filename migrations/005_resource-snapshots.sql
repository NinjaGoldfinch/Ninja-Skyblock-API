-- Resource data snapshots for tracking version changes
CREATE TABLE IF NOT EXISTS resource_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  resource_type TEXT NOT NULL,
  version       TEXT,
  raw_data      JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resource_type_time ON resource_snapshots (resource_type, recorded_at DESC);
