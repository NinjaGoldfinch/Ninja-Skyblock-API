import { describe, it, expect } from 'vitest';
import { computeNetworth } from '../../../src/processors/networth.js';
import { sampleMember, sampleProfile, emptyMember, emptyProfile } from '../../helpers/fixtures.js';

describe('computeNetworth', () => {
  it('computes total from bank balance and coin purse', () => {
    const result = computeNetworth('test-uuid', sampleMember, sampleProfile);

    expect(result.uuid).toBe('test-uuid');
    // bank (1B) + coin purse (146.9M)
    expect(result.total).toBe(1000000000 + 146983864.85);
  });

  it('includes bank balance in breakdown', () => {
    const result = computeNetworth('test-uuid', sampleMember, sampleProfile);

    expect(result.breakdown.bank).toBe(1000000000);
  });

  it('includes sack item counts in breakdown', () => {
    const result = computeNetworth('test-uuid', sampleMember, sampleProfile);

    // Sacks should have the sum of item counts (not coin value yet)
    expect(result.breakdown.sacks).toBe(10500); // 500 + 10000
  });

  it('sets prices_as_of to current timestamp', () => {
    const before = Date.now();
    const result = computeNetworth('test-uuid', sampleMember, sampleProfile);
    const after = Date.now();

    expect(result.prices_as_of).toBeGreaterThanOrEqual(before);
    expect(result.prices_as_of).toBeLessThanOrEqual(after);
  });

  it('returns zero for empty profile', () => {
    const result = computeNetworth('test-uuid', emptyMember, emptyProfile);

    expect(result.total).toBe(0);
    expect(result.breakdown.bank).toBe(0);
    expect(result.breakdown.inventory).toBe(0);
    expect(result.breakdown.sacks).toBe(0);
  });

  it('handles missing banking data', () => {
    const profileNoBanking: typeof sampleProfile = {
      ...sampleProfile,
      banking: undefined,
    };
    const result = computeNetworth('test-uuid', sampleMember, profileNoBanking);

    expect(result.breakdown.bank).toBe(0);
    // Total should just be coin purse
    expect(result.total).toBe(146983864.85);
  });
});
