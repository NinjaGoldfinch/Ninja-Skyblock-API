// Hypixel API
export const HYPIXEL_BASE_URL = 'https://api.hypixel.net';
export const HYPIXEL_RATE_LIMIT_PER_MIN = 120;

// Cache tiers
export const CACHE_PREFIX_HOT = 'cache:hot';
export const CACHE_PREFIX_WARM = 'cache:warm';

// Rate limit prefixes
export const RATE_PREFIX_CLIENT = 'rate:client';
export const RATE_PREFIX_HYPIXEL = 'rate:hypixel';

// Stale-while-revalidate: serve stale data for this multiple of the TTL
export const STALE_MULTIPLIER = 2;

// Skill XP thresholds (cumulative XP required for each level, 0-60)
// Source: Hypixel SkyBlock wiki
export const SKILL_XP_THRESHOLDS: readonly number[] = [
  0, 50, 175, 375, 675, 1175, 1925, 2925, 4425, 6425, 9925,
  14925, 22425, 32425, 47425, 67425, 97425, 147425, 222425, 322425, 447425,
  597425, 797425, 1047425, 1347425, 1697425, 2097425, 2547425, 3047425, 3647425, 4347425,
  5147425, 6047425, 7047425, 8147425, 9347425, 10647425, 12047425, 13547425, 15147425, 16847425,
  18647425, 20547425, 22547425, 24647425, 26847425, 29147425, 31547425, 34047425, 36647425, 39347425,
  42147425, 45047425, 48047425, 51147425, 54347425, 57647425, 61047425, 64547425, 68147425, 71847425,
];

// Dungeon (Catacombs) XP thresholds
export const DUNGEON_XP_THRESHOLDS: readonly number[] = [
  0, 50, 125, 235, 395, 625, 955, 1425, 2095, 3045, 4385,
  6275, 8940, 12700, 17960, 25340, 35640, 50040, 70040, 97640, 135640,
  188140, 259640, 356640, 488640, 668640, 911640, 1239640, 1684640, 2284640, 3084640,
  4149640, 5559640, 7459640, 9959640, 13259640, 17559640, 23159640, 30359640, 39559640, 51559640,
  66559640, 85559640, 109559640, 139559640, 177559640, 225559640, 285559640, 360559640, 453559640, 569809640,
];

// Slayer XP thresholds by type
export const SLAYER_XP_THRESHOLDS: Record<string, readonly number[]> = {
  zombie: [0, 5, 15, 200, 1000, 5000, 20000, 100000, 400000, 1000000],
  spider: [0, 5, 25, 200, 1000, 5000, 20000, 100000, 400000, 1000000],
  wolf: [0, 10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000],
  enderman: [0, 10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000],
  blaze: [0, 10, 30, 250, 1500, 5000, 20000, 100000, 400000, 1000000],
  vampire: [0, 20, 75, 240, 840, 2400],
};

// Skill names used for skill average computation
export const SKILL_NAMES = [
  'combat', 'mining', 'farming', 'foraging', 'fishing',
  'enchanting', 'alchemy', 'taming', 'carpentry',
] as const;

// Hypixel API skill name mapping (API field -> display name)
export const HYPIXEL_SKILL_MAP: Record<string, string> = {
  'SKILL_COMBAT': 'combat',
  'SKILL_MINING': 'mining',
  'SKILL_FARMING': 'farming',
  'SKILL_FORAGING': 'foraging',
  'SKILL_FISHING': 'fishing',
  'SKILL_ENCHANTING': 'enchanting',
  'SKILL_ALCHEMY': 'alchemy',
  'SKILL_TAMING': 'taming',
  'SKILL_CARPENTRY': 'carpentry',
  'SKILL_RUNECRAFTING': 'runecrafting',
  'SKILL_SOCIAL': 'social',
};
