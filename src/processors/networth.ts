import type { NetworthData, NetworthBreakdown } from '../types/skyblock.js';
import type { HypixelProfileMember, HypixelSkyBlockProfile } from '../types/hypixel.js';

/**
 * Compute a simplified networth estimate from raw profile data.
 *
 * This is a placeholder implementation. Full networth calculation requires:
 * - Decoding NBT inventory data (base64 → gzipped NBT → item list)
 * - Looking up current bazaar/auction prices for each item
 * - Handling enchantments, reforges, stars, gemstones for item valuation
 *
 * For now, we sum bank balance, coin purse, and sack contents value.
 * Real item-based networth will be added when bazaar/auction price
 * data is available (Phase 2).
 */
export function computeNetworth(
  uuid: string,
  member: HypixelProfileMember,
  profile: HypixelSkyBlockProfile,
): NetworthData {
  const bankBalance = profile.banking?.balance ?? 0;
  const coinPurse = member.currencies?.coin_purse ?? 0;

  // Sack contents — count items but we can't value them without price data yet
  const sacksTotal = Object.values(member.sacks_counts ?? {}).reduce((sum, count) => sum + count, 0);

  // Placeholder breakdown — real values need NBT decoding + price lookups
  const breakdown: NetworthBreakdown = {
    inventory: 0,
    bank: bankBalance,
    sacks: sacksTotal, // Item count, not coin value — placeholder
    enderchest: 0,
    wardrobe: 0,
    pets: 0,
    accessories: 0,
  };

  const total = bankBalance + coinPurse;

  return {
    uuid,
    total,
    breakdown,
    prices_as_of: Date.now(),
  };
}
