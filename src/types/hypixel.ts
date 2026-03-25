export interface HypixelApiResponse<T> {
  success: boolean;
  cause?: string;
  data?: T;
}

export interface HypixelSkyBlockProfile {
  profile_id: string;
  cute_name: string;
  selected: boolean;
  members: Record<string, HypixelProfileMember>;
  banking?: {
    balance: number;
    transactions: Array<{
      amount: number;
      timestamp: number;
      action: string;
      initiator_name: string;
    }>;
  };
}

export interface HypixelProfileMember {
  player_data?: {
    experience?: Record<string, number>;
  };
  dungeons?: {
    dungeon_types?: {
      catacombs?: {
        experience?: number;
        tier_completions?: Record<string, number>;
      };
    };
    player_classes?: Record<string, { experience?: number }>;
    secrets?: number;
    selected_dungeon_class?: string;
  };
  slayer_bosses?: Record<string, {
    xp?: number;
    boss_kills_tier_0?: number;
    boss_kills_tier_1?: number;
    boss_kills_tier_2?: number;
    boss_kills_tier_3?: number;
    boss_kills_tier_4?: number;
  }>;
  inventory?: {
    inv_contents?: { data: string };
    ender_chest_contents?: { data: string };
    wardrobe_contents?: { data: string };
    bag_contents?: {
      talisman_bag?: { data: string };
    };
  };
  pets_data?: {
    pets?: Array<{
      type: string;
      exp: number;
      tier: string;
      heldItem: string | null;
      active: boolean;
    }>;
  };
  currencies?: {
    coin_purse?: number;
  };
  sacks_counts?: Record<string, number>;
}

export interface HypixelProfilesResponse {
  success: boolean;
  profiles: HypixelSkyBlockProfile[] | null;
}

export interface HypixelProfileResponse {
  success: boolean;
  profile: HypixelSkyBlockProfile | null;
}

export interface HypixelBazaarOrder {
  amount: number;
  pricePerUnit: number;
  orders: number;
}

export interface HypixelBazaarProduct {
  product_id: string;
  sell_summary: HypixelBazaarOrder[];
  buy_summary: HypixelBazaarOrder[];
  quick_status: {
    buyPrice: number;
    buyVolume: number;
    buyMovingWeek: number;
    buyOrders: number;
    sellPrice: number;
    sellVolume: number;
    sellMovingWeek: number;
    sellOrders: number;
  };
}

export interface HypixelBazaarResponse {
  success: boolean;
  lastUpdated: number;
  products: Record<string, HypixelBazaarProduct>;
}

export interface HypixelAuction {
  uuid: string;
  auctioneer: string;
  profile_id: string;
  start: number;
  end: number;
  item_name: string;
  item_lore: string;
  extra: string;
  category: string;
  tier: string;
  starting_bid: number;
  highest_bid_amount: number;
  bin: boolean;
  item_bytes: string;
}

export interface HypixelAuctionsPageResponse {
  success: boolean;
  page: number;
  totalPages: number;
  totalAuctions: number;
  lastUpdated: number;
  auctions: HypixelAuction[];
}
