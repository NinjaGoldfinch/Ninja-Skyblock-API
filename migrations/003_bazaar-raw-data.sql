-- Replace flat bazaar_snapshots with raw Hypixel data storage
DROP TABLE IF EXISTS bazaar_snapshots;

CREATE TABLE IF NOT EXISTS bazaar_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  item_id       TEXT NOT NULL,
  raw_data      JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bazaar_item_time ON bazaar_snapshots (item_id, recorded_at DESC);

-- GIN index for querying inside raw_data if needed
CREATE INDEX IF NOT EXISTS idx_bazaar_raw_gin ON bazaar_snapshots USING GIN (raw_data);
