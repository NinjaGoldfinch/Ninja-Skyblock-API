-- Add item_bytes and item_lore to auction_history for rendering modifiers
ALTER TABLE auction_history ADD COLUMN IF NOT EXISTS item_bytes TEXT;
ALTER TABLE auction_history ADD COLUMN IF NOT EXISTS item_lore TEXT;
