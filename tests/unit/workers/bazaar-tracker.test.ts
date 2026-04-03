import { describe, it, expect } from 'vitest';
import { formatProductId } from '../../../src/workers/bazaar-tracker.js';

describe('formatProductId', () => {
  describe('enchantments', () => {
    it('formats regular enchantment with roman numeral', () => {
      expect(formatProductId('ENCHANTMENT_SHARPNESS_7')).toBe('Sharpness VII');
    });

    it('formats ultimate enchantment with roman numeral', () => {
      expect(formatProductId('ENCHANTMENT_ULTIMATE_CHIMERA_5')).toBe('Chimera V');
    });

    it('formats enchantment level 1', () => {
      expect(formatProductId('ENCHANTMENT_PROTECTION_1')).toBe('Protection I');
    });

    it('formats enchantment level 10', () => {
      expect(formatProductId('ENCHANTMENT_GROWTH_10')).toBe('Growth X');
    });

    it('formats multi-word enchantment', () => {
      expect(formatProductId('ENCHANTMENT_FIRE_ASPECT_2')).toBe('Fire Aspect II');
    });

    it('formats multi-word ultimate enchantment', () => {
      expect(formatProductId('ENCHANTMENT_ULTIMATE_ONE_FOR_ALL_1')).toBe('One For All I');
    });

    it('leaves non-numeric trailing word as title case', () => {
      // If an enchantment ends with a non-numeric word, it stays as-is
      expect(formatProductId('ENCHANTMENT_TELEKINESIS')).toBe('Telekinesis');
    });
  });

  describe('essences', () => {
    it('formats dragon essence', () => {
      expect(formatProductId('ESSENCE_DRAGON')).toBe('Dragon Essence');
    });

    it('formats wither essence', () => {
      expect(formatProductId('ESSENCE_WITHER')).toBe('Wither Essence');
    });

    it('formats undead essence', () => {
      expect(formatProductId('ESSENCE_UNDEAD')).toBe('Undead Essence');
    });
  });

  describe('regular items', () => {
    it('formats simple item', () => {
      expect(formatProductId('DIAMOND')).toBe('Diamond');
    });

    it('formats multi-word item', () => {
      expect(formatProductId('ENCHANTED_DIAMOND')).toBe('Enchanted Diamond');
    });

    it('formats item with multiple underscores', () => {
      expect(formatProductId('RAW_GOLDEN_CARROT')).toBe('Raw Golden Carrot');
    });

    it('does not convert trailing numbers to roman numerals for non-enchantments', () => {
      // Regular items should keep numeric suffixes as title-cased words
      expect(formatProductId('LOG_2')).toBe('Log 2');
    });
  });
});
