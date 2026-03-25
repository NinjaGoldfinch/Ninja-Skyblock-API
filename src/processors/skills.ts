import { SKILL_XP_THRESHOLDS, SKILL_NAMES, HYPIXEL_SKILL_MAP } from '../config/constants.js';
import type { SkillData, SkillInfo } from '../types/skyblock.js';
import type { HypixelProfileMember } from '../types/hypixel.js';

function computeSkillLevel(xp: number, thresholds: readonly number[]): { level: number; progress: number } {
  let level = 0;
  for (let i = 1; i < thresholds.length; i++) {
    const threshold = thresholds[i];
    if (threshold === undefined || xp < threshold) {
      break;
    }
    level = i;
  }

  // Compute progress toward next level
  const maxLevel = thresholds.length - 1;
  if (level >= maxLevel) {
    return { level, progress: 1.0 };
  }

  const currentThreshold = thresholds[level] ?? 0;
  const nextThreshold = thresholds[level + 1];
  if (nextThreshold === undefined) {
    return { level, progress: 1.0 };
  }

  const xpIntoLevel = xp - currentThreshold;
  const xpForNextLevel = nextThreshold - currentThreshold;
  const progress = Math.round((xpIntoLevel / xpForNextLevel) * 100) / 100;

  return { level, progress: Math.min(1.0, Math.max(0, progress)) };
}

export function computeSkills(uuid: string, member: HypixelProfileMember): SkillData {
  const experience = member.player_data?.experience ?? {};
  const skills: Record<string, SkillInfo> = {};
  let totalXp = 0;

  for (const [apiKey, displayName] of Object.entries(HYPIXEL_SKILL_MAP)) {
    const xp = experience[apiKey] ?? 0;
    const { level, progress } = computeSkillLevel(xp, SKILL_XP_THRESHOLDS);
    skills[displayName] = { level, xp, progress };
    totalXp += xp;
  }

  // Compute skill average using only the main skills (excluding runecrafting, social)
  let sumLevels = 0;
  let count = 0;
  for (const name of SKILL_NAMES) {
    const skill = skills[name];
    if (skill) {
      sumLevels += skill.level;
      count++;
    }
  }

  const skillAverage = count > 0
    ? Math.round((sumLevels / count) * 100) / 100
    : 0;

  return {
    uuid,
    skill_average: skillAverage,
    total_xp: totalXp,
    skills,
  };
}
