import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchProfile } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import { computeSkills } from '../../../processors/skills.js';
import { computeNetworth } from '../../../processors/networth.js';
import { SLAYER_XP_THRESHOLDS, DUNGEON_XP_THRESHOLDS } from '../../../config/constants.js';
import type { SkyBlockProfile } from '../../../types/skyblock.js';
import type { HypixelProfileResponse, HypixelProfileMember, HypixelSkyBlockProfile } from '../../../types/hypixel.js';

interface ProfileParams {
  profileUuid: string;
}

function computeSlayerLevel(xp: number, thresholds: readonly number[]): number {
  let level = 0;
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] === undefined || xp < (thresholds[i] as number)) break;
    level = i;
  }
  return level;
}

function computeDungeonLevel(xp: number): number {
  let level = 0;
  for (let i = 1; i < DUNGEON_XP_THRESHOLDS.length; i++) {
    if (DUNGEON_XP_THRESHOLDS[i] === undefined || xp < (DUNGEON_XP_THRESHOLDS[i] as number)) break;
    level = i;
  }
  return level;
}

function buildProfileData(profile: HypixelSkyBlockProfile, memberUuid: string, member: HypixelProfileMember): SkyBlockProfile {
  const skillData = computeSkills(memberUuid, member);
  const networthData = computeNetworth(memberUuid, member, profile);

  const dungeonData = member.dungeons;
  const catacombsXp = dungeonData?.dungeon_types?.catacombs?.experience ?? 0;
  const dungeons = {
    catacombs_level: computeDungeonLevel(catacombsXp),
    secrets_found: dungeonData?.secrets ?? 0,
    selected_class: dungeonData?.selected_dungeon_class ?? 'none',
    class_levels: {
      healer: computeDungeonLevel(dungeonData?.player_classes?.['healer']?.experience ?? 0),
      mage: computeDungeonLevel(dungeonData?.player_classes?.['mage']?.experience ?? 0),
      berserk: computeDungeonLevel(dungeonData?.player_classes?.['berserk']?.experience ?? 0),
      archer: computeDungeonLevel(dungeonData?.player_classes?.['archer']?.experience ?? 0),
      tank: computeDungeonLevel(dungeonData?.player_classes?.['tank']?.experience ?? 0),
    },
  };

  const slayers: Record<string, { level: number; xp: number }> = {};
  if (member.slayer_bosses) {
    for (const [boss, data] of Object.entries(member.slayer_bosses)) {
      const xp = data.xp ?? 0;
      const thresholds = SLAYER_XP_THRESHOLDS[boss] ?? SLAYER_XP_THRESHOLDS['zombie'] ?? [];
      slayers[boss] = { level: computeSlayerLevel(xp, thresholds), xp };
    }
  }

  const bankBalance = profile.banking?.balance ?? 0;

  return {
    uuid: memberUuid,
    profile_id: profile.profile_id,
    cute_name: profile.cute_name,
    selected: profile.selected,
    skills: skillData.skills,
    skill_average: skillData.skill_average,
    networth: { total: networthData.total, breakdown: networthData.breakdown },
    dungeons,
    slayers,
    bank_balance: bankBalance,
  };
}

function extractProfile(response: HypixelProfileResponse, profileUuid: string): SkyBlockProfile {
  if (!response.profile) {
    throw errors.profileNotFound(profileUuid);
  }
  const profile = response.profile;
  const memberEntries = Object.entries(profile.members);
  if (memberEntries.length === 0) {
    throw errors.profileNotFound(profileUuid);
  }
  const [memberUuid, member] = memberEntries[0] as [string, HypixelProfileMember];
  return buildProfileData(profile, memberUuid, member);
}

export async function v2ProfileRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: ProfileParams }>(
    '/v2/skyblock/profile/:profileUuid',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get processed SkyBlock profile',
        description: 'Returns a processed profile with computed skill levels, networth, dungeon stats, and slayer levels.',
        params: {
          type: 'object',
          required: ['profileUuid'],
          properties: {
            profileUuid: {
              type: 'string',
              pattern: '^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$',
              description: 'SkyBlock profile UUID (with or without hyphens).',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true },
              meta: { $ref: 'response-meta#' },
            },
          },
          404: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ProfileParams }>) => {
      const profileUuid = request.params.profileUuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<SkyBlockProfile>('hot', 'v2-profile', profileUuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCache(profileUuid).catch(() => {});
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const profileData = await fetchAndCache(profileUuid);
      return {
        success: true,
        data: profileData,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCache(profileUuid: string): Promise<SkyBlockProfile> {
  const response = await fetchProfile(profileUuid);
  const profileData = extractProfile(response, profileUuid);
  await cacheSet('hot', 'v2-profile', profileUuid, profileData);
  return profileData;
}
