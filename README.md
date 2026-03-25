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

### SkyBlock Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/skyblock/profile/:profileUuid` | SkyBlock profile by profile UUID |
| GET | `/v1/skyblock/bazaar/:itemId` | Current bazaar product data |
| GET | `/v1/skyblock/bazaar/:itemId/history` | Bazaar price history |
| GET | `/v1/skyblock/auctions/lowest/:item` | Lowest BIN for an item |

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

| Worker | Interval | Description |
|--------|----------|-------------|
| Bazaar Tracker | 60s | Polls all bazaar products, caches prices, stores raw data to Postgres, publishes price change events |
| Auction Scanner | 45s | Scans all auction pages, tracks lowest BINs, publishes new-lowest and ending-soon events |
| Profile Tracker | 5min | Polls watched players, diffs skill averages, stores snapshots, publishes change events |

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
  config/       Environment vars, constants
  routes/v1/    REST endpoints (skyblock, admin, events, docs)
  services/     Hypixel client, cache, rate limiter, event bus, PostgREST
  workers/      BullMQ background jobs (bazaar, auctions, profiles)
  processors/   Pure functions (skills, networth computation)
  plugins/      Fastify plugins (auth, swagger)
  schemas/      Shared JSON schemas for OpenAPI
  types/        TypeScript type definitions
  utils/        Redis, queue, logger, error utilities
migrations/     SQL schema migrations
sql/            Init scripts and Postgres functions
tests/          Unit and integration tests
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
