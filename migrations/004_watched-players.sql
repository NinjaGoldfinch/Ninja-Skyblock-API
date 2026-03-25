-- Players being tracked by the profile tracker worker
CREATE TABLE IF NOT EXISTS watched_players (
  id            BIGSERIAL PRIMARY KEY,
  player_uuid   TEXT NOT NULL UNIQUE,
  added_by      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watched_players_uuid ON watched_players (player_uuid);
