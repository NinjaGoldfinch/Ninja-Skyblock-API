# CLAUDE.md — Implementation Memory

## Project
ninja-skyblock-api — Backend API proxying Hypixel API for SkyBlock endpoints.
See ARCHITECTURE.md for full specification.

## Current phase
Phase 1 Core — step 5 of 8

## Completed steps
- [x] 1. Project scaffold (package.json, tsconfig, docker-compose, directory structure)
- [x] 2. Environment variable parsing (src/config/env.ts)
- [x] 3. Hypixel API client (src/services/hypixel-client.ts)
- [x] 4. Cache manager (src/services/cache-manager.ts)
- [ ] 5. Rate limiter (src/services/rate-limiter.ts)
- [ ] 6. Profile route (GET /v1/skyblock/profile/:uuid) — end-to-end
- [ ] 7. HMAC auth plugin (src/plugins/auth.ts)
- [ ] 8. Processors (networth, skills)

## What works
- Step 1: `tsc --noEmit` passes, server boots with env vars set, exits cleanly on timeout
- Step 2: env.ts parses all required/optional vars, exits on missing required vars
- Step 3: Hypixel client compiles, key rotation round-robins, retry logic for 429/503/403
- Step 4: Cache manager with hot/warm tiers, stale-while-revalidate via extended TTL + age check

## Known issues
<!-- Bugs, edge cases, things to revisit -->

## Decisions made
<!-- Any implementation decisions that deviated from or clarified ARCHITECTURE.md -->

## Next step
Step 5: Rate limiter — dual client-facing and Hypixel-facing rate limiting.
