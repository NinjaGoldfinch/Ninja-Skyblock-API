export interface SkillInfo {
  level: number;
  xp: number;
  progress: number;
}

export interface SkillData {
  uuid: string;
  skill_average: number;
  total_xp: number;
  skills: Record<string, SkillInfo>;
}

export interface NetworthBreakdown {
  inventory: number;
  bank: number;
  sacks: number;
  enderchest: number;
  wardrobe: number;
  pets: number;
  accessories: number;
}

export interface NetworthData {
  uuid: string;
  total: number;
  breakdown: NetworthBreakdown;
  prices_as_of: number;
}

export interface DungeonClassLevels {
  healer: number;
  mage: number;
  berserk: number;
  archer: number;
  tank: number;
}

export interface DungeonData {
  catacombs_level: number;
  secrets_found: number;
  selected_class: string;
  class_levels: DungeonClassLevels;
}

export interface SlayerInfo {
  level: number;
  xp: number;
}

export interface SkyBlockProfile {
  uuid: string;
  profile_id: string;
  cute_name: string;
  selected: boolean;
  skills: Record<string, SkillInfo>;
  skill_average: number;
  networth: {
    total: number;
    breakdown: NetworthBreakdown;
  };
  dungeons: DungeonData;
  slayers: Record<string, SlayerInfo>;
  bank_balance: number;
}
