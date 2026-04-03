/**
 * Texture coverage audit — fetches real Hypixel items data and checks
 * that every item produces valid texture rendering data.
 *
 * Run: npx vitest run tests/audit/texture-coverage.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { decodeSkinUrl, parseColor, classifyTextureType } from '../../src/utils/texture.js';

interface HypixelItem {
  id: string;
  name: string;
  material: string;
  tier?: string;
  category?: string;
  skin?: string | { value: string; signature?: string };
  color?: string;
  durability?: number;
  item_model?: string;
  glowing?: boolean;
  [key: string]: unknown;
}

let items: HypixelItem[] = [];

beforeAll(async () => {
  const res = await fetch('https://api.hypixel.net/v2/resources/skyblock/items');
  const json = await res.json() as { success: boolean; items: HypixelItem[] };
  expect(json.success).toBe(true);
  items = json.items;
}, 15_000);

describe('texture coverage audit', () => {
  it('fetched items from Hypixel API', () => {
    expect(items.length).toBeGreaterThan(0);
    console.log(`\n  Total items from Hypixel: ${items.length}`);
  });

  it('every item classifies to a texture type', () => {
    const counts = { vanilla: 0, skull: 0, leather: 0, item_model: 0 };
    for (const item of items) {
      const type = classifyTextureType(item);
      counts[type]++;
    }
    console.log('\n  Texture type distribution:');
    console.log(`    vanilla:    ${counts.vanilla}`);
    console.log(`    skull:      ${counts.skull}`);
    console.log(`    leather:    ${counts.leather}`);
    console.log(`    item_model: ${counts.item_model}`);

    expect(counts.vanilla + counts.skull + counts.leather + counts.item_model).toBe(items.length);
  });

  it('all skull items have a decodable skin_url', () => {
    const skullItems = items.filter((i) => classifyTextureType(i) === 'skull');
    const missing: string[] = [];

    for (const item of skullItems) {
      const url = decodeSkinUrl(item.skin!);
      if (!url) missing.push(item.id);
    }

    if (missing.length > 0) {
      console.log(`\n  Skull items with MISSING/undecodable skin_url (${missing.length}):`);
      for (const id of missing) console.log(`    - ${id}`);
    } else {
      console.log(`\n  All ${skullItems.length} skull items have valid skin_url`);
    }

    expect(missing).toEqual([]);
  });

  it('all leather items have a parseable color', () => {
    const leatherItems = items.filter((i) => classifyTextureType(i) === 'leather');
    const missing: string[] = [];

    for (const item of leatherItems) {
      const color = parseColor(item.color!);
      if (!color) missing.push(item.id);
    }

    if (missing.length > 0) {
      console.log(`\n  Leather items with MISSING/invalid color (${missing.length}):`);
      for (const id of missing) console.log(`    - ${id}`);
    } else {
      console.log(`\n  All ${leatherItems.length} leather items have valid color`);
    }

    expect(missing).toEqual([]);
  });

  it('all item_model items have a model key', () => {
    const modelItems = items.filter((i) => classifyTextureType(i) === 'item_model');
    const missing: string[] = [];

    for (const item of modelItems) {
      if (!item.item_model) missing.push(item.id);
    }

    if (missing.length > 0) {
      console.log(`\n  item_model items with MISSING model key (${missing.length}):`);
      for (const id of missing) console.log(`    - ${id}`);
    } else {
      console.log(`\n  All ${modelItems.length} item_model items have valid model key`);
    }

    expect(missing).toEqual([]);
  });

  it('logs all unique vanilla materials the frontend needs sprites for', () => {
    const vanillaItems = items.filter((i) => classifyTextureType(i) === 'vanilla');

    // Collect unique material + durability combos
    const spriteKeys = new Set<string>();
    for (const item of vanillaItems) {
      const key = item.durability !== undefined && item.durability !== 0
        ? `${item.material}:${item.durability}`
        : item.material;
      spriteKeys.add(key);
    }

    const sorted = [...spriteKeys].sort();
    console.log(`\n  Unique vanilla sprite keys needed (${sorted.length}):`);
    for (const key of sorted) console.log(`    ${key}`);
  });

  it('logs all unique item_model keys the frontend needs sprites for', () => {
    const modelItems = items.filter((i) => classifyTextureType(i) === 'item_model');
    const modelKeys = new Set<string>();
    for (const item of modelItems) {
      if (item.item_model) modelKeys.add(item.item_model);
    }

    const sorted = [...modelKeys].sort();
    console.log(`\n  Unique item_model sprite keys needed (${sorted.length}):`);
    for (const key of sorted) console.log(`    ${key}`);
  });

  it('logs items with glowing flag', () => {
    const glowing = items.filter((i) => i.glowing === true);
    console.log(`\n  Items with glowing=true: ${glowing.length}`);
  });

  it('summary: items with no usable texture data', () => {
    const problems: { id: string; name: string; reason: string }[] = [];

    for (const item of items) {
      const type = classifyTextureType(item);

      if (type === 'skull') {
        const url = decodeSkinUrl(item.skin!);
        if (!url) problems.push({ id: item.id, name: item.name, reason: 'skull but skin_url decode failed' });
      } else if (type === 'leather') {
        const color = parseColor(item.color!);
        if (!color) problems.push({ id: item.id, name: item.name, reason: 'leather but color parse failed' });
      } else if (type === 'item_model') {
        if (!item.item_model) problems.push({ id: item.id, name: item.name, reason: 'item_model but no model key' });
      }
      // vanilla items always have material, so they always have a sprite key
    }

    console.log(`\n  ========== TEXTURE COVERAGE SUMMARY ==========`);
    console.log(`  Total items: ${items.length}`);
    console.log(`  Items with problems: ${problems.length}`);
    if (problems.length > 0) {
      console.log(`\n  Problem items:`);
      for (const p of problems) {
        console.log(`    ${p.id} (${p.name}): ${p.reason}`);
      }
    } else {
      console.log(`  All items have complete texture data!`);
    }
    console.log(`  ===============================================\n`);
  });
});
