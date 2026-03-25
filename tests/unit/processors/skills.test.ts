import { describe, it, expect } from 'vitest';
import { computeSkills } from '../../../src/processors/skills.js';
import { sampleMember, emptyMember } from '../../helpers/fixtures.js';

describe('computeSkills', () => {
  it('computes skill levels from XP thresholds', () => {
    const result = computeSkills('test-uuid', sampleMember);

    expect(result.uuid).toBe('test-uuid');
    expect(result.skills.combat).toBeDefined();
    expect(result.skills.combat.xp).toBe(55172015);
    expect(result.skills.combat.level).toBeGreaterThan(0);
    expect(result.skills.combat.progress).toBeGreaterThanOrEqual(0);
    expect(result.skills.combat.progress).toBeLessThanOrEqual(1);
  });

  it('computes mining at level 60 (max) with progress 1.0', () => {
    const result = computeSkills('test-uuid', sampleMember);

    // 111672425 XP should be level 60 (max)
    expect(result.skills.mining.level).toBe(60);
    expect(result.skills.mining.progress).toBe(1.0);
  });

  it('computes skill average across main skills only', () => {
    const result = computeSkills('test-uuid', sampleMember);

    expect(result.skill_average).toBeGreaterThan(0);
    expect(result.skill_average).toBeLessThanOrEqual(60);
    // Should be a number with at most 2 decimal places
    expect(result.skill_average).toBe(Math.round(result.skill_average * 100) / 100);
  });

  it('computes total XP across all skills', () => {
    const result = computeSkills('test-uuid', sampleMember);

    expect(result.total_xp).toBeGreaterThan(0);
    // Should be sum of all skill XPs including runecrafting and social
    const expectedTotal = Object.values(sampleMember.player_data!.experience!).reduce((s, x) => s + x, 0);
    expect(result.total_xp).toBe(expectedTotal);
  });

  it('returns zeros for empty member', () => {
    const result = computeSkills('test-uuid', emptyMember);

    expect(result.skill_average).toBe(0);
    expect(result.total_xp).toBe(0);
    // All skills exist but with 0 XP and level 0
    for (const skill of Object.values(result.skills)) {
      expect(skill.level).toBe(0);
      expect(skill.xp).toBe(0);
    }
  });

  it('excludes runecrafting and social from skill average', () => {
    const result = computeSkills('test-uuid', sampleMember);

    // runecrafting and social should exist in skills but not affect the average
    expect(result.skills.runecrafting).toBeDefined();
    expect(result.skills.social).toBeDefined();

    // Verify average only uses 9 main skills
    const mainSkills = ['combat', 'mining', 'farming', 'foraging', 'fishing', 'enchanting', 'alchemy', 'taming', 'carpentry'];
    const mainSum = mainSkills.reduce((s, name) => s + (result.skills[name]?.level ?? 0), 0);
    const expectedAvg = Math.round((mainSum / mainSkills.length) * 100) / 100;
    expect(result.skill_average).toBe(expectedAvg);
  });
});
