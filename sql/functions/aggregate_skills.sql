-- Get skill average history for a player across snapshots
CREATE OR REPLACE FUNCTION skill_average_history(
  p_player_uuid TEXT,
  p_profile_uuid TEXT,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  recorded_at TIMESTAMPTZ,
  skill_average DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pp.recorded_at,
    pp.skill_average
  FROM player_profiles pp
  WHERE pp.player_uuid = p_player_uuid
    AND pp.profile_uuid = p_profile_uuid
    AND pp.recorded_at >= NOW() - (p_days || ' days')::INTERVAL
  ORDER BY pp.recorded_at ASC;
END;
$$ LANGUAGE plpgsql STABLE;
