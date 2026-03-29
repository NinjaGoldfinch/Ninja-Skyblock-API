-- Migrate bazaar_snapshots from JSONB to flat numeric columns
-- Create hourly aggregation table and retention function

DROP TABLE IF EXISTS bazaar_snapshots;

CREATE TABLE bazaar_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  item_id          TEXT NOT NULL,
  instant_buy      DOUBLE PRECISION NOT NULL,
  instant_sell     DOUBLE PRECISION NOT NULL,
  avg_buy          DOUBLE PRECISION NOT NULL,
  avg_sell         DOUBLE PRECISION NOT NULL,
  buy_volume       DOUBLE PRECISION NOT NULL,
  sell_volume      DOUBLE PRECISION NOT NULL,
  buy_orders       INTEGER NOT NULL,
  sell_orders      INTEGER NOT NULL,
  buy_moving_week  DOUBLE PRECISION NOT NULL,
  sell_moving_week DOUBLE PRECISION NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bazaar_item_time ON bazaar_snapshots (item_id, recorded_at DESC);

-- Hourly aggregation table for long-range queries (7d, 30d)
CREATE TABLE IF NOT EXISTS bazaar_hourly (
  id               BIGSERIAL PRIMARY KEY,
  item_id          TEXT NOT NULL,
  bucket           TIMESTAMPTZ NOT NULL,
  avg_instant_buy  DOUBLE PRECISION NOT NULL,
  avg_instant_sell DOUBLE PRECISION NOT NULL,
  avg_buy          DOUBLE PRECISION NOT NULL,
  avg_sell         DOUBLE PRECISION NOT NULL,
  avg_buy_volume   DOUBLE PRECISION NOT NULL,
  avg_sell_volume  DOUBLE PRECISION NOT NULL,
  sample_count     INTEGER NOT NULL,
  UNIQUE (item_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_bazaar_hourly_item_bucket ON bazaar_hourly (item_id, bucket DESC);

-- Aggregate completed hours into bazaar_hourly, then prune old data
CREATE OR REPLACE FUNCTION bazaar_aggregate_and_retain()
RETURNS void AS $$
BEGIN
  -- 1. Upsert completed hours into bazaar_hourly
  INSERT INTO bazaar_hourly (
    item_id, bucket,
    avg_instant_buy, avg_instant_sell,
    avg_buy, avg_sell,
    avg_buy_volume, avg_sell_volume,
    sample_count
  )
  SELECT
    item_id,
    date_trunc('hour', recorded_at) AS bucket,
    AVG(instant_buy),
    AVG(instant_sell),
    AVG(avg_buy),
    AVG(avg_sell),
    AVG(buy_volume),
    AVG(sell_volume),
    COUNT(*)::INTEGER
  FROM bazaar_snapshots
  WHERE recorded_at < date_trunc('hour', NOW())   -- only completed hours
    AND recorded_at >= NOW() - INTERVAL '48 hours' -- look-back window
  GROUP BY item_id, date_trunc('hour', recorded_at)
  ON CONFLICT (item_id, bucket) DO UPDATE SET
    avg_instant_buy  = EXCLUDED.avg_instant_buy,
    avg_instant_sell = EXCLUDED.avg_instant_sell,
    avg_buy          = EXCLUDED.avg_buy,
    avg_sell         = EXCLUDED.avg_sell,
    avg_buy_volume   = EXCLUDED.avg_buy_volume,
    avg_sell_volume  = EXCLUDED.avg_sell_volume,
    sample_count     = EXCLUDED.sample_count;

  -- 2. Delete raw snapshots older than 48h (hourly aggregates cover these)
  DELETE FROM bazaar_snapshots WHERE recorded_at < NOW() - INTERVAL '48 hours';

  -- 3. Delete hourly aggregates older than 90 days
  DELETE FROM bazaar_hourly WHERE bucket < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;
