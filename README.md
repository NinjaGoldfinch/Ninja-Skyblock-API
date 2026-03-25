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

This starts: API server (port 3000), Redis (6379), PostgreSQL (5432), and PostgREST (3001).

4. On first run, create the database tables:

```bash
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/002_initial-schema.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/003_api-keys.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -f /docker-entrypoint-initdb.d/004_watched-players.sql
docker compose exec -T postgres psql -U user -d ninja_skyblock -c "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO api_anon; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api_anon;"
docker compose restart postgrest
```

5. Verify it works:

```
http://localhost:3000/v1/health
```

### Local Development (without Docker)

```bash
npm install
npm run dev
```

Requires Redis running on `localhost:6379`. Configure via `.env`.

## API Endpoints

### v1 — Raw Hypixel Proxy (no processing)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/skyblock/profile/:profileUuid` | Raw Hypixel profile data |
| GET | `/v1/skyblock/profiles/:playerUuid` | All profiles for a player |
| GET | `/v1/skyblock/bazaar/:itemId` | Raw Hypixel bazaar product data |
| GET | `/v1/skyblock/auctions/player/:playerUuid` | Player's active auctions |
| GET | `/v1/skyblock/auctions/ended` | Recently ended auctions |
| GET | `/v1/player/uuid/:username` | Username to UUID (Mojang API) |
| GET | `/v1/player/username/:uuid` | UUID to username (Mojang API) |

### v2 — Computed/Processed Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v2/skyblock/profile/:profileUuid` | Processed profile (skills, networth, dungeons, slayers) |
| GET | `/v2/skyblock/bazaar/:itemId` | Processed bazaar data (instant + average prices, top orders) |
| GET | `/v2/skyblock/bazaar/:itemId/history` | Bazaar price history with summaries |
| GET | `/v2/skyblock/auctions/lowest/:item` | Lowest BIN for an item (by base name) |
| GET | `/v2/skyblock/auctions/search?search=term` | Search auction items by name |

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

All responses use a consistent envelope:

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

Workers run as separate Docker services from the API server. Each can be independently started, stopped, scaled, or deployed to different machines. They communicate with the API through Redis (cache + pub/sub) and PostgREST (Postgres).

| Service | Polls | Description |
|---------|-------|-------------|
| `worker-bazaar` | 1s (conditional) | Polls bazaar, skips if unchanged, caches prices, stores raw data, publishes events |
| `worker-auctions` | 1s (conditional) | Polls auctions page 0, fetches all pages only on change, tracks lowest BINs |
| `worker-profiles` | 5min | Polls watched players, diffs skill averages, stores snapshots |

Workers use `If-Modified-Since` headers to avoid re-parsing data that hasn't changed. A typical idle poll is <10ms.

```bash
# Start only specific workers
docker compose up worker-bazaar worker-auctions

# Restart a crashed worker without touching the API
docker compose restart worker-auctions

# Run a worker locally for development
npm run dev:worker:bazaar
```

## Environment Variables

See [.env.example](.env.example) for all variables. Required:

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection URL |
| `POSTGREST_URL` | PostgREST sidecar URL |
| `HYPIXEL_API_KEY` | Hypixel API key |
| `HMAC_SECRET` | Shared secret for HMAC auth |

## Tech Stack

- **Runtime:** Node.js + TypeScript (ESM)
- **HTTP:** Fastify
- **Cache:** Redis (ioredis)
- **Queue:** BullMQ
- **Database:** PostgreSQL + PostgREST
- **Docs:** OpenAPI 3.1 + ReDoc
- **Real-time:** Server-Sent Events + WebSocket (ws)
- **Logging:** Pino
- **Testing:** Vitest

## Project Structure

```
src/
  index.ts              API server entry point (Fastify, no workers)
  worker-bazaar.ts      Bazaar worker entry point
  worker-auctions.ts    Auction worker entry point
  worker-profiles.ts    Profile worker entry point
  config/               Environment vars, constants
  routes/v1/            Raw Hypixel proxy endpoints
  routes/v2/            Computed/processed endpoints
  services/             Hypixel client, cache, rate limiter, event bus, PostgREST
  workers/              BullMQ job processors (shared by worker entry points)
  processors/           Pure functions (skills, networth computation)
  plugins/              Fastify plugins (auth, swagger)
  schemas/              Shared JSON schemas for OpenAPI
  types/                TypeScript type definitions
  utils/                Redis, queue, logger, error utilities
migrations/             SQL schema migrations
sql/                    Init scripts and Postgres functions
tests/                  Unit and integration tests
```

## Scripts

```bash
npm run dev          # Start with hot reload (tsx watch)
npm run build        # Compile TypeScript
npm start            # Run compiled JS
npm test             # Run tests
npm run typecheck    # Type-check without emitting
npm run lint         # Lint with ESLint
```

## Testing

```bash
npm test             # Run all 42 tests
npm run test:watch   # Watch mode
npm run test:coverage # With coverage report
```

Requires Redis running for service and integration tests.
