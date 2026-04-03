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

export interface HypixelPlayerAuctionsResponse {
  success: boolean;
  auctions: HypixelAuction[];
}

export interface HypixelEndedAuction {
  auction_id: string;
  seller: string;
  seller_profile: string;
  buyer: string;
  timestamp: number;
  price: number;
  bin: boolean;
  item_bytes: string;
}

export interface HypixelEndedAuctionsResponse {
  success: boolean;
  lastUpdated: number;
  auctions: HypixelEndedAuction[];
}

export interface HypixelAuctionsPageResponse {
  success: boolean;
  page: number;
  totalPages: number;
  totalAuctions: number;
  lastUpdated: number;
  auctions: HypixelAuction[];
}

// Resource endpoints (static/semi-static reference data)

export interface HypixelCollectionsResponse {
  success: boolean;
  lastUpdated: number;
  version: string;
  collections: Record<string, {
    name: string;
    maxTiers: number;
    items: Record<string, {
      name: string;
      maxTiers: number;
      tiers: Array<{
        tier: number;
        amountRequired: number;
        unlocks: string[];
      }>;
    }>;
  }>;
}

export interface HypixelSkillsResponse {
  success: boolean;
  lastUpdated: number;
  version: string;
  skills: Record<string, {
    name: string;
    description: string;
    maxLevel: number;
    levels: Array<{
      level: number;
      totalExpRequired: number;
      unlocks: string[];
    }>;
  }>;
}

export interface HypixelItemsResponse {
  success: boolean;
  lastUpdated: number;
  items: Array<{
    id: string;
    material: string;
    name: string;
    tier?: string;
    category?: string;
    npc_sell_price?: number;
    color?: string;
    skin?: string | { value: string; signature?: string };
    durability?: number;
    item_model?: string;
    glowing?: boolean;
    museum?: boolean;
    [key: string]: unknown;
  }>;
}

export interface HypixelMuseumResponse {
  success: boolean;
  members: Record<string, {
    items?: Record<string, unknown>;
    special?: unknown[];
  }>;
}

export interface HypixelGardenResponse {
  success: boolean;
  garden: Record<string, unknown> | null;
}

export interface HypixelBingoResponse {
  success: boolean;
  events: Array<{
    key: number;
    points: number;
    completed_goals: string[];
  }>;
}

export interface HypixelFireSalesResponse {
  success: boolean;
  sales: Array<{
    item_id: string;
    start: number;
    end: number;
    amount: number;
    price: number;
  }>;
}

export interface HypixelNewsResponse {
  success: boolean;
  items: Array<{
    title: string;
    link: string;
    text: string;
    item: {
      material: string;
      data?: number;
    };
  }>;
}

export interface HypixelBingoGoalsResponse {
  success: boolean;
  lastUpdated: number;
  goals: Array<{
    id: string;
    name: string;
    lore: string;
    tiers?: number[];
    progress?: number;
    requiredAmount?: number;
  }>;
}

export interface HypixelElectionResponse {
  success: boolean;
  lastUpdated: number;
  mayor: {
    key: string;
    name: string;
    perks: Array<{
      name: string;
      description: string;
    }>;
    election: {
      year: number;
      candidates: Array<{
        key: string;
        name: string;
        perks: Array<{
          name: string;
          description: string;
        }>;
        votes: number;
      }>;
    };
  };
  current?: {
    year: number;
    candidates: Array<{
      key: string;
      name: string;
      perks: Array<{
        name: string;
        description: string;
      }>;
      votes: number;
    }>;
  };
}
