-- Add index on buyer_uuid for auction_history lookups
CREATE INDEX IF NOT EXISTS idx_auction_history_buyer
  ON auction_history (buyer_uuid, ended_at DESC)
  WHERE buyer_uuid IS NOT NULL;
