-- Raw auction price snapshots (sparse, 48h retention)
CREATE TABLE auction_price_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  base_item       TEXT NOT NULL,
  skyblock_id     TEXT,
  lowest_bin      DOUBLE PRECISION NOT NULL,
  median_bin      DOUBLE PRECISION,
  listing_count   INTEGER NOT NULL,
  sale_count      INTEGER NOT NULL DEFAULT 0,
  avg_sale_price  DOUBLE PRECISION,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_auction_price_snap_item_time
  ON auction_price_snapshots (base_item, recorded_at DESC);

CREATE INDEX idx_auction_price_snap_skyid_time
  ON auction_price_snapshots (skyblock_id, recorded_at DESC)
  WHERE skyblock_id IS NOT NULL;

-- RPC function: recent sale stats from auction_history
CREATE OR REPLACE FUNCTION auction_recent_sale_stats(p_since TIMESTAMPTZ)
RETURNS TABLE (base_item TEXT, sale_count BIGINT, avg_sale_price DOUBLE PRECISION) AS $$
BEGIN
  RETURN QUERY
  SELECT ah.base_item, COUNT(*)::BIGINT, AVG(ah.final_price)::DOUBLE PRECISION
  FROM auction_history ah
  WHERE ah.ended_at >= p_since AND ah.outcome = 'sold'
  GROUP BY ah.base_item;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON auction_price_snapshots TO api_anon;
GRANT USAGE, SELECT ON SEQUENCE auction_price_snapshots_id_seq TO api_anon;
GRANT EXECUTE ON FUNCTION auction_recent_sale_stats(TIMESTAMPTZ) TO api_anon;
