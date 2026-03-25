# CLAUDE.md — Implementation Memory

## Project
ninja-skyblock-api — Backend API proxying Hypixel API for SkyBlock endpoints.
See ARCHITECTURE.md for full specification.

## Current phase
Phase 4 Core — complete

## Completed steps

### Phase 1 Core
- [x] 1. Project scaffold (package.json, tsconfig, docker-compose, directory structure)
- [x] 2. Environment variable parsing (src/config/env.ts)
- [x] 3. Hypixel API client (src/services/hypixel-client.ts)
- [x] 4. Cache manager (src/services/cache-manager.ts)
- [x] 5. Rate limiter (src/services/rate-limiter.ts)
- [x] 6. Profile route (GET /v1/skyblock/profile/:profileUuid) — end-to-end
- [x] 7. HMAC auth plugin (src/plugins/auth.ts)
- [x] 8. Processors (networth, skills)

### Phase 2 Core
- [x] 1. BullMQ queue setup
- [x] 2. Bazaar tracker worker
- [x] 3. PostgreSQL schema (migrations)
- [x] 4. Bazaar history endpoint

### Phase 3 Core
- [x] 1. Redis pub/sub event bus (src/services/event-bus.ts)
- [x] 2. SSE endpoint (GET /v1/events/bazaar/stream)
- [x] 3. WebSocket server (WS /v1/events/subscribe)

### Phase 4 Core
- [x] 1. API key management (generation, validation, per-key rate limits)
- [x] 2. Public rate limiting (per-key tier-based limits via auth plugin)
- [x] 3. Discord bot (separate client project — API side ready)

### Phase 2 "then"
- [x] Auction scanner worker (paginated fetch, lowest BIN tracking, ending-soon alerts)
- [x] Profile tracker worker (watched players, skill diff, snapshot storage)
- [x] Postgres aggregation functions (hourly bazaar averages, skill history)

## What works
- Step 1: `tsc --noEmit` passes, server boots with env vars set, exits cleanly on timeout
- Step 2: env.ts parses all required/optional vars, exits on missing required vars
- Step 3: Hypixel client compiles, key rotation round-robins, retry logic for 429/503/403
- Step 4: Cache manager with hot/warm tiers, stale-while-revalidate via extended TTL + age check
- Step 5: Dual rate limiter using Redis INCR + EXPIRE, 60s sliding window
- Step 6: Profile route registered, server boots, auth→cache→fetch→envelope flow implemented
- Step 7: HMAC auth plugin, 401 on missing/invalid sig, replay protection via timestamp drift check
- Step 8: Skills processor computes levels from XP thresholds; networth is placeholder (needs bazaar prices/NBT decoding)
- Phase 2 Step 1: BullMQ queue factory creates named queues/workers backed by Redis
- Phase 2 Step 2: Bazaar tracker polls Hypixel every 60s, caches products in warm tier, stores snapshots to Postgres
- Phase 2 Step 3: Initial migration creates bazaar_snapshots, auction_sales, player_profiles tables
- Phase 2 Step 4: Bazaar current price endpoint (from warm cache) and history endpoint (from Postgres)
- Phase 3: Event bus publishes bazaar price changes (>5% delta). SSE streams to web clients. WebSocket supports channel subscriptions with item filters.
- Phase 4 Steps 1-2: API keys stored as SHA-256 hashes in Postgres. Auth plugin supports HMAC, API key, and dev bypass. Rate limits are per-key (stored in api_keys table). Admin endpoint generates keys (internal auth only).
- Phase 2 "then": Auction scanner fetches all pages, tracks lowest BINs in hot cache, publishes new-lowest-BIN and ending-soon events. Profile tracker polls watched players, diffs skill averages, stores snapshots to Postgres. Postgres functions for hourly bazaar aggregation and skill history.

## Known issues
- Networth computation is a placeholder — needs NBT inventory decoding and bazaar/AH price lookups (Phase 2 dependency)
- [NOTE] Hypixel /v2/skyblock/auctions is a cached public endpoint — does not count against API key rate limit
- Bazaar history averages are computed in Node over all rows — should move to Postgres aggregation before data grows large (weeks of snapshots)
- Bazaar raw JSONB storage will grow fast — add a scheduled data retention job: strip order books after 24h, aggregate to hourly after 7d, delete raw after 30d
- [RESOLVED] Watched players now manageable via API (GET/POST/DELETE /v1/admin/watched-players)
- [RESOLVED] Auction lowest BIN now exposed via GET /v1/skyblock/auctions/lowest/:item

## Decisions made
- Networth processor returns bank+purse only for now; full item valuation deferred to Phase 2 when price data is available
- Sacks "value" in breakdown is item count, not coin value, until bazaar prices exist
- Changed HYPIXEL_API_KEYS (plural, comma-split) to HYPIXEL_API_KEY (singular) — only one key per project
- Profile route uses profile UUID (not player UUID). Calls Hypixel /v2/skyblock/profile?profile=UUID. Phase 2 will add separate endpoints for player-based lookups, active profile, etc.

## Next step
Phase 4 Core complete. Discord bot is a separate client project — API side is ready (WebSocket, API key auth, REST endpoints all in place).
