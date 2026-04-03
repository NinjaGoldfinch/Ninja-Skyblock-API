import { describe, it, expect } from 'vitest';
import { decodeSkinUrl, parseColor, classifyTextureType } from '../../../src/utils/texture.js';

describe('decodeSkinUrl', () => {
  const skinUrl = 'http://textures.minecraft.net/texture/a0e81ed07dfb0244d56f4d5f2b37553ec026fb4796f0fb0c57a8eb264983e1e0';
  const textureJson = JSON.stringify({
    timestamp: 1720050272406,
    textures: { SKIN: { url: skinUrl } },
  });
  const base64Value = Buffer.from(textureJson).toString('base64');

  it('decodes a base64 string skin field', () => {
    expect(decodeSkinUrl(base64Value)).toBe(skinUrl);
  });

  it('decodes an object skin field with value property', () => {
    expect(decodeSkinUrl({ value: base64Value })).toBe(skinUrl);
  });

  it('decodes an object skin field with value and signature', () => {
    expect(decodeSkinUrl({ value: base64Value, signature: 'sig123' })).toBe(skinUrl);
  });

  it('returns undefined for invalid base64', () => {
    expect(decodeSkinUrl('not-valid-base64!!!')).toBeUndefined();
  });

  it('returns undefined for valid base64 but non-JSON content', () => {
    const notJson = Buffer.from('hello world').toString('base64');
    expect(decodeSkinUrl(notJson)).toBeUndefined();
  });

  it('returns undefined for JSON without textures field', () => {
    const noTextures = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64');
    expect(decodeSkinUrl(noTextures)).toBeUndefined();
  });
});

describe('parseColor', () => {
  it('parses a valid RGB string', () => {
    expect(parseColor('139,0,0')).toEqual([139, 0, 0]);
  });

  it('parses with whitespace', () => {
    expect(parseColor('255, 128, 0')).toEqual([255, 128, 0]);
  });

  it('returns undefined for too few values', () => {
    expect(parseColor('255,128')).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    expect(parseColor('red,green,blue')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseColor('')).toBeUndefined();
  });
});

describe('classifyTextureType', () => {
  it('returns skull when skin is present', () => {
    expect(classifyTextureType({ skin: 'base64data', material: 'SKULL_ITEM' })).toBe('skull');
  });

  it('returns leather for leather material with color', () => {
    expect(classifyTextureType({ color: '139,0,0', material: 'LEATHER_CHESTPLATE' })).toBe('leather');
  });

  it('returns vanilla for non-leather material with color', () => {
    expect(classifyTextureType({ color: '139,0,0', material: 'DIAMOND_SWORD' })).toBe('vanilla');
  });

  it('returns item_model when item_model is present', () => {
    expect(classifyTextureType({ item_model: 'minecraft:bamboo', material: 'SKULL_ITEM' })).toBe('item_model');
  });

  it('returns vanilla for plain items', () => {
    expect(classifyTextureType({ material: 'DIAMOND_SWORD' })).toBe('vanilla');
  });

  it('prioritizes skull over leather and item_model', () => {
    expect(classifyTextureType({ skin: 'data', color: '0,0,0', item_model: 'test', material: 'LEATHER_HELMET' })).toBe('skull');
  });
});
