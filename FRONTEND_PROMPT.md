# Frontend Implementation Prompt: SkyBlock Item Textures

Use this prompt in your Vite + React + TypeScript frontend project to implement item icon rendering for every SkyBlock item.

---

## Prompt

```
Implement an item icon rendering system that displays Minecraft-style item icons for every Hypixel SkyBlock item. The backend API provides all texture data — the frontend just needs to render it.

### API Endpoint

Base URL: configure via VITE_API_URL environment variable (e.g. http://localhost:3000)

GET /v2/skyblock/items/textures
Returns a compact mapping of every item ID to its texture rendering data.
This endpoint changes very rarely — cache aggressively (localStorage or memory, refresh every 30-60 minutes).

Response shape:
{
  success: true,
  data: {
    "HYPERION": {
      "type": "vanilla",
      "material": "IRON_SWORD"
    },
    "YOUNG_DRAGON_HELMET": {
      "type": "skull",
      "material": "SKULL_ITEM",
      "durability": 3,
      "skin_url": "http://textures.minecraft.net/texture/a0e81ed07dfb..."
    },
    "RANCHERS_BOOTS": {
      "type": "leather",
      "material": "LEATHER_BOOTS",
      "color": [139, 69, 19]
    },
    "BAMBOO": {
      "type": "item_model",
      "material": "SKULL_ITEM",
      "item_model": "minecraft:bamboo"
    },
    "ENCHANTED_DIAMOND": {
      "type": "vanilla",
      "material": "DIAMOND",
      "glowing": true
    }
  }
}

Individual items from GET /v2/skyblock/items/:itemId also include texture data inline:
{
  success: true,
  data: {
    id: "YOUNG_DRAGON_HELMET",
    name: "Young Dragon Helmet",
    material: "SKULL_ITEM",
    tier: "LEGENDARY",
    category: "HELMET",
    texture_type: "skull",
    texture_data: {
      material: "SKULL_ITEM",
      durability: 3,
      skin_url: "http://textures.minecraft.net/texture/a0e81ed07dfb..."
    }
  }
}

### Texture Types

There are exactly 4 texture types. The "type" field is the discriminant:

1. **vanilla** — Standard Minecraft item
   - Render using `material` as the sprite key (e.g. "DIAMOND_SWORD", "IRON_INGOT")
   - Some items have `durability` for sub-type selection (e.g. colored wool, dye variants, potions)
     The durability maps to Minecraft's legacy damage value / data value.
   - If `glowing: true`, overlay an enchantment shimmer effect (CSS animation or canvas filter)
   - Material names are Minecraft material IDs in SCREAMING_SNAKE_CASE (e.g. DIAMOND_SWORD, GOLD_HELMET, INK_SACK)

2. **skull** — Custom player head texture (most custom SkyBlock items)
   - `skin_url` is a direct URL to a 64x64 PNG on textures.minecraft.net (no CORS restrictions)
   - Render the head portion of the skin: pixels (8,8) to (16,16) from the texture, scaled up
   - Optionally composite the hat overlay layer: pixels (40,8) to (48,16) on top
   - This is the most common type for unique SkyBlock items (armor, weapons, accessories, pets, etc.)
   - Some skull items may have skin_url as undefined if the skin data was malformed — fall back to a generic skull icon

3. **leather** — Dyed leather armor
   - `color` is an [R, G, B] tuple (0-255 each)
   - Render the base leather armor sprite for the material (LEATHER_HELMET, LEATHER_CHESTPLATE, LEATHER_LEGGINGS, LEATHER_BOOTS)
   - Apply the RGB color as a tint using CSS filter, canvas multiply blend, or pre-tinted sprites
   - Approach: draw the grayscale leather armor sprite, then use canvas globalCompositeOperation "multiply" with the color, then "destination-atop" with the original to preserve transparency

4. **item_model** — Item with a custom model reference
   - `item_model` is a Minecraft resource key like "minecraft:bamboo"
   - Strip the "minecraft:" prefix and use the remainder as the sprite key
   - Falls back to vanilla sprite lookup (the model key usually corresponds to a vanilla item texture)

### Sprite Sheet Strategy

For vanilla/leather/item_model types, you need a Minecraft item sprite sheet. Options:

**Option A: Pre-built sprite sheet (recommended)**
- Use a community Minecraft item sprite atlas (many exist as open-source assets)
- Organize as a single PNG with a JSON mapping of material name to sprite coordinates
- Load once, render via CSS background-position or canvas drawImage
- Covers ~400 vanilla Minecraft items
- Example structure: /assets/sprites/items.png + /assets/sprites/items.json

**Option B: Individual PNGs**
- One 16x16 or 32x32 PNG per material in /assets/items/{material}.png
- Simpler to set up, more HTTP requests (but trivial with HTTP/2)
- Easier to update individual textures

For the sprite lookup, map Hypixel material names to Minecraft texture names:
- Most map directly: DIAMOND_SWORD -> diamond_sword, IRON_INGOT -> iron_ingot
- Convert to lowercase and use as the filename/key
- Items with durability: append the durability value, e.g. INK_SACK with durability 4 -> ink_sack_4 (lapis lazuli)
  OR use a lookup table for the ~20 items that use durability sub-types

### Component Structure

Create these components/utilities:

1. **ItemIcon** (main rendering component)
   Props: { itemId: string, size?: number, className?: string }
   - Looks up texture data from the texture map (context or global store)
   - Switches on texture_type to render the appropriate strategy
   - Default size: 32px (renders at 2x for 16px source textures — use image-rendering: pixelated)
   - Shows a fallback placeholder (generic barrier block icon or grey square) for unknown items

2. **useTextureMap** (data fetching hook)
   - Fetches GET /v2/skyblock/items/textures on mount
   - Caches in localStorage with a 30-minute TTL
   - Returns { textureMap, loading, error }
   - Provides data via React context so all ItemIcon instances share one fetch

3. **SkullRenderer** (utility component or canvas function)
   - Takes a skin_url and size
   - Loads the 64x64 skin PNG
   - Extracts the 8x8 head face region (pixels 8,8 to 16,16)
   - Optionally composites the hat overlay (pixels 40,8 to 48,16)
   - Renders at the target size with pixelated scaling
   - Uses <canvas> for the pixel extraction, caches the result as a data URL or ImageBitmap
   - Important: cache extracted head images in a Map<string, string> to avoid re-processing

4. **LeatherTinter** (utility function)
   - Takes a base leather armor sprite and an [R, G, B] color
   - Returns a tinted version using canvas compositing:
     1. Draw base grayscale sprite
     2. Fill with the color using globalCompositeOperation = "multiply"
     3. Apply "destination-atop" with original to restore transparency
   - Cache results by material+color key

5. **TextureProvider** (React context provider)
   - Wraps the app, provides the texture map to all ItemIcon instances
   - Handles loading state (show skeleton placeholders while loading)

### CSS Requirements

.item-icon {
  image-rendering: pixelated;       /* crisp Minecraft-style scaling */
  image-rendering: -moz-crisp-edges;
  display: inline-block;
  vertical-align: middle;
}

.item-icon--glowing {
  /* Enchantment shimmer effect */
  animation: enchant-shimmer 3s ease-in-out infinite;
}

@keyframes enchant-shimmer {
  0%, 100% { filter: brightness(1) hue-rotate(0deg); }
  50% { filter: brightness(1.3) hue-rotate(30deg); }
}

### Usage Examples

Once implemented, the ItemIcon component should be usable anywhere:

  {/* In a bazaar price list */}
  <ItemIcon itemId="ENCHANTED_DIAMOND" size={24} />
  <span>Enchanted Diamond</span>
  <span>172.5 coins</span>

  {/* In an auction listing */}
  <ItemIcon itemId="HYPERION" size={32} />

  {/* In a search dropdown */}
  {items.map(item => (
    <div key={item.id}>
      <ItemIcon itemId={item.id} size={20} />
      <span>{item.name}</span>
    </div>
  ))}

### Data Flow

1. On app mount: TextureProvider fetches /v2/skyblock/items/textures, caches in localStorage
2. ItemIcon receives an itemId, looks up texture data from context
3. Based on type:
   - "vanilla" / "item_model": look up sprite from sprite sheet by material name
   - "skull": pass skin_url to SkullRenderer (canvas extraction + caching)
   - "leather": pass material sprite + color to LeatherTinter (canvas compositing)
4. If glowing is true, add the enchant-shimmer CSS class
5. Render the resulting image at the requested size with pixelated scaling

### Performance Notes

- The /v2/skyblock/items/textures response is ~200-400KB (gzipped ~40-80KB). Fetch once, cache long.
- Skull texture PNGs from textures.minecraft.net are 64x64 (~2-5KB each). The browser caches these.
  For pages showing many skull items (e.g. auction listings with 50+ items), consider:
  - Lazy loading: only load skull textures for visible items (IntersectionObserver)
  - Batch pre-extraction: on first load, extract all visible skull heads in one requestAnimationFrame pass
- Canvas operations for skull extraction and leather tinting are fast (<1ms each) but cache the results to avoid repeated work
- The sprite sheet for vanilla items should be loaded as a single image (~50-100KB) — not individual files
```

---

## Quick Start

1. Copy the prompt above into your Vite + React + TypeScript project
2. Prepare a Minecraft item sprite sheet (or individual PNGs) in `/public/assets/`
3. Set `VITE_API_URL=http://localhost:3000` in your `.env`
4. Have Claude implement the components described in the prompt
5. Wrap your app in `<TextureProvider>` and use `<ItemIcon itemId="HYPERION" />` anywhere