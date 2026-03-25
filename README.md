# Ninja Skyblock API

Backend API that proxies and extends the Hypixel API for SkyBlock endpoints. Adds caching, rate limit management, real-time events, historical data collection, and computed data (networth, skill averages).

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A [Hypixel API key](https://developer.hypixel.net/)

### Setup

1. Clone the repository and copy the environment file:

```bash
cp .env.example .env
```

2. Edit `.env` and set your Hypixel API key:

```
HYPIXEL_API_KEY=your-key-here
```

3. Start all services:

```bash
docker compose up --build
```

This starts: API server (port 3000), workers (bazaar, auctions, profiles, resources), Redis (6379), PostgreSQL (5432), and PostgREST (3001).

4. On first run, create the database tables:

```bash
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/002_initial-schema.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/003_api-keys.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/004_watched-players.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/005_resource-snapshots.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/006_auction-history.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO api_anon; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_anon;"
docker compose restart postgrest
```

5. Verify it works:

```
http://localhost:3000/v1/health
```

### Local Development (without Docker)

```bash
npm install
npm run dev                    # API server
npm run dev:worker:bazaar      # Bazaar worker
npm run dev:worker:auctions    # Auction worker
npm run dev:worker:profiles    # Profile worker
npm run dev:worker:resources   # Resource workers (collections, skills, items, election)
```

Requires Redis running on `localhost:6379`. Configure via `.env`.

## API Endpoints

### v1 — Raw Hypixel Proxy (no processing)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/skyblock/profile/:profileUuid` | Raw Hypixel profile data |
| GET | `/v1/skyblock/profiles/:playerUuid` | All profiles for a player |
| GET | `/v1/skyblock/bazaar` | All raw bazaar product data |
| GET | `/v1/skyblock/bazaar/:itemId` | Raw bazaar data for a single product |
| GET | `/v1/skyblock/auctions/player/:playerUuid` | Player's active auctions |
| GET | `/v1/skyblock/auctions/ended` | Recently ended auctions |
| GET | `/v1/skyblock/collections` | SkyBlock collections data |
| GET | `/v1/skyblock/skills` | SkyBlock skills XP requirements |
| GET | `/v1/skyblock/items` | All SkyBlock items |
| GET | `/v1/skyblock/election` | Current mayor and election data |
| GET | `/v1/player/uuid/:username` | Username to UUID (Mojang API) |
| GET | `/v1/player/username/:uuid` | UUID to username (Mojang API) |

### v2 — Computed/Processed Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/skyblock/profile/:profileUuid` | Processed profile (skills, networth, dungeons, slayers) |
| GET | `/v2/skyblock/bazaar/:itemId` | Processed bazaar data (instant + average prices, top orders) |
| GET | `/v2/skyblock/bazaar/:itemId/history` | Bazaar price history with summaries |
| GET | `/v2/skyblock/auctions/lowest` | All items with lowest BIN prices |
| GET | `/v2/skyblock/auctions/lowest?key_by=skyblock_id` | Lowest BINs keyed by SkyBlock item ID (mod-friendly) |
| GET | `/v2/skyblock/auctions/lowest/:item` | Lowest BIN by name or SkyBlock item ID |
| GET | `/v2/skyblock/auctions/search?search=term` | Search auction items by name |
| GET | `/v2/skyblock/items` | All items with ID, name, tier, category |
| GET | `/v2/skyblock/items/:itemId` | Single item by SkyBlock ID |
| GET | `/v2/skyblock/items/lookup/:name` | Item name to SkyBlock ID lookup |

### Real-Time Events

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/events/bazaar/stream` | SSE stream of bazaar price changes |
| WS | `/v1/events/subscribe` | WebSocket with channel subscriptions and filters |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/admin/keys` | Generate API key (internal auth) |
| GET | `/v1/admin/watched-players` | List watched players |
| POST | `/v1/admin/watched-players` | Add player to watch list (internal auth) |
| DELETE | `/v1/admin/watched-players/:playerUuid` | Remove player (internal auth) |

### Docs & Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/health` | Service health check |
| GET | `/v1/docs` | Interactive API documentation (ReDoc) |
| GET | `/v1/docs/openapi.json` | OpenAPI 3.1 spec (JSON) |
| GET | `/v1/docs/openapi.yaml` | OpenAPI 3.1 spec (YAML) |

## Response Format

All responses use a consistent envelope. `cache_age_seconds` reflects when the source (Hypixel) last updated the data, not when it was fetched.

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "cached": true,
    "cache_age_seconds": 23,
    "timestamp": 1711500000000
  }
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "PLAYER_NOT_FOUND",
    "message": "No SkyBlock profile found for this player.",
    "status": 404
  },
  "meta": {
    "timestamp": 1711500000000
  }
}
```

## Authentication

Three auth strategies, selected automatically by header:

| Strategy | Header | Use Case |
|----------|--------|----------|
| HMAC | `X-Signature` + `X-Timestamp` | Fabric mod |
| API Key | `X-API-Key` | Public consumers, Discord bot |
| Dev Bypass | Set `DEV_AUTH_BYPASS=true` in `.env` | Local development |

## WebSocket Subscriptions

Connect to `ws://localhost:3000/v1/events/subscribe` and send JSON messages:

**Subscribe to all bazaar alerts:**
```json
{"action": "subscribe", "channel": "bazaar:alerts"}
```

**Subscribe with item filter:**
```json
{
  "action": "subscribe",
  "channel": "bazaar:alerts",
  "filters": {"item_ids": ["ENCHANTED_DIAMOND", "BOOSTER_COOKIE"]}
}
```

**Subscribe with price threshold:**
```json
{
  "action": "subscribe",
  "channel": "auction:alerts",
  "filters": {
    "item_ids": ["Hyperion"],
    "price_thresholds": [{"field": "price", "operator": "lt", "value": 600000000}]
  }
}
```

**Available channels:** `bazaar:alerts`, `auction:alerts`, `auction:ending`, `profile:changes`

## Background Workers

Workers run as separate Docker services from the API server. Each can be independently started, stopped, scaled, or deployed to different machines. They communicate through Redis (cache + pub/sub) and PostgREST (Postgres).

| Service | Polls | Description |
|---------|-------|-------------|
| `worker-bazaar` | 1s (conditional) | Polls bazaar, skips if unchanged, caches prices, stores raw data, publishes events |
| `worker-auctions` | 1s (conditional) | Tracks all auctions with full lifecycle (active/pending/sold/expired), lowest BINs, item ID resolution |
| `worker-profiles` | 5min | Polls watched players, diffs skill averages, stores snapshots |
| `worker-resources` | 1s (conditional) | Polls collections, skills, items, and election data. Only stores to Postgres on actual content changes |

All workers use `If-Modified-Since` headers — a typical idle poll is <10ms with no JSON parsing.

### Auction Lifecycle

The auction worker tracks every auction through its lifecycle:

```
Active (on AH) → removed from pages → Pending (held 30 min)
                                          ↓ appears in auctions_ended
                                        Sold → stored in auction_history (Postgres)
                                          ↓ 30 min timeout
                                        Expired → stored in auction_history (Postgres)
```

Only genuinely new auctions are processed (extractBaseItem + skyblock_id lookup). Existing auctions are tracked by UUID — bids on regular auctions are updated in-place.

```bash
# Start only specific workers
docker compose up worker-bazaar worker-auctions

# Restart a crashed worker without touching the API
docker compose restart worker-auctions

# Run a worker locally for development
npm run dev:worker:bazaar
```

## Environment Variables

All services read from `.env`. See [.env.example](.env.example) for all variables.

**Required:**

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection URL |
| `POSTGREST_URL` | PostgREST sidecar URL |
| `HYPIXEL_API_KEY` | Hypixel API key |
| `HMAC_SECRET` | Shared secret for HMAC auth |

**Optional (with defaults):**

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Logging level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `DEV_AUTH_BYPASS` | `false` | Skip authentication in development |
| `HOT_CACHE_TTL` | `60` | Hot cache TTL in seconds |
| `WARM_CACHE_TTL` | `300` | Warm cache TTL in seconds |
| `BAZAAR_ALERT_THRESHOLD` | `0.1` | Minimum coin difference to trigger bazaar price alert |
| `CLIENT_RATE_LIMIT` | `60` | Requests per minute for internal clients |
| `PUBLIC_RATE_LIMIT` | `30` | Requests per minute for public API keys |

### Log Levels

| Level | What you see |
|-------|-------------|
| `info` | Compact one-line summaries per poll cycle, worker start/stop, content changes |
| `debug` | Full structured data (page counts, fetch durations, cache operations) |
| `trace` | Per-key cache hits/misses, individual auction page fetches |

## Tech Stack

- **Runtime:** Node.js + TypeScript (ESM)
- **HTTP:** Fastify
- **Cache:** Redis (ioredis)
- **Queue:** BullMQ
- **Database:** PostgreSQL + PostgREST
- **Docs:** OpenAPI 3.1 + ReDoc
- **Real-time:** Server-Sent Events + WebSocket (ws)
- **Logging:** Pino (with pino-pretty for development)
- **Testing:** Vitest (42 tests)
- **HTTP Client:** undici (100 concurrent connections, HTTP/2)

## Project Structure

```
src/
  index.ts              API server entry point (Fastify, no workers)
  worker-bazaar.ts      Bazaar worker entry point
  worker-auctions.ts    Auction worker entry point (includes sold tracking)
  worker-profiles.ts    Profile worker entry point
  worker-resources.ts   Resource workers entry point (collections, skills, items, election)
  config/               Environment vars, constants
  routes/v1/            Raw Hypixel proxy endpoints
  routes/v2/            Computed/processed endpoints
  services/             Hypixel client, cache, rate limiter, event bus, PostgREST
  workers/              BullMQ job processors (shared by worker entry points)
  processors/           Pure functions (skills, networth computation)
  plugins/              Fastify plugins (auth, swagger)
  schemas/              Shared JSON schemas for OpenAPI
  types/                TypeScript type definitions
  utils/                Redis, queue, logger, error utilities, content hashing
migrations/             SQL schema migrations (006+)
sql/                    Init scripts and Postgres functions
tests/                  Unit and integration tests
```

## Database Tables

| Table | Description |
|-------|-------------|
| `bazaar_snapshots` | Raw Hypixel bazaar JSONB per product per poll |
| `auction_history` | Completed auctions with outcome (sold/expired), buyer, final price |
| `player_profiles` | Skill/networth snapshots for watched players |
| `resource_snapshots` | Version-tracked snapshots of collections, skills, items, election |
| `api_keys` | SHA-256 hashed API keys with owner, tier, rate limit |
| `watched_players` | Player UUIDs tracked by the profile worker |

## Scripts

```bash
npm run dev                    # API server with hot reload
npm run build                  # Compile TypeScript
npm start                      # Run compiled API server
npm run dev:worker:bazaar      # Bazaar worker with hot reload
npm run dev:worker:auctions    # Auction worker with hot reload
npm run dev:worker:profiles    # Profile worker with hot reload
npm run dev:worker:resources   # Resource workers with hot reload
npm test                       # Run all 42 tests
npm run test:watch             # Watch mode
npm run test:coverage          # With coverage report
npm run typecheck              # Type-check without emitting
```

## Testing

```bash
npm test             # Run all 42 tests
npm run test:watch   # Watch mode
npm run test:coverage # With coverage report
```

Tests cover: processors (skills, networth), error utilities, cache manager, rate limiter, and route integration tests (health, profile, bazaar). Requires Redis running for service and integration tests.
