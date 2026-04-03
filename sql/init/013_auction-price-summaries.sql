-- Hourly auction price summaries (aggregated from raw snapshots, 90d retention)
CREATE TABLE auction_price_summaries (
  id                BIGSERIAL PRIMARY KEY,
  base_item         TEXT NOT NULL,
  skyblock_id       TEXT,
  bucket            TIMESTAMPTZ NOT NULL,
  granularity       TEXT NOT NULL DEFAULT 'hourly',
  avg_lowest_bin    DOUBLE PRECISION NOT NULL,
  avg_median_bin    DOUBLE PRECISION,
  avg_listing_count DOUBLE PRECISION NOT NULL,
  total_sales       INTEGER NOT NULL DEFAULT 0,
  avg_sale_price    DOUBLE PRECISION,
  sample_count      INTEGER NOT NULL,
  UNIQUE (base_item, bucket, granularity)
);

CREATE INDEX idx_auction_price_summaries_query
  ON auction_price_summaries (base_item, granularity, bucket DESC);

CREATE INDEX idx_auction_price_summaries_skyid
  ON auction_price_summaries (skyblock_id, granularity, bucket DESC)
  WHERE skyblock_id IS NOT NULL;

-- Aggregation: raw snapshots → hourly summaries, then prune
CREATE OR REPLACE FUNCTION auction_price_aggregate_and_retain()
RETURNS void AS $$
BEGIN
  INSERT INTO auction_price_summaries (
    base_item, skyblock_id, bucket, granularity,
    avg_lowest_bin, avg_median_bin, avg_listing_count,
    total_sales, avg_sale_price, sample_count
  )
  SELECT
    base_item,
    MAX(skyblock_id),
    date_trunc('hour', recorded_at),
    'hourly',
    AVG(lowest_bin),
    AVG(median_bin),
    AVG(listing_count),
    SUM(sale_count)::INTEGER,
    CASE
      WHEN SUM(sale_count) > 0
      THEN SUM(avg_sale_price * sale_count) / NULLIF(SUM(sale_count), 0)
      ELSE NULL
    END,
    COUNT(*)::INTEGER
  FROM auction_price_snapshots
  WHERE recorded_at < date_trunc('hour', NOW())
    AND recorded_at >= NOW() - INTERVAL '48 hours'
  GROUP BY base_item, date_trunc('hour', recorded_at)
  ON CONFLICT (base_item, bucket, granularity) DO UPDATE SET
    skyblock_id       = COALESCE(EXCLUDED.skyblock_id, auction_price_summaries.skyblock_id),
    avg_lowest_bin    = EXCLUDED.avg_lowest_bin,
    avg_median_bin    = EXCLUDED.avg_median_bin,
    avg_listing_count = EXCLUDED.avg_listing_count,
    total_sales       = EXCLUDED.total_sales,
    avg_sale_price    = EXCLUDED.avg_sale_price,
    sample_count      = EXCLUDED.sample_count;

  DELETE FROM auction_price_snapshots WHERE recorded_at < NOW() - INTERVAL '48 hours';
  DELETE FROM auction_price_summaries WHERE granularity = 'hourly' AND bucket < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Rebuild function: populate hourly summaries from raw data or auction_history
CREATE OR REPLACE FUNCTION auction_price_rebuild(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_granularity TEXT)
RETURNS void AS $$
DECLARE
  v_raw_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_raw_count
  FROM auction_price_snapshots
  WHERE recorded_at >= p_start AND recorded_at < p_end;

  IF v_raw_count > 0 THEN
    INSERT INTO auction_price_summaries (
      base_item, skyblock_id, bucket, granularity,
      avg_lowest_bin, avg_median_bin, avg_listing_count,
      total_sales, avg_sale_price, sample_count
    )
    SELECT
      base_item, MAX(skyblock_id),
      date_trunc('hour', recorded_at), 'hourly',
      AVG(lowest_bin), AVG(median_bin), AVG(listing_count),
      SUM(sale_count)::INTEGER,
      CASE WHEN SUM(sale_count) > 0
        THEN SUM(avg_sale_price * sale_count) / NULLIF(SUM(sale_count), 0)
        ELSE NULL END,
      COUNT(*)::INTEGER
    FROM auction_price_snapshots
    WHERE recorded_at >= p_start AND recorded_at < p_end
    GROUP BY base_item, date_trunc('hour', recorded_at)
    ON CONFLICT (base_item, bucket, granularity) DO NOTHING;
    RETURN;
  END IF;

  -- Fallback: rebuild from auction_history (sold BIN auctions)
  INSERT INTO auction_price_summaries (
    base_item, skyblock_id, bucket, granularity,
    avg_lowest_bin, avg_median_bin, avg_listing_count,
    total_sales, avg_sale_price, sample_count
  )
  SELECT
    base_item, MAX(skyblock_id),
    date_trunc('hour', ended_at), 'hourly',
    MIN(final_price)::DOUBLE PRECISION,
    AVG(final_price)::DOUBLE PRECISION,
    0,
    COUNT(*)::INTEGER,
    AVG(final_price)::DOUBLE PRECISION,
    0
  FROM auction_history
  WHERE outcome = 'sold' AND bin = true
    AND ended_at >= p_start AND ended_at < p_end
  GROUP BY base_item, date_trunc('hour', ended_at)
  ON CONFLICT (base_item, bucket, granularity) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

GRANT SELECT, INSERT, UPDATE, DELETE ON auction_price_summaries TO api_anon;
GRANT USAGE, SELECT ON SEQUENCE auction_price_summaries_id_seq TO api_anon;
GRANT EXECUTE ON FUNCTION auction_price_aggregate_and_retain() TO api_anon;
GRANT EXECUTE ON FUNCTION auction_price_rebuild(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO api_anon;
