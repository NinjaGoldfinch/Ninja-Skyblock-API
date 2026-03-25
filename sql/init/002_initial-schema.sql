-- Bazaar price snapshots (raw Hypixel data for future-proof storage)
CREATE TABLE IF NOT EXISTS bazaar_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  item_id       TEXT NOT NULL,
  raw_data      JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bazaar_item_time ON bazaar_snapshots (item_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_bazaar_raw_gin ON bazaar_snapshots USING GIN (raw_data);

-- Auction sale records
CREATE TABLE IF NOT EXISTS auction_sales (
  id            BIGSERIAL PRIMARY KEY,
  auction_id    TEXT NOT NULL UNIQUE,
  item_id       TEXT NOT NULL,
  item_name     TEXT NOT NULL,
  price         BIGINT NOT NULL,
  seller_uuid   TEXT NOT NULL,
  buyer_uuid    TEXT,
  bin           BOOLEAN NOT NULL DEFAULT FALSE,
  ended_at      TIMESTAMPTZ NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auction_item_time ON auction_sales (item_id, ended_at DESC);

-- Player profile snapshots (for progression tracking)
CREATE TABLE IF NOT EXISTS player_profiles (
  id            BIGSERIAL PRIMARY KEY,
  player_uuid   TEXT NOT NULL,
  profile_uuid  TEXT NOT NULL,
  cute_name     TEXT NOT NULL,
  skill_average DOUBLE PRECISION,
  networth      DOUBLE PRECISION,
  data          JSONB NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_profile_time ON player_profiles (player_uuid, profile_uuid, recorded_at DESC);
