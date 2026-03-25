import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchPlayerProfiles } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import { computeSkills } from '../../../processors/skills.js';
import { computeNetworth } from '../../../processors/networth.js';
import { SLAYER_XP_THRESHOLDS, DUNGEON_XP_THRESHOLDS } from '../../../config/constants.js';
import type { SkyBlockProfile } from '../../../types/skyblock.js';
import type { HypixelProfilesResponse, HypixelProfileMember } from '../../../types/hypixel.js';

interface ProfileParams {
  uuid: string;
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

function extractProfile(response: HypixelProfilesResponse, uuid: string): SkyBlockProfile {
  if (!response.profiles || response.profiles.length === 0) {
    throw errors.profileNotFound(uuid);
  }

  const profile = response.profiles.find((p) => p.selected) ?? response.profiles[0];
  if (!profile) {
    throw errors.profileNotFound(uuid);
  }

  const member: HypixelProfileMember | undefined = profile.members[uuid];
  if (!member) {
    throw errors.profileNotFound(uuid);
  }

  // Use processors for skills and networth
  const skillData = computeSkills(uuid, member);
  const networthData = computeNetworth(uuid, member, profile);

  // Extract dungeons
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

  // Extract slayers
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
    uuid,
    profile_id: profile.profile_id,
    cute_name: profile.cute_name,
    selected: profile.selected,
    skills: skillData.skills,
    skill_average: skillData.skill_average,
    networth: {
      total: networthData.total,
      breakdown: networthData.breakdown,
    },
    dungeons,
    slayers,
    bank_balance: bankBalance,
  };
}

export async function profileRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: ProfileParams }>(
    '/v1/skyblock/profile/:uuid',
    {
      schema: {
        params: {
          type: 'object',
          required: ['uuid'],
          properties: {
            uuid: { type: 'string', pattern: '^[a-f0-9]{32}$' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ProfileParams }>, reply) => {
      const { uuid } = request.params;

      // Rate limit check
      await enforceClientRateLimit(request.clientId);

      // Cache check
      const cached = await cacheGet<SkyBlockProfile>('hot', 'profile', uuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      // If stale, return stale data but trigger background refresh
      if (cached && cached.stale) {
        // Fire-and-forget background refresh
        fetchAndCache(uuid).catch(() => {
          // Silently ignore — stale data was already returned
        });
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      // Cache miss — fetch from Hypixel
      const profileData = await fetchAndCache(uuid);

      void reply; // satisfy unused param lint
      return {
        success: true,
        data: profileData,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCache(uuid: string): Promise<SkyBlockProfile> {
  const response = await fetchPlayerProfiles(uuid);
  const profileData = extractProfile(response, uuid);
  await cacheSet('hot', 'profile', uuid, profileData);
  return profileData;
}
