import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchPlayerProfiles } from '../services/hypixel-client.js';
import { postgrestSelect, postgrestInsert } from '../services/postgrest-client.js';
import { publish } from '../services/event-bus.js';
import { computeSkills } from '../processors/skills.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelProfileMember } from '../types/hypixel.js';

const log = createLogger('profile-tracker');
const QUEUE_NAME = 'profile-tracker';

interface WatchedPlayer {
  player_uuid: string;
}

interface ProfileSnapshotRow {
  player_uuid: string;
  profile_uuid: string;
  cute_name: string;
  skill_average: number;
  networth: number;
  data: string; // JSONB
}

interface StoredSnapshot {
  player_uuid: string;
  profile_uuid: string;
  skill_average: number;
  networth: number;
  data: Record<string, unknown>;
}

async function getWatchedPlayers(): Promise<string[]> {
  try {
    const rows = await postgrestSelect<WatchedPlayer>({
      table: 'watched_players',
      select: 'player_uuid',
    });
    return rows.map((r) => r.player_uuid);
  } catch {
    // Table may not exist yet — return empty
    return [];
  }
}

async function getLastSnapshot(playerUuid: string, profileUuid: string): Promise<StoredSnapshot | null> {
  try {
    const rows = await postgrestSelect<StoredSnapshot>({
      table: 'player_profiles',
      query: {
        player_uuid: `eq.${playerUuid}`,
        profile_uuid: `eq.${profileUuid}`,
      },
      order: 'recorded_at.desc',
      limit: 1,
    });
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function detectChanges(
  _playerUuid: string,
  _profileUuid: string,
  oldSkillAvg: number,
  newSkillAvg: number,
  _member: HypixelProfileMember,
): string[] {
  const changes: string[] = [];

  if (newSkillAvg > oldSkillAvg) {
    changes.push(`skill_average: ${oldSkillAvg} → ${newSkillAvg}`);
  }

  return changes;
}

async function processProfileJob(_job: Job): Promise<void> {
  const startTime = Date.now();
  const watchedPlayers = await getWatchedPlayers();

  if (watchedPlayers.length === 0) {
    log.debug('No watched players, skipping profile poll');
    return;
  }

  let profilesUpdated = 0;
  let changesDetected = 0;

  for (const playerUuid of watchedPlayers) {
    try {
      const response = await fetchPlayerProfiles(playerUuid);
      if (!response.profiles || response.profiles.length === 0) continue;

      for (const profile of response.profiles) {
        const member = profile.members[playerUuid];
        if (!member) continue;

        const skillData = computeSkills(playerUuid, member);
        const bankBalance = profile.banking?.balance ?? 0;

        // Get previous snapshot
        const lastSnapshot = await getLastSnapshot(playerUuid, profile.profile_id);

        // Detect changes
        if (lastSnapshot) {
          const changes = detectChanges(
            playerUuid,
            profile.profile_id,
            lastSnapshot.skill_average,
            skillData.skill_average,
            member,
          );
          if (changes.length > 0) {
            await publish('profile:changes', {
              type: 'profile:change',
              player_uuid: playerUuid,
              profile_uuid: profile.profile_id,
              changes,
              timestamp: Date.now(),
            });
            changesDetected += changes.length;
          }
        }

        // Store snapshot
        const snapshotRow: ProfileSnapshotRow = {
          player_uuid: playerUuid,
          profile_uuid: profile.profile_id,
          cute_name: profile.cute_name,
          skill_average: skillData.skill_average,
          networth: bankBalance,
          data: JSON.stringify({
            skills: skillData.skills,
            bank_balance: bankBalance,
          }),
        };

        try {
          await postgrestInsert('player_profiles', snapshotRow);
          profilesUpdated++;
        } catch (err) {
          log.error({ err, playerUuid }, 'Failed to insert profile snapshot');
        }
      }
    } catch (err) {
      log.warn({ err, playerUuid }, 'Failed to fetch profiles for watched player');
    }
  }

  log.info({
    watched_players: watchedPlayers.length,
    profiles_updated: profilesUpdated,
    changes_detected: changesDetected,
    duration_ms: Date.now() - startTime,
  }, 'Profile poll complete');
}

export function startProfileTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'profile-poll',
    { every: env.PROFILE_POLL_INTERVAL },
    { name: 'profile-poll' },
  );

  createWorker(QUEUE_NAME, processProfileJob);

  // Fetch immediately on startup
  queue.add('profile-poll-immediate', {}, { priority: 1 });
}
