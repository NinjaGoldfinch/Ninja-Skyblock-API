# CLAUDE.md — Implementation Memory

## Project
ninja-skyblock-api — Backend API proxying Hypixel API for SkyBlock endpoints.
See ARCHITECTURE.md for full specification.

## Current phase
Phase 1 Core — complete

## Completed steps
- [x] 1. Project scaffold (package.json, tsconfig, docker-compose, directory structure)
- [x] 2. Environment variable parsing (src/config/env.ts)
- [x] 3. Hypixel API client (src/services/hypixel-client.ts)
- [x] 4. Cache manager (src/services/cache-manager.ts)
- [x] 5. Rate limiter (src/services/rate-limiter.ts)
- [x] 6. Profile route (GET /v1/skyblock/profile/:uuid) — end-to-end
- [x] 7. HMAC auth plugin (src/plugins/auth.ts)
- [x] 8. Processors (networth, skills)

## What works
- Step 1: `tsc --noEmit` passes, server boots with env vars set, exits cleanly on timeout
- Step 2: env.ts parses all required/optional vars, exits on missing required vars
- Step 3: Hypixel client compiles, key rotation round-robins, retry logic for 429/503/403
- Step 4: Cache manager with hot/warm tiers, stale-while-revalidate via extended TTL + age check
- Step 5: Dual rate limiter using Redis INCR + EXPIRE, 60s sliding window
- Step 6: Profile route registered, server boots, auth→cache→fetch→envelope flow implemented
- Step 7: HMAC auth plugin, 401 on missing/invalid sig, replay protection via timestamp drift check
- Step 8: Skills processor computes levels from XP thresholds; networth is placeholder (needs bazaar prices/NBT decoding)

## Known issues
- Networth computation is a placeholder — needs NBT inventory decoding and bazaar/AH price lookups (Phase 2 dependency)

## Decisions made
- Networth processor returns bank+purse only for now; full item valuation deferred to Phase 2 when price data is available
- Sacks "value" in breakdown is item count, not coin value, until bazaar prices exist
- Changed HYPIXEL_API_KEYS (plural, comma-split) to HYPIXEL_API_KEY (singular) — only one key per project
- Profile route uses profile UUID (not player UUID). Calls Hypixel /v2/skyblock/profile?profile=UUID. Phase 2 will add separate endpoints for player-based lookups, active profile, etc.

## Next step
Phase 1 Core complete. Next: Phase 1 "then" items (Pino logging, OpenAPI, remaining routes, tests).
