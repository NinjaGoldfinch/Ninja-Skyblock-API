import type { HypixelProfileMember, HypixelSkyBlockProfile } from '../../src/types/hypixel.js';

export const sampleMember: HypixelProfileMember = {
  player_data: {
    experience: {
      SKILL_COMBAT: 55172015,
      SKILL_MINING: 111672425,
      SKILL_FARMING: 55172015,
      SKILL_FORAGING: 13174542,
      SKILL_FISHING: 7634885,
      SKILL_ENCHANTING: 111672425,
      SKILL_ALCHEMY: 55172015,
      SKILL_TAMING: 55172015,
      SKILL_CARPENTRY: 16842752,
      SKILL_RUNECRAFTING: 1000000,
      SKILL_SOCIAL: 500000,
    },
  },
  dungeons: {
    dungeon_types: {
      catacombs: {
        experience: 569809640,
      },
    },
    player_classes: {
      healer: { experience: 3084640 },
      mage: { experience: 569809640 },
      berserk: { experience: 51559640 },
      archer: { experience: 3084640 },
      tank: { experience: 1684640 },
    },
    secrets: 54210,
    selected_dungeon_class: 'mage',
  },
  slayer_bosses: {
    zombie: { xp: 1500000 },
    spider: { xp: 1200000 },
    wolf: { xp: 1000000 },
    enderman: { xp: 900000 },
    blaze: { xp: 500000 },
    vampire: { xp: 200 },
  },
  currencies: {
    coin_purse: 146983864.85,
  },
  sacks_counts: {
    ENCHANTED_DIAMOND: 500,
    WHEAT: 10000,
  },
};

export const sampleProfile: HypixelSkyBlockProfile = {
  profile_id: 'abc123def456',
  cute_name: 'Pomegranate',
  selected: true,
  members: {
    'd8d5a9237b2043d8883b1150148d6955': sampleMember,
  },
  banking: {
    balance: 1000000000,
    transactions: [],
  },
};

export const emptyMember: HypixelProfileMember = {};

export const emptyProfile: HypixelSkyBlockProfile = {
  profile_id: 'empty123',
  cute_name: 'Blueberry',
  selected: false,
  members: {
    'aaaa0000bbbb1111cccc2222dddd3333': emptyMember,
  },
};
