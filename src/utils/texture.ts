/** Utilities for extracting and decoding item texture data from Hypixel API responses. */

import { createLogger } from './logger.js';

const log = createLogger('texture');

type SkinField = string | { value: string; signature?: string };

/** Decode a Hypixel skin field (base64 texture JSON) to a textures.minecraft.net URL. */
export function decodeSkinUrl(skin: SkinField): string | undefined {
  try {
    const value = typeof skin === 'string' ? skin : skin.value;
    const json = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
    return json?.textures?.SKIN?.url as string | undefined;
  } catch {
    return undefined;
  }
}

/** Parse a Hypixel color string "R,G,B" into a numeric tuple. */
export function parseColor(color: string): [number, number, number] | undefined {
  const parts = color.split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return undefined;
  return parts as [number, number, number];
}

interface TextureClassifyInput {
  skin?: SkinField;
  color?: string;
  material: string;
  item_model?: string;
}

/** Classify an item's texture rendering strategy. */
export function classifyTextureType(item: TextureClassifyInput): 'skull' | 'leather' | 'item_model' | 'vanilla' {
  if (item.skin) return 'skull';
  if (item.color && item.material.startsWith('LEATHER_')) return 'leather';
  if (item.item_model) return 'item_model';
  return 'vanilla';
}

const NEU_RAW_BASE = 'https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/items/';

/** Extract skull texture URL from a NEU item's nbttag string. */
function extractNeuSkinUrl(nbttag: string): string | undefined {
  const match = nbttag.match(/Value:"([^"]+)"/);
  if (!match) return undefined;
  return decodeSkinUrl(match[1]);
}

interface NeuItem {
  itemid: string;
  damage?: number;
  nbttag?: string;
}

/**
 * Fetch texture data from the NEU repo for items not covered by Hypixel's items resource.
 * Returns a map of item ID → { material, skin_url } for items found.
 */
export async function fetchNeuTextures(
  itemIds: string[],
): Promise<Map<string, { material: string; durability?: number; skin_url?: string }>> {
  const results = new Map<string, { material: string; durability?: number; skin_url?: string }>();

  const settled = await Promise.allSettled(
    itemIds.map(async (id) => {
      const res = await fetch(`${NEU_RAW_BASE}${id}.json`);
      if (!res.ok) return;
      const data = (await res.json()) as NeuItem;
      const material = data.itemid.replace('minecraft:', '').toUpperCase();
      const entry: { material: string; durability?: number; skin_url?: string } = { material };
      if (data.damage) entry.durability = data.damage;
      if (data.nbttag) {
        const skinUrl = extractNeuSkinUrl(data.nbttag);
        if (skinUrl) entry.skin_url = skinUrl;
      }
      results.set(id, entry);
    }),
  );

  const failures = settled.filter((r) => r.status === 'rejected').length;
  if (failures > 0) log.warn({ failures, total: itemIds.length }, 'Some NEU texture fetches failed');

  return results;
}
