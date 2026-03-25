-- Drop old auction_sales table and replace with comprehensive auction history
DROP TABLE IF EXISTS auction_sales;

CREATE TABLE IF NOT EXISTS auction_history (
  auction_id    TEXT NOT NULL,
  skyblock_id   TEXT,
  base_item     TEXT NOT NULL,
  item_name     TEXT NOT NULL,
  seller_uuid   TEXT NOT NULL,
  buyer_uuid    TEXT,
  starting_bid  BIGINT NOT NULL,
  final_price   BIGINT NOT NULL,
  bin           BOOLEAN NOT NULL DEFAULT FALSE,
  tier          TEXT,
  category      TEXT,
  outcome       TEXT NOT NULL DEFAULT 'sold',  -- 'sold', 'expired', 'cancelled'
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (auction_id)
);

-- Query patterns: item sales history, player sales, price tracking
CREATE INDEX IF NOT EXISTS idx_ah_skyblock_id_ended ON auction_history (skyblock_id, ended_at DESC) WHERE skyblock_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ah_base_item_ended ON auction_history (base_item, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_ah_seller ON auction_history (seller_uuid, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_ah_outcome ON auction_history (outcome, ended_at DESC);
