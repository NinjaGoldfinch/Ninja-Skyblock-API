import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchPlayerProfiles } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { SkyBlockProfile } from '../../../types/skyblock.js';
import type { HypixelProfilesResponse, HypixelProfileMember } from '../../../types/hypixel.js';

interface ProfileParams {
  uuid: string;
}

function extractProfile(response: HypixelProfilesResponse, uuid: string): SkyBlockProfile {
  if (!response.profiles || response.profiles.length === 0) {
    throw errors.profileNotFound(uuid);
  }

  // Find selected profile, or fall back to first
  const profile = response.profiles.find((p) => p.selected) ?? response.profiles[0];
  if (!profile) {
    throw errors.profileNotFound(uuid);
  }

  const member: HypixelProfileMember | undefined = profile.members[uuid];
  if (!member) {
    throw errors.profileNotFound(uuid);
  }

  // Extract skills from player_data.experience
  const skills: Record<string, { level: number; xp: number; progress: number }> = {};
  const experience = member.player_data?.experience ?? {};
  for (const [apiKey, xp] of Object.entries(experience)) {
    const skillName = apiKey.replace('SKILL_', '').toLowerCase();
    skills[skillName] = { level: 0, xp: xp ?? 0, progress: 0 };
  }

  // Compute skill average
  const skillValues = Object.values(skills);
  const skillAverage = skillValues.length > 0
    ? Math.round((skillValues.reduce((sum, s) => sum + s.level, 0) / skillValues.length) * 100) / 100
    : 0;

  // Extract dungeons
  const dungeonData = member.dungeons;
  const dungeons = {
    catacombs_level: 0,
    secrets_found: dungeonData?.secrets ?? 0,
    selected_class: dungeonData?.selected_dungeon_class ?? 'none',
    class_levels: { healer: 0, mage: 0, berserk: 0, archer: 0, tank: 0 },
  };

  // Extract slayers
  const slayers: Record<string, { level: number; xp: number }> = {};
  if (member.slayer_bosses) {
    for (const [boss, data] of Object.entries(member.slayer_bosses)) {
      slayers[boss] = { level: 0, xp: data.xp ?? 0 };
    }
  }

  const bankBalance = profile.banking?.balance ?? 0;

  return {
    uuid,
    profile_id: profile.profile_id,
    cute_name: profile.cute_name,
    selected: profile.selected,
    skills,
    skill_average: skillAverage,
    networth: {
      total: 0,
      breakdown: { inventory: 0, bank: bankBalance, sacks: 0, enderchest: 0, wardrobe: 0, pets: 0, accessories: 0 },
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

      // Rate limit check (use IP as client ID for now)
      const clientId = request.ip;
      await enforceClientRateLimit(clientId);

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
