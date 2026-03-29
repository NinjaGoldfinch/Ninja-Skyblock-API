-- Aggregate bazaar prices for a given item over a time range
-- Returns hourly averages computed from flat numeric columns
CREATE OR REPLACE FUNCTION aggregate_bazaar_hourly(
  p_item_id TEXT,
  p_hours INTEGER DEFAULT 24
)
RETURNS TABLE (
  hour TIMESTAMPTZ,
  avg_buy_price DOUBLE PRECISION,
  avg_sell_price DOUBLE PRECISION,
  avg_buy_volume BIGINT,
  avg_sell_volume BIGINT,
  sample_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('hour', bs.recorded_at) AS hour,
    AVG(bs.avg_buy) AS avg_buy_price,
    AVG(bs.avg_sell) AS avg_sell_price,
    AVG(bs.buy_volume)::BIGINT AS avg_buy_volume,
    AVG(bs.sell_volume)::BIGINT AS avg_sell_volume,
    COUNT(*)::BIGINT AS sample_count
  FROM bazaar_snapshots bs
  WHERE bs.item_id = p_item_id
    AND bs.recorded_at >= NOW() - (p_hours || ' hours')::INTERVAL
  GROUP BY date_trunc('hour', bs.recorded_at)
  ORDER BY hour ASC;
END;
$$ LANGUAGE plpgsql STABLE;
