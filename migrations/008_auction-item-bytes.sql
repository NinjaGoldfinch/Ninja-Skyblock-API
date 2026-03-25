-- Store item_bytes for active auctions (too large for Redis cache)
-- Upserted on each scan cycle, deleted when auction completes
CREATE TABLE IF NOT EXISTS auction_item_data (
  auction_id    TEXT PRIMARY KEY,
  item_bytes    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
