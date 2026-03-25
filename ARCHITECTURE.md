# Ninja Skyblock API — Architecture Plan

> **Purpose:** This document defines the architecture, tech stack, data flow, caching strategy, and build plan for `ninja-skyblock-api` — a backend API that proxies and extends the Hypixel API for SkyBlock endpoints. It is intended as the primary reference for implementation.
> 
> **Repository:** `NinjaGoldfinch/ninja-skyblock-api`

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Libraries vs Custom Code](#libraries-vs-custom-code)
4. [System Architecture](#system-architecture)
5. [Layer 1 — Clients](#layer-1--clients)
6. [Layer 2 — API Gateway](#layer-2--api-gateway)
7. [Layer 3 — Services](#layer-3--services)
8. [Layer 4 — Data & Real-Time Events](#layer-4--data--real-time-events)
9. [Data Flow Patterns](#data-flow-patterns)
10. [Caching Strategy](#caching-strategy)
11. [API Endpoint Structure](#api-endpoint-structure)
12. [OpenAPI Specification & Documentation](#openapi-specification--documentation)
13. [Authentication Strategy](#authentication-strategy)
14. [Real-Time Layer](#real-time-layer)
15. [Background Workers](#background-workers)
16. [Infrastructure & Deployment](#infrastructure--deployment)
17. [Development Priorities](#development-priorities)
18. [Build Order](#build-order)
19. [Git Workflow & CI/CD](#git-workflow--cicd)
20. [Project Directory Structure](#project-directory-structure)
21. [Naming Conventions & Code Style](#naming-conventions--code-style)
22. [TypeScript Configuration](#typescript-configuration)
23. [Environment Variables](#environment-variables)
24. [Response Envelope Format](#response-envelope-format)
25. [Error Handling](#error-handling)
26. [Logging](#logging)
27. [Testing](#testing)
28. [Reference Resources](#reference-resources)

---

## Overview

This API serves as an intelligent proxy between clients and the Hypixel API, adding caching, rate limit management, historical data collection, real-time events, and computed data (networth, skill averages, etc.).

**Primary client:** A Fabric mod communicating via REST/HTTP.
**Future clients:** A public-facing web app (REST + SSE), a Discord bot (REST + WebSocket), and a public API for third-party developers (REST + API key auth).

All clients hit the same backend endpoints. The real-time layer (SSE/WebSocket) is an opt-in addition, not a separate API. The gateway does not branch based on client type.

---

## Tech Stack

| Component        | Technology       | Role                                              |
| ---------------- | ---------------- | ------------------------------------------------- |
| Language          | TypeScript       | Everything except the Fabric mod                  |
| HTTP framework    | Fastify          | API gateway, validation, routing                  |
| Job queue         | BullMQ           | Priority request queue, scheduled workers         |
| Cache + pub/sub   | Redis (ioredis)  | All caching, rate limits, event bus, queue backend |
| Database          | PostgreSQL       | Persistent storage, history, accounts             |
| Data access layer | PostgREST        | Auto-generated REST API over Postgres, no ORM     |
| Migrations        | node-pg-migrate  | Schema migrations via plain SQL files             |
| WebSocket         | `ws`             | Real-time bidirectional (bot, subscribers)         |
| SSE               | Custom (Fastify) | Real-time one-way (web app), ~20 lines of code    |
| Containerization  | Docker Compose   | Local dev: API + Redis + Postgres                 |
| API docs          | @fastify/swagger + ReDoc | OpenAPI spec generation + hosted documentation UI |
| Auth              | Custom           | HMAC (mod), API keys (public), OAuth2 (web)       |

---

## Libraries vs Custom Code

### Use Libraries (don't reinvent these)

**Fastify** — HTTP server, request lifecycle hooks, schema validation, plugin isolation, streaming. Compiles JSON serializers from schemas for performance. Do not build from `node:http`.

**ioredis** — Redis client. Handles connection pooling, reconnection, pipelining, cluster support, Lua scripting. The entire Node.js Redis ecosystem depends on it.

**BullMQ** — Job queue on top of Redis. Handles reliable delivery, retry with exponential backoff, priority ordering, dead letter queues, concurrency control, stalled job recovery. Building a correct job queue from scratch takes weeks and you will miss edge cases (e.g. worker crash mid-job).

**PostgREST** — A standalone service (single binary) that auto-generates a full REST API directly from your Postgres schema. Add a table, it appears in the API immediately. Supports filtering, sorting, pagination, bulk inserts, joins across foreign keys, and RPC via Postgres functions. Eliminates the ORM layer entirely — schema changes in Postgres are reflected in the data API without code changes or redeployment. Runs as a sidecar Docker container.

**node-pg-migrate** — Lightweight SQL migration runner. You write plain `.sql` migration files, it tracks which have been applied. No schema DSL, no code generation — just SQL. Migrations are the single source of truth for your schema, and PostgREST picks up changes automatically.

**`ws`** — WebSocket library. Thin C++ binding handling upgrade handshakes, frame masking, ping/pong keepalive, fragmentation per RFC 6455. No benefit to implementing the protocol yourself.

**@fastify/swagger** — Generates an OpenAPI 3.1 specification directly from Fastify route schemas. The schemas you already write for validation and TypeScript inference become the API documentation automatically. No separate spec file to maintain. Pair with ReDoc (loaded from CDN, no npm dependency) for a hosted documentation UI.

**Docker / Docker Compose** — Container orchestration for local development.

### Build Custom (libraries will hold you back)

**Hypixel API client** — This is the project's core. Existing libraries like `hypixel-api-reborn` are designed for simple fetch-and-return. Your proxy needs: request queuing with priority levels, key rotation across multiple API keys, granular per-endpoint rate tracking, stale-while-revalidate integration with your cache layer, and custom retry logic that distinguishes between 429 (rate limited, back off), 503 (Hypixel down, retry with different timing), and 403 (invalid key, stop immediately). Use existing libraries as reference for endpoint paths and response types, but own the client code.

**Cache manager** — Use `ioredis` as the client, but the caching logic (tiered TTL strategy, stale-while-revalidate, cache key naming, invalidation rules) must be custom. A generic caching library does not understand that bazaar price caches and player profile caches have fundamentally different freshness requirements. Write a thin abstraction over ioredis that encodes your business rules.

**Rate limiter** — Dual rate limiting (client-facing and Hypixel-facing), priority-aware consumption (high-priority mod requests allowed even when background workers are throttled), sliding window counters that share state with BullMQ's queue decisions. A few Redis `INCR` + `EXPIRE` calls with a custom wrapper will serve better than configuring around a library's assumptions.

**Data processors** — Networth calculation, skill average aggregation, dungeon score computation. Pure business logic specific to SkyBlock game mechanics. Use SkyCrypt's source as reference but write your own, as these change whenever Hypixel updates the game.

**SSE handler** — Server-Sent Events are trivially simple: set headers on the Fastify response, write `data: {json}\n\n` strings. ~20 lines of code. A library adds dependency weight for no benefit.

**Event bus / pub/sub layer** — Thin abstraction between Redis pub/sub and SSE/WebSocket servers. Contains subscription matching logic (e.g. "does this bazaar price event match any active alert subscriptions?"). ~100 lines, deeply specific to your event types.

### General Principle

Use libraries for **infrastructure** (transport, storage, protocol handling). Build custom for **domain logic** (SkyBlock data handling, caching strategy, client–Hypixel interaction). If the code would be identical whether you're building a SkyBlock API or a weather API, use a library. If it's specific to your problem, write it yourself. Always read existing libraries before building — use their type definitions and logic as reference.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                │
│  ┌────────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────────┐  │
│  │ Fabric Mod │ │ Web App  │ │ Discord Bot │ │  Public API  │  │
│  │  (REST)    │ │(REST+SSE)│ │ (REST+WS)   │ │ (REST+key)   │  │
│  └─────┬──────┘ └────┬─────┘ └──────┬──────┘ └──────┬───────┘  │
└────────┼─────────────┼──────────────┼───────────────┼───────────┘
         │             │              │               │
┌────────┼─────────────┼──────────────┼───────────────┼───────────┐
│        ▼             ▼              ▼               ▼           │
│  ┌──────────────────────────┐ ┌──────────────────────────┐      │
│  │    Fastify Gateway       │ │   Real-Time Server       │      │
│  │  Auth → Validate → Route │ │   SSE + WebSocket        │      │
│  └────────────┬─────────────┘ └─────────────┬────────────┘      │
│               │                             │                   │
│  ┌────────────▼─────────────┐ ┌─────────────▼────────────┐      │
│  │  Rate Limiter (Redis)    │ │  Event Bus (Redis P/S)   │      │
│  └────────────┬─────────────┘ └─────────────┬────────────┘      │
│          API GATEWAY                        │                   │
└───────────────┼─────────────────────────────┼───────────────────┘
                │                             │
┌───────────────┼─────────────────────────────┼───────────────────┐
│               ▼                             │                   │
│  ┌──────────────┐ ┌──────────────┐ ┌────────┴─────┐ ┌────────┐ │
│  │Hypixel Proxy │ │Cache Manager │ │   Workers    │ │Process- │ │
│  │Request Queue │ │ Tiered TTL   │ │BullMQ Jobs   │ │  ors    │ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └────┬───┘ │
│         │                │                │              │      │
│         ▼           SERVICES              │              │      │
│  ┌──────────────┐                         │              │      │
│  │ Hypixel API  │                         │              │      │
│  │ (external)   │                         │              │      │
│  └──────────────┘                         │              │      │
└───────────────────────────────────────────┼──────────────┼──────┘
                                            │              │
┌───────────────────────────────────────────┼──────────────┼──────┐
│                                           ▼              ▼      │
│  ┌──────────────────────────┐ ┌──────────────────────────────┐  │
│  │         Redis            │ │     PostgREST (sidecar)      │  │
│  │ Cache + Pub/Sub + Queues │ │  Auto-generated Data API     │  │
│  └──────────────────────────┘ └──────────────┬───────────────┘  │
│                                              ▼                  │
│                               ┌──────────────────────────────┐  │
│                               │        PostgreSQL             │  │
│                               │  History + Accounts + Data   │  │
│                               └──────────────────────────────┘  │
│                          DATA                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Layer 1 — Clients

Every consumer hits the same backend through different protocols suited to their needs.

**Fabric Mod (primary):** Pure REST over HTTP. Java's `HttpClient` makes GET requests, receives JSON. No persistent connections. Fires requests on player actions (open menu, join lobby, trigger lookup). Low overhead, works behind every firewall and proxy.

**Web App (future):** REST for page loads and data fetches, plus Server-Sent Events (SSE) for live updates. SSE is one-way (server → client) over a regular HTTP connection. The browser opens the stream and receives events (bazaar price ticks, auction ending alerts). Works through CDNs and proxies, auto-reconnects on drop.

**Discord Bot (future):** REST for commands, WebSocket for real-time alerts. Subscribes to event channels (e.g. "notify when Hyperion BIN < 600M"), server pushes events. Bidirectional communication allows subscription changes without separate HTTP calls.

**Public API (future):** REST-only with API key authentication and stricter rate limits. Third-party developers get a subset of endpoints.

---

## Layer 2 — API Gateway

The gateway is a Fastify server handling every inbound request through a consistent pipeline:

```
Request → 1. Authenticate → 2. Validate → 3. Rate Check → 4. Cache Check
                                                              │
                                                    ┌─────────┴──────────┐
                                                    ▼                    ▼
                                              Cache Hit             Cache Miss
                                              (return)          5. Queue BullMQ Job
                                                                 6. Fetch Hypixel
                                                                 7. Cache + Reply
```

**1. Authenticate:** HMAC-signed requests (mod), session/OAuth2 (web app), API keys (bot/public). Each strategy is a Fastify plugin decorating the request with a verified identity.

**2. Validate:** Fastify's built-in JSON Schema support. Every endpoint declares expected params, query strings, and response shapes. Gives automatic 400 errors, auto-generated OpenAPI docs, and TypeScript type inference from schemas. Define once, get validation + docs + types.

**3. Rate Check:** Per-client limits checked against Redis. The mod gets generous limits. Public API keys get stricter tiers. This is separate from Hypixel rate limiting — this protects your server from abuse.

**4. Cache Check (stale-while-revalidate):**
- Data exists and is **fresh** → return immediately.
- Data exists but is **stale** (TTL expired) → return immediately AND queue a background refresh job.
- **No data** exists → queue a priority fetch job.
- The mod user gets a response in milliseconds in all cases.

---

## Layer 3 — Services

Four distinct service roles, running as separate processes or BullMQ workers.

### Hypixel Proxy

Single point of contact with the Hypixel API. All outbound requests flow through here.

- Request queue with priority levels (real-time mod lookups = high, background collection = low).
- Tracks API key usage against Hypixel's 120 req/min limit.
- Applies backpressure when approaching the rate ceiling.
- Supports multiple API key rotation.
- Custom retry logic: 429 → back off, 503 → retry with different timing, 403 → stop.

### Cache Manager

Implements the tiered caching strategy. Decides TTLs based on data type and writes to Redis with appropriate expiration. Thin abstraction over ioredis encoding business rules about data freshness.

### Workers (BullMQ)

Background data collectors running on schedules:

- **Bazaar tracker:** Poll every 60s, store price snapshots, publish events if price delta exceeds threshold.
- **Auction scanner:** Poll active auctions, detect new lowest BINs, ending-soon auctions. Computationally heavy — paginated data across many pages.
- **Profile tracker:** Periodically refresh watched players, diff profiles to detect skill gains, slayer completions, etc.

When a worker detects something interesting, it publishes an event to Redis pub/sub. The real-time server picks up events and fans them to subscribed clients.

### Processors

Computed data — networth calculation, skill average aggregation, dungeon stats. Raw Hypixel API responses require significant processing. Run as on-demand functions called by the gateway, or as post-processing steps after workers fetch fresh data. Reference SkyCrypt's open source logic for computation approaches.

---

## Layer 4 — Data & Real-Time Events

### Redis (Single Instance, Five Roles)

**Hot cache (30s–2min TTL):** Player profiles, active auctions. Near-instant mod responses.

**Warm cache (5–15min TTL):** Bazaar prices, skills, collections. Constantly refreshed by background workers.

**Rate limit counters:** Atomic `INCR` + TTL for dual tracking — per-client request counts (protecting your server) and per-key Hypixel request counts (protecting your API key). Sliding window counters, not simple per-minute buckets.

**BullMQ job queues:** Every outbound Hypixel request goes through a priority queue. Real-time user requests = priority 1, background polls = priority 3. Ensures mod users are always served first.

**Pub/sub channels:** Workers publish events (price spikes, new lowest BIN, player level-ups). SSE and WebSocket servers subscribe to relevant channels and fan out to connected clients.

### PostgREST + PostgreSQL

PostgREST runs as a sidecar Docker container and auto-generates a full REST API from your Postgres schema. All services (Fastify gateway, workers, processors) access Postgres through PostgREST rather than running SQL directly. This means:

- Adding a column to `bazaar_snapshots` makes it queryable via the API immediately — no backend code changes, no redeployment.
- Schema migrations (via `node-pg-migrate` or plain `.sql` files) are the single source of truth. PostgREST reflects changes automatically.
- No ORM layer to maintain. No Drizzle schema file, no Prisma client generation, no type mismatches.

**How services use PostgREST:**

```
// Instead of ORM queries:
//   db.select().from(bazaarSnapshots).where(...)

// Services make HTTP calls to the PostgREST sidecar:
const prices = await fetch(
  `${POSTGREST_URL}/bazaar_snapshots?item_id=eq.ENCHANTED_DIAMOND&order=timestamp.desc&limit=100`
).then(r => r.json());

// Bulk inserts (workers storing snapshots):
await fetch(`${POSTGREST_URL}/bazaar_snapshots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(snapshotRows)
});
```

**Complex queries** that don't map well to REST filters (aggregations, cross-table analytics, networth computation) are written as Postgres functions and called via PostgREST's RPC:

```
// Postgres function: calculate_networth(player_uuid uuid)
// Called via:
const result = await fetch(`${POSTGREST_URL}/rpc/calculate_networth`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ player_uuid: uuid })
}).then(r => r.json());
```

**Row-level security:** PostgREST uses Postgres roles for access control. The `api_anon` role used by your services can be restricted to specific schemas, tables, or even rows. This keeps your data access locked down at the database level.

Persistent storage includes:

- Bazaar price snapshots (historical charts)
- Auction sale records
- Player profile snapshots (progression tracking)
- User accounts (web app)
- Postgres functions for complex computations (networth, skill aggregation)

Powers analytics and historical views in the web app.

---

## Data Flow Patterns

### Pattern 1 — Synchronous Request (mod user looks up a player)

```
Mod → GET /v1/skyblock/profile/:uuid
  → Fastify authenticates (HMAC)
  → Validates params (JSON Schema)
  → Checks client rate limit (Redis)
  → Cache manager checks Redis
    → Cache HIT (fresh): return immediately (~5ms)
    → Cache HIT (stale): return immediately + queue background refresh
    → Cache MISS: queue priority-1 BullMQ job
      → Hypixel proxy sends request to Hypixel API
      → Response cached in Redis (hot tier, 60s TTL)
      → Response snapshot written via PostgREST → Postgres
      → Response returned to mod (~200-500ms)
```

### Pattern 2 — Background Collection (bazaar worker polls prices)

```
BullMQ scheduled job fires (every 60s)
  → Worker calls Hypixel proxy
  → Proxy fetches from Hypixel API (priority 3)
  → Worker processes response, computes deltas
  → Stores price snapshot via PostgREST → Postgres
  → Updates Redis warm cache (5min TTL)
  → IF price delta exceeds threshold:
    → Publishes event to Redis pub/sub channel "bazaar:alerts"
    → SSE server fans out to subscribed web app clients
    → WS server fans out to subscribed bot clients
```

### Pattern 3 — Real-Time Subscription (bot watches for price drop)

```
Bot → WebSocket subscription: "watch Hyperion BIN < 600M"
  → WS server registers subscription in memory
  → ... time passes ...
  → Auction worker detects matching condition
  → Publishes to Redis pub/sub channel "auction:alerts"
  → WS server matches event against active subscriptions
  → Pushes alert to bot via WebSocket
  → Bot sends Discord message
```

---

## Caching Strategy

| Data Type          | Cache Tier     | TTL       | Refresh Strategy                |
| ------------------ | -------------- | --------- | ------------------------------- |
| Player profile     | Hot (Redis)    | 60s       | Stale-while-revalidate          |
| Active auctions    | Hot (Redis)    | 30s       | Background worker poll          |
| Bazaar prices      | Warm (Redis)   | 5min      | Worker poll every 60s           |
| Skills/collections | Warm (Redis)   | 15min     | On-demand + background          |
| Networth (computed)| Warm (Redis)   | 5min      | Recomputed on profile refresh   |
| Price history      | Cold (Postgres)| Permanent | Worker inserts snapshots        |
| Auction sales log  | Cold (Postgres)| Permanent | Worker inserts on sale          |

**Stale-while-revalidate detail:** When data is cached but near expiry (e.g. profile is 45s old, TTL is 60s), serve the cached copy immediately and queue a background refresh. The user gets instant data. The next request gets the refreshed version. This eliminates the cache miss penalty.

---

## API Endpoint Structure

All endpoints are versioned from day one. When response shapes change, old mod versions don't break.

```
GET  /v1/skyblock/profile/:uuid          — Full SkyBlock profile
GET  /v1/skyblock/profiles/:uuid         — All profiles for a player
GET  /v1/skyblock/auctions?player=:uuid  — Player's active auctions
GET  /v1/skyblock/auctions/lowest/:item  — Lowest BIN for an item
GET  /v1/skyblock/bazaar/:itemId         — Current bazaar data
GET  /v1/skyblock/bazaar/:itemId/history — Price history (query: ?range=7d)
GET  /v1/skyblock/networth/:uuid         — Computed networth
GET  /v1/skyblock/skills/:uuid           — Skill averages
GET  /v1/skyblock/dungeons/:uuid         — Dungeon stats
GET  /v1/skyblock/slayers/:uuid          — Slayer stats
GET  /v1/skyblock/collections/:uuid      — Collection progress

GET  /v1/events/bazaar/stream            — SSE stream for bazaar events
WS   /v1/events/subscribe                — WebSocket for custom subscriptions

GET  /v1/health                          — Service health check
GET  /v1/docs                            — ReDoc interactive API documentation
GET  /v1/docs/openapi.json               — Raw OpenAPI 3.1 spec (JSON)
GET  /v1/docs/openapi.yaml               — Raw OpenAPI 3.1 spec (YAML)
```

---

## OpenAPI Specification & Documentation

The API automatically generates an OpenAPI 3.1 specification from the Fastify JSON Schemas defined in each route. This spec is served as a raw JSON/YAML file and rendered as interactive documentation using ReDoc.

### How It Works

Fastify's route schemas (the same ones used for request validation and TypeScript inference) are the single source of truth. The `@fastify/swagger` plugin reads these schemas at startup and generates a complete OpenAPI spec. No separate spec file is maintained manually — the spec is always in sync with the actual route handlers.

```
Route schemas (src/schemas/) → @fastify/swagger → OpenAPI 3.1 spec
                                                       │
                                          ┌────────────┼────────────┐
                                          ▼            ▼            ▼
                                    /docs/openapi.json  /docs/openapi.yaml
                                                       │
                                                       ▼
                                              /docs (ReDoc UI)
```

### Setup

Register `@fastify/swagger` as a plugin in `index.ts`. This generates the spec from route schemas. Then serve ReDoc as a static HTML page that loads the spec.

```typescript
// src/plugins/swagger.ts
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import { FastifyInstance } from 'fastify';
import { env } from '@config/env';

export default fp(async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Ninja Skyblock API',
        description: 'Backend API proxying and extending the Hypixel API for SkyBlock endpoints.',
        version: '1.0.0',
        contact: {
          name: 'API Support',
        },
      },
      servers: [
        {
          url: env.NODE_ENV === 'production'
            ? 'https://api.yourdomain.com'
            : `http://localhost:${env.PORT}`,
          description: env.NODE_ENV === 'production' ? 'Production' : 'Local development',
        },
      ],
      tags: [
        { name: 'skyblock', description: 'SkyBlock profile, skills, networth, and dungeon endpoints' },
        { name: 'bazaar', description: 'Bazaar pricing, live data, and price history' },
        { name: 'auctions', description: 'Auction house lookups and lowest BIN tracking' },
        { name: 'events', description: 'Real-time event streams (SSE and WebSocket)' },
        { name: 'health', description: 'Service health and status' },
      ],
      components: {
        securitySchemes: {
          hmac: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Signature',
            description: 'HMAC-SHA256 signature over request body + timestamp',
          },
          apiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'API key for public consumers',
          },
        },
      },
    },
  });
});
```

### Serving the Raw Spec

`@fastify/swagger` exposes the spec programmatically. Register routes that return it as JSON and YAML:

```typescript
// src/routes/v1/docs/spec.ts
import { FastifyInstance } from 'fastify';
import yaml from 'yaml';

export default async function (app: FastifyInstance) {
  // JSON spec
  app.get('/v1/docs/openapi.json', {
    schema: { hide: true },  // Don't include this route in the spec itself
  }, async (request, reply) => {
    return app.swagger();
  });

  // YAML spec
  app.get('/v1/docs/openapi.yaml', {
    schema: { hide: true },
  }, async (request, reply) => {
    reply.type('text/yaml');
    return yaml.stringify(app.swagger());
  });
}
```

### Serving ReDoc

ReDoc is a zero-config, responsive documentation UI that renders any OpenAPI spec. Serve it as a static HTML page that loads the spec from the JSON endpoint. No build step, no npm dependency — it loads from CDN.

```typescript
// src/routes/v1/docs/redoc.ts
import { FastifyInstance } from 'fastify';

const REDOC_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Ninja Skyblock API — Documentation</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init('/v1/docs/openapi.json', {
      theme: {
        colors: { primary: { main: '#4F46E5' } },
        typography: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          headings: { fontFamily: 'system-ui, -apple-system, sans-serif' },
        },
      },
      hideDownloadButton: false,
      expandResponses: '200',
      pathInMiddlePanel: true,
      sortTagsAlphabetically: true,
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

export default async function (app: FastifyInstance) {
  app.get('/v1/docs', {
    schema: { hide: true },
  }, async (request, reply) => {
    reply.type('text/html');
    return REDOC_HTML;
  });
}
```

### Writing Route Schemas That Generate Good Docs

The OpenAPI spec quality depends entirely on the JSON Schemas attached to each route. Every route must include a complete schema with descriptions, tags, response types, **inline examples**, and **detailed property types**. ReDoc renders examples as copy-pasteable code blocks in the right panel — this is how developers understand your API without trial and error.

**Complete route example with examples, data types, and descriptions:**

```typescript
// Example: src/routes/v1/skyblock/profile.ts
import { FastifyInstance } from 'fastify';

export default async function (app: FastifyInstance) {
  app.get('/v1/skyblock/profile/:uuid', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get SkyBlock profile',
      description: [
        'Returns the active SkyBlock profile for a player, including skills, slayers, dungeon stats, and bank balance.',
        '',
        '**Caching:** Responses are cached for 60 seconds. The `meta.cached` and `meta.cache_age_seconds` fields indicate cache status.',
        '',
        '**Rate limiting:** This endpoint consumes 1 request from your rate limit quota.',
      ].join('\n'),
      params: {
        type: 'object',
        required: ['uuid'],
        properties: {
          uuid: {
            type: 'string',
            pattern: '^[a-f0-9]{32}$',
            description: 'Minecraft UUID (32 hex characters, no hyphens). Use the Mojang API to convert a username to UUID.',
            examples: ['d8d5a9237b2043d8883b1150148d6955'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          description: 'Successful profile lookup',
          properties: {
            success: { type: 'boolean', const: true },
            data: { $ref: 'skyblock-profile#' },
            meta: { $ref: 'response-meta#' },
          },
          examples: [
            {
              success: true,
              data: {
                uuid: 'd8d5a9237b2043d8883b1150148d6955',
                profile_id: 'abc123def456',
                cute_name: 'Pomegranate',
                selected: true,
                skills: {
                  combat: { level: 50, xp: 55172015, progress: 1.0 },
                  mining: { level: 60, xp: 111672425, progress: 1.0 },
                  farming: { level: 50, xp: 55172015, progress: 1.0 },
                  foraging: { level: 40, xp: 13174542, progress: 0.72 },
                  fishing: { level: 35, xp: 7634885, progress: 0.45 },
                  enchanting: { level: 60, xp: 111672425, progress: 1.0 },
                  alchemy: { level: 50, xp: 55172015, progress: 1.0 },
                  taming: { level: 50, xp: 55172015, progress: 1.0 },
                  carpentry: { level: 42, xp: 16842752, progress: 0.31 },
                },
                skill_average: 48.56,
                networth: {
                  total: 12450000000,
                  breakdown: {
                    inventory: 3200000000,
                    bank: 500000000,
                    sacks: 180000000,
                    enderchest: 4100000000,
                    wardrobe: 2800000000,
                    pets: 1670000000,
                  },
                },
                dungeons: {
                  catacombs_level: 42,
                  secrets_found: 54210,
                  selected_class: 'mage',
                  class_levels: {
                    healer: 30, mage: 42, berserk: 35, archer: 28, tank: 25,
                  },
                },
                slayers: {
                  zombie: { level: 9, xp: 1500000 },
                  spider: { level: 9, xp: 1200000 },
                  wolf: { level: 9, xp: 1000000 },
                  enderman: { level: 9, xp: 900000 },
                  blaze: { level: 7, xp: 500000 },
                  vampire: { level: 5, xp: 200000 },
                },
                bank_balance: 500000000,
              },
              meta: {
                cached: true,
                cache_age_seconds: 23,
                timestamp: 1711500000000,
              },
            },
          ],
        },
        404: {
          type: 'object',
          description: 'Player has no SkyBlock profiles, or UUID does not exist on Hypixel.',
          properties: {
            success: { type: 'boolean', const: false },
            error: { $ref: 'error-object#' },
            meta: { $ref: 'response-meta#' },
          },
          examples: [
            {
              success: false,
              error: {
                code: 'PROFILE_NOT_FOUND',
                message: 'No SkyBlock profile found for player d8d5a9237b2043d8883b1150148d6955.',
                status: 404,
              },
              meta: { timestamp: 1711500000000 },
            },
          ],
        },
        429: {
          type: 'object',
          description: 'Client has exceeded their rate limit. Retry after the time indicated in the `Retry-After` response header.',
          properties: {
            success: { type: 'boolean', const: false },
            error: { $ref: 'error-object#' },
            meta: { $ref: 'response-meta#' },
          },
          examples: [
            {
              success: false,
              error: {
                code: 'RATE_LIMITED',
                message: 'Rate limit exceeded. Try again shortly.',
                status: 429,
              },
              meta: { timestamp: 1711500000000 },
            },
          ],
        },
      },
    },
  }, async (request, reply) => {
    // ... handler implementation
  });
}
```

**Bazaar endpoint with query parameters and history examples:**

```typescript
// Example: src/routes/v1/skyblock/bazaar.ts

// GET /v1/skyblock/bazaar/:itemId
app.get('/v1/skyblock/bazaar/:itemId', {
  schema: {
    tags: ['bazaar'],
    summary: 'Get bazaar product data',
    description: 'Returns current buy/sell prices, volume, and order book summary for a bazaar product.',
    params: {
      type: 'object',
      required: ['itemId'],
      properties: {
        itemId: {
          type: 'string',
          description: 'Hypixel item ID in SCREAMING_SNAKE_CASE.',
          examples: ['ENCHANTED_DIAMOND', 'BOOSTER_COOKIE', 'FUMING_POTATO_BOOK'],
        },
      },
    },
    response: {
      200: {
        type: 'object',
        description: 'Current bazaar data for the product',
        properties: {
          success: { type: 'boolean', const: true },
          data: { $ref: 'bazaar-product#' },
          meta: { $ref: 'response-meta#' },
        },
        examples: [
          {
            success: true,
            data: {
              item_id: 'ENCHANTED_DIAMOND',
              buy_price: 250.5,
              sell_price: 248.1,
              buy_volume: 1245832,
              sell_volume: 987421,
              buy_orders: 342,
              sell_orders: 287,
              buy_moving_week: 45000000,
              sell_moving_week: 43500000,
            },
            meta: { cached: true, cache_age_seconds: 12, timestamp: 1711500000000 },
          },
        ],
      },
    },
  },
}, handler);

// GET /v1/skyblock/bazaar/:itemId/history
app.get('/v1/skyblock/bazaar/:itemId/history', {
  schema: {
    tags: ['bazaar'],
    summary: 'Get bazaar price history',
    description: [
      'Returns historical price snapshots for a bazaar product.',
      'Snapshots are recorded every 60 seconds. Older ranges return downsampled data (averaged over 5-minute or 1-hour windows).',
    ].join('\n'),
    params: {
      type: 'object',
      required: ['itemId'],
      properties: {
        itemId: {
          type: 'string',
          description: 'Hypixel item ID.',
          examples: ['ENCHANTED_DIAMOND'],
        },
      },
    },
    querystring: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          enum: ['1h', '6h', '24h', '7d', '30d'],
          default: '24h',
          description: 'Time range for history. Shorter ranges return higher resolution data.',
        },
      },
    },
    response: {
      200: {
        type: 'object',
        description: 'Price history with datapoints',
        properties: {
          success: { type: 'boolean', const: true },
          data: {
            type: 'object',
            properties: {
              item_id: { type: 'string' },
              range: { type: 'string' },
              resolution: {
                type: 'string',
                enum: ['1m', '5m', '1h'],
                description: 'Time between data points. 1m for 1h/6h ranges, 5m for 24h, 1h for 7d/30d.',
              },
              datapoints: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    timestamp: { type: 'number', description: 'Unix timestamp (ms)' },
                    buy_price: { type: 'number', description: 'Average buy price in this window' },
                    sell_price: { type: 'number', description: 'Average sell price in this window' },
                    buy_volume: { type: 'integer', description: 'Total buy volume in this window' },
                    sell_volume: { type: 'integer', description: 'Total sell volume in this window' },
                  },
                },
              },
            },
          },
          meta: { $ref: 'response-meta#' },
        },
        examples: [
          {
            success: true,
            data: {
              item_id: 'ENCHANTED_DIAMOND',
              range: '24h',
              resolution: '5m',
              datapoints: [
                { timestamp: 1711413600000, buy_price: 248.3, sell_price: 246.1, buy_volume: 52000, sell_volume: 48000 },
                { timestamp: 1711413900000, buy_price: 249.1, sell_price: 247.0, buy_volume: 51200, sell_volume: 47500 },
                { timestamp: 1711414200000, buy_price: 251.7, sell_price: 249.5, buy_volume: 53100, sell_volume: 49200 },
              ],
            },
            meta: { cached: false, cache_age_seconds: null, timestamp: 1711500000000 },
          },
        ],
      },
    },
  },
}, handler);
```

**Auctions endpoint with query parameters and multiple examples:**

```typescript
// Example: src/routes/v1/skyblock/auctions.ts

app.get('/v1/skyblock/auctions/lowest/:item', {
  schema: {
    tags: ['auctions'],
    summary: 'Get lowest BIN price',
    description: 'Returns the current lowest Buy-It-Now listing for an item, including the seller and auction details.',
    params: {
      type: 'object',
      required: ['item'],
      properties: {
        item: {
          type: 'string',
          description: 'Item ID or common name. Accepts Hypixel item IDs (ASPECT_OF_THE_END) or search terms (aspect of the end).',
          examples: ['HYPERION', 'ASPECT_OF_THE_END', 'TERMINATOR'],
        },
      },
    },
    response: {
      200: {
        type: 'object',
        description: 'Lowest BIN listing found',
        properties: {
          success: { type: 'boolean', const: true },
          data: {
            type: 'object',
            properties: {
              item_id: { type: 'string', description: 'Canonical Hypixel item ID' },
              item_name: { type: 'string', description: 'Display name of the item' },
              lowest_bin: { type: 'number', description: 'Lowest BIN price in coins' },
              second_lowest_bin: { type: 'number', description: 'Second lowest BIN for price context' },
              average_bin: { type: 'number', description: 'Average of the lowest 5 BINs' },
              recent_sales: {
                type: 'array',
                description: 'Last 3 completed sales of this item from the AH',
                items: {
                  type: 'object',
                  properties: {
                    price: { type: 'number' },
                    timestamp: { type: 'number' },
                    buyer_uuid: { type: 'string' },
                  },
                },
              },
              listing: {
                type: 'object',
                description: 'Details of the lowest BIN listing',
                properties: {
                  auction_id: { type: 'string' },
                  seller_uuid: { type: 'string' },
                  price: { type: 'number' },
                  started: { type: 'number', description: 'Unix timestamp (ms) when listed' },
                  item_lore: { type: 'string', description: 'Full item lore including enchantments and reforges' },
                },
              },
            },
          },
          meta: { $ref: 'response-meta#' },
        },
        examples: [
          {
            success: true,
            data: {
              item_id: 'HYPERION',
              item_name: 'Hyperion',
              lowest_bin: 580000000,
              second_lowest_bin: 585000000,
              average_bin: 592000000,
              recent_sales: [
                { price: 575000000, timestamp: 1711498500000, buyer_uuid: 'a1b2c3d4e5f6' },
                { price: 590000000, timestamp: 1711495200000, buyer_uuid: 'f6e5d4c3b2a1' },
                { price: 582000000, timestamp: 1711491800000, buyer_uuid: '1a2b3c4d5e6f' },
              ],
              listing: {
                auction_id: 'auc_9f8e7d6c5b4a',
                seller_uuid: 'abcdef123456',
                price: 580000000,
                started: 1711499000000,
                item_lore: '§6Hyperion §d§lLEGENDARY SWORD\n§7Damage: §c+260\n§7Strength: §c+150\n§9Withered §6Hyperion\n§7§4❣ §cOne For All V',
              },
            },
            meta: { cached: true, cache_age_seconds: 8, timestamp: 1711500000000 },
          },
        ],
      },
    },
  },
}, handler);
```

### Shared Schema Refs

Register reusable schemas with Fastify so they appear as `$ref` components in the OpenAPI spec. Define these in `src/schemas/common.ts`. Every shared schema must include `description` on each property and `examples` on the schema itself.

```typescript
// src/schemas/common.ts
import { FastifyInstance } from 'fastify';

export function registerSharedSchemas(app: FastifyInstance) {

  // --- Response envelope components ---

  app.addSchema({
    $id: 'response-meta',
    type: 'object',
    description: 'Metadata about the response, including cache status and timing.',
    properties: {
      cached: { type: 'boolean', description: 'Whether this response was served from Redis cache.' },
      cache_age_seconds: {
        type: ['number', 'null'],
        description: 'How many seconds ago the cached data was fetched from Hypixel. `null` if this is a fresh (non-cached) response.',
      },
      timestamp: { type: 'number', description: 'Unix timestamp in milliseconds when the response was generated.' },
    },
    examples: [
      { cached: true, cache_age_seconds: 23, timestamp: 1711500000000 },
      { cached: false, cache_age_seconds: null, timestamp: 1711500000000 },
    ],
  });

  app.addSchema({
    $id: 'error-object',
    type: 'object',
    description: 'Structured error information. The `code` field is machine-readable and stable across versions.',
    properties: {
      code: {
        type: 'string',
        description: 'Machine-readable error code. Use this for programmatic error handling.',
        enum: [
          'VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN',
          'PLAYER_NOT_FOUND', 'PROFILE_NOT_FOUND', 'RESOURCE_NOT_FOUND',
          'RATE_LIMITED', 'HYPIXEL_API_ERROR', 'HYPIXEL_RATE_LIMITED',
          'HYPIXEL_UNAVAILABLE', 'INTERNAL_ERROR',
        ],
      },
      message: { type: 'string', description: 'Human-readable error description. Do not parse this — use `code` instead.' },
      status: { type: 'integer', description: 'HTTP status code (mirrors the response status).' },
    },
    examples: [
      { code: 'PLAYER_NOT_FOUND', message: 'No SkyBlock profile found for this player.', status: 404 },
      { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Try again shortly.', status: 429 },
      { code: 'HYPIXEL_UNAVAILABLE', message: 'Hypixel API is currently unavailable. Retry later.', status: 503 },
    ],
  });

  // --- Shared parameter schemas ---

  app.addSchema({
    $id: 'uuid-param',
    type: 'object',
    required: ['uuid'],
    properties: {
      uuid: {
        type: 'string',
        pattern: '^[a-f0-9]{32}$',
        description: 'Minecraft UUID — 32 hexadecimal characters with no hyphens. Convert usernames to UUIDs via the Mojang API (`GET https://api.mojang.com/users/profiles/minecraft/{username}`).',
        examples: ['d8d5a9237b2043d8883b1150148d6955', 'b876ec32e396476ba1158438d83c67d4'],
      },
    },
  });

  // --- SkyBlock data type schemas ---

  app.addSchema({
    $id: 'skyblock-profile',
    type: 'object',
    description: 'Processed SkyBlock profile data for a single player. Contains computed values (networth, skill averages) not present in the raw Hypixel API.',
    properties: {
      uuid: { type: 'string', description: 'Player UUID.' },
      profile_id: { type: 'string', description: 'SkyBlock profile ID.' },
      cute_name: { type: 'string', description: 'Profile fruit name (e.g. Pomegranate, Blueberry).' },
      selected: { type: 'boolean', description: 'Whether this is the player\'s currently selected profile.' },
      skills: {
        type: 'object',
        description: 'All skill levels and XP. Each skill has `level` (integer), `xp` (total XP earned), and `progress` (0.0–1.0 toward next level).',
        additionalProperties: {
          type: 'object',
          properties: {
            level: { type: 'integer', minimum: 0, description: 'Current skill level.' },
            xp: { type: 'number', minimum: 0, description: 'Total XP earned in this skill.' },
            progress: { type: 'number', minimum: 0, maximum: 1, description: 'Progress toward the next level (0.0 = just leveled, 1.0 = max level).' },
          },
        },
      },
      skill_average: { type: 'number', description: 'Average of all skill levels, rounded to 2 decimal places.' },
      networth: {
        type: 'object',
        description: 'Estimated networth computed from current bazaar/AH prices.',
        properties: {
          total: { type: 'number', description: 'Total networth in coins.' },
          breakdown: {
            type: 'object',
            description: 'Networth broken down by storage location.',
            properties: {
              inventory: { type: 'number' },
              bank: { type: 'number' },
              sacks: { type: 'number' },
              enderchest: { type: 'number' },
              wardrobe: { type: 'number' },
              pets: { type: 'number' },
            },
          },
        },
      },
      dungeons: {
        type: 'object',
        description: 'Dungeon (Catacombs) stats.',
        properties: {
          catacombs_level: { type: 'integer', description: 'Overall Catacombs level.' },
          secrets_found: { type: 'integer', description: 'Total dungeon secrets found.' },
          selected_class: { type: 'string', enum: ['healer', 'mage', 'berserk', 'archer', 'tank'] },
          class_levels: {
            type: 'object',
            description: 'Level per dungeon class.',
            properties: {
              healer: { type: 'integer' }, mage: { type: 'integer' }, berserk: { type: 'integer' },
              archer: { type: 'integer' }, tank: { type: 'integer' },
            },
          },
        },
      },
      slayers: {
        type: 'object',
        description: 'Slayer boss progression. Each slayer has `level` and `xp`.',
        additionalProperties: {
          type: 'object',
          properties: {
            level: { type: 'integer', minimum: 0, description: 'Current slayer level.' },
            xp: { type: 'number', minimum: 0, description: 'Total slayer XP earned.' },
          },
        },
      },
      bank_balance: { type: 'number', description: 'Coins in the player\'s bank (shared across co-op).' },
    },
  });

  app.addSchema({
    $id: 'bazaar-product',
    type: 'object',
    description: 'Current bazaar state for a single product.',
    properties: {
      item_id: { type: 'string', description: 'Hypixel item ID (SCREAMING_SNAKE_CASE).' },
      buy_price: { type: 'number', description: 'Instant buy price (lowest sell order).' },
      sell_price: { type: 'number', description: 'Instant sell price (highest buy order).' },
      buy_volume: { type: 'integer', description: 'Total items available for instant buy.' },
      sell_volume: { type: 'integer', description: 'Total items wanted by buy orders.' },
      buy_orders: { type: 'integer', description: 'Number of active sell orders.' },
      sell_orders: { type: 'integer', description: 'Number of active buy orders.' },
      buy_moving_week: { type: 'integer', description: 'Total items instant-bought in the last 7 days.' },
      sell_moving_week: { type: 'integer', description: 'Total items instant-sold in the last 7 days.' },
    },
    examples: [
      {
        item_id: 'ENCHANTED_DIAMOND',
        buy_price: 250.5, sell_price: 248.1,
        buy_volume: 1245832, sell_volume: 987421,
        buy_orders: 342, sell_orders: 287,
        buy_moving_week: 45000000, sell_moving_week: 43500000,
      },
      {
        item_id: 'BOOSTER_COOKIE',
        buy_price: 1850000, sell_price: 1842000,
        buy_volume: 15420, sell_volume: 12300,
        buy_orders: 89, sell_orders: 124,
        buy_moving_week: 380000, sell_moving_week: 365000,
      },
    ],
  });

  app.addSchema({
    $id: 'skill-data',
    type: 'object',
    description: 'Computed skill data for a player.',
    properties: {
      uuid: { type: 'string' },
      skill_average: { type: 'number', description: 'Average across all skills (2 decimal places).' },
      total_xp: { type: 'number', description: 'Sum of all skill XP.' },
      skills: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            level: { type: 'integer' },
            xp: { type: 'number' },
            progress: { type: 'number' },
            rank: { type: 'string', description: 'Percentile rank (e.g. "top 5%"). Only included if profile tracking is enabled.', nullable: true },
          },
        },
      },
    },
    examples: [
      {
        uuid: 'd8d5a9237b2043d8883b1150148d6955',
        skill_average: 48.56,
        total_xp: 523891245,
        skills: {
          combat: { level: 50, xp: 55172015, progress: 1.0, rank: null },
          mining: { level: 60, xp: 111672425, progress: 1.0, rank: null },
          farming: { level: 50, xp: 55172015, progress: 1.0, rank: null },
        },
      },
    ],
  });

  app.addSchema({
    $id: 'networth-data',
    type: 'object',
    description: 'Computed networth breakdown. Prices are based on current bazaar instant-sell and lowest BIN auction values.',
    properties: {
      uuid: { type: 'string' },
      total: { type: 'number', description: 'Total estimated networth in coins.' },
      breakdown: {
        type: 'object',
        properties: {
          inventory: { type: 'number', description: 'Value of items in inventory.' },
          bank: { type: 'number', description: 'Coins in bank.' },
          sacks: { type: 'number', description: 'Value of items in sacks.' },
          enderchest: { type: 'number', description: 'Value of ender chest contents.' },
          wardrobe: { type: 'number', description: 'Value of wardrobe armor sets.' },
          pets: { type: 'number', description: 'Value of pets based on level, type, and held item.' },
          accessories: { type: 'number', description: 'Value of accessory bag contents.' },
        },
      },
      prices_as_of: { type: 'number', description: 'Timestamp of the bazaar/AH price data used for computation.' },
    },
    examples: [
      {
        uuid: 'd8d5a9237b2043d8883b1150148d6955',
        total: 12450000000,
        breakdown: {
          inventory: 3200000000, bank: 500000000, sacks: 180000000,
          enderchest: 4100000000, wardrobe: 2800000000, pets: 1670000000,
          accessories: 0,
        },
        prices_as_of: 1711499700000,
      },
    ],
  });
}
```

### Example Requests in Descriptions

For endpoints that accept query parameters or have non-obvious usage patterns, include example `curl` commands in the `description` field. ReDoc renders these as formatted markdown.

```typescript
// In a route schema:
description: [
  'Returns historical price snapshots for a bazaar product.',
  '',
  '**Example requests:**',
  '```',
  '# Last 24 hours (default)',
  'GET /v1/skyblock/bazaar/ENCHANTED_DIAMOND/history',
  '',
  '# Last 7 days',
  'GET /v1/skyblock/bazaar/ENCHANTED_DIAMOND/history?range=7d',
  '',
  '# Last hour (highest resolution)',
  'GET /v1/skyblock/bazaar/BOOSTER_COOKIE/history?range=1h',
  '```',
  '',
  '**Resolution by range:**',
  '| Range | Resolution | Approx. datapoints |',
  '|-------|------------|-------------------|',
  '| 1h    | 1 minute   | 60                |',
  '| 6h    | 1 minute   | 360               |',
  '| 24h   | 5 minutes  | 288               |',
  '| 7d    | 1 hour     | 168               |',
  '| 30d   | 1 hour     | 720               |',
].join('\n'),
```

### Dependencies

```bash
npm install @fastify/swagger yaml
```

No additional dependency for ReDoc — it loads from CDN at runtime in the browser.

**Rules for Claude Code:**
- Every route MUST include a `schema` object with `tags`, `summary`, `description`, `params`/`querystring` (if applicable), and `response` blocks for at least 200 and relevant error codes (400/404/429).
- Every response block MUST include an `examples` array with at least one realistic, complete example response. Examples must use realistic SkyBlock data (real item IDs, plausible prices, valid UUIDs).
- Every property in a response schema MUST have a `description` string. No undocumented fields.
- Every `params` and `querystring` property MUST include `examples` (array of example values) and a `description`.
- Enum fields MUST list all valid values. Include `default` where applicable.
- Use `$ref` for shared shapes (response meta, error objects, UUID params, data type schemas). Never duplicate schema definitions across routes.
- Shared data type schemas (like `skyblock-profile`, `bazaar-product`) are registered in `src/schemas/common.ts`. Endpoint-specific response shapes can be defined inline in the route schema.
- Routes that should not appear in the spec (like `/v1/docs` itself) must include `schema: { hide: true }`.
- `summary` is a short one-line label (shown in the sidebar). `description` is rich markdown — use it for caching behavior notes, example requests, tables, and usage guidance.
- For complex endpoints, include example `curl`/`GET` commands in the `description` using markdown code blocks.
- When adding a new endpoint, verify it appears correctly in the ReDoc UI at `/v1/docs` — check that examples render in the right panel, descriptions are formatted, and $ref links resolve.
- The raw spec at `/v1/docs/openapi.json` must be valid — test by pasting into the [Swagger Editor](https://editor.swagger.io) if in doubt.

---

## Authentication Strategy

| Client     | Method                    | Details                                                                 |
| ---------- | ------------------------- | ----------------------------------------------------------------------- |
| Fabric Mod | HMAC-signed requests      | Shared secret generates signature over body + timestamp. No raw key in JAR. |
| Web App    | OAuth2 / session cookies  | Standard browser auth flow.                                             |
| Discord Bot| Internal API key          | Server-side only, never exposed to end users.                           |
| Public API | API keys + rate limiting  | Issued per developer. Stricter rate limits, endpoint subset.            |

Each auth strategy is a Fastify plugin that decorates the request with a verified identity and permission tier.

---

## Real-Time Layer

Three technologies, one event source:

**Redis Pub/Sub (internal backbone):** Workers publish events to channels. All real-time delivery reads from here. Channels: `bazaar:alerts`, `auction:alerts`, `auction:ending`, `profile:changes`.

**SSE (web app):** One-way server → client. Client opens `GET /v1/events/bazaar/stream`. Server writes `data: {json}\n\n` on each event. Auto-reconnects. Works through CDNs. ~20 lines of custom code on top of Fastify's response stream.

**WebSocket (Discord bot + advanced subscribers):** Bidirectional. Client connects to `WS /v1/events/subscribe`, sends subscription messages (item filters, price thresholds). Server pushes matching events. Use the `ws` library for protocol handling, custom subscription matching logic on top.

All three read from the same Redis pub/sub channels. Adding a new delivery mechanism later (push notifications, webhooks) means subscribing to the same channels.

---

## Background Workers

All workers use BullMQ with Redis as the backend.

### Bazaar Price Tracker
- **Schedule:** Every 60 seconds
- **Priority:** 3 (low — background)
- **Action:** Fetch all bazaar products, compare with previous snapshot, store in Postgres via PostgREST, update Redis warm cache. Publish event if any product's price changes by more than a configurable threshold (e.g. 5%).

### Auction House Scanner
- **Schedule:** Every 30–60 seconds
- **Priority:** 3 (low)
- **Action:** Fetch active auctions (paginated, potentially many pages). Detect new lowest BINs per item. Detect auctions ending within configurable window (e.g. 2 minutes). Publish events for matched alert subscriptions.

### Profile Tracker
- **Schedule:** Every 5 minutes for watched players
- **Priority:** 2 (medium)
- **Action:** Fetch profiles for players on the watch list. Diff against previous snapshot. Detect skill gains, slayer completions, dungeon milestones. Store snapshots via PostgREST → Postgres. Publish events for profile changes.

---

## Infrastructure & Deployment

### Local Development

Docker Compose with four services:

```yaml
services:
  api:
    build: .
    ports: ["3000:3000"]
    depends_on: [redis, postgrest]
    environment:
      REDIS_URL: redis://redis:6379
      POSTGREST_URL: http://postgrest:3000
      HYPIXEL_API_KEY: ${HYPIXEL_API_KEY}

  postgrest:
    image: postgrest/postgrest
    ports: ["3001:3000"]
    depends_on: [postgres]
    environment:
      PGRST_DB_URI: postgresql://user:pass@postgres:5432/ninja_skyblock
      PGRST_DB_ANON_ROLE: api_anon
      PGRST_DB_SCHEMAS: public
      PGRST_OPENAPI_SERVER_PROXY_URI: http://localhost:3001

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: ninja_skyblock
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

**Note:** The `api_anon` Postgres role must be created during initial database setup with appropriate permissions on your tables. A setup SQL script should create the role and grant access:

```sql
CREATE ROLE api_anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO api_anon;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO api_anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO api_anon;
```

### Production (when needed)

- Single VPS (Hetzner or Oracle Cloud free tier) running Docker Compose handles surprising traffic.
- When scaling: separate containers on Railway/Fly.io, managed Redis (Upstash), managed Postgres (Neon/Supabase).
- Monitoring: Prometheus + Grafana, or Axiom/Betterstack for logs. Track Hypixel API usage against rate limits.

---

## Development Priorities

> **Core logic first. Everything else is scaffolding.**

The single most important thing is that the basic API works — a request comes in, data comes back correctly, caching behaves as expected, and Hypixel rate limits aren't exceeded. Every other feature (logging, testing, OpenAPI docs, CI/CD, monitoring) exists to support and protect the core, not the other way around.

### What "core working correctly" means

Before any polish or auxiliary feature is added, the following must be true:

1. **Fastify boots and serves requests.** A `GET /v1/skyblock/profile/:uuid` returns real data from Hypixel in the correct response envelope.
2. **Redis caching works end-to-end.** First request fetches from Hypixel, second request returns cached data with `meta.cached: true`. TTLs expire correctly. Stale-while-revalidate serves stale data and triggers a background refresh.
3. **Hypixel proxy respects rate limits.** The request queue enforces priority ordering. The rate limiter tracks key usage and applies backpressure before hitting Hypixel's 120 req/min ceiling. Retry logic handles 429/503/403 correctly.
4. **The response envelope is consistent.** Every success returns `{ success: true, data, meta }`. Every error returns `{ success: false, error, meta }`. No raw data leaks outside the envelope.
5. **HMAC authentication works.** Unsigned requests are rejected with 401. Correctly signed requests pass through. Replay protection (timestamp check) works.
6. **Docker Compose brings up the full stack.** `docker compose up` starts the API, Redis, Postgres, and PostgREST. The API connects to all dependencies and serves requests.

Only after all six of these are verified should you move to secondary features.

### Build order within each phase

Each phase in the Build Order below is broken into **core** and **then** steps. Complete all core steps and verify they work before starting the "then" items. Do not interleave — do not add Pino logging while the cache manager is half-built, do not write Vitest tests for routes that don't exist yet, do not configure GitHub Actions before there's code to test.

**Rules for Claude Code:**
- When implementing a phase, build the core functionality first with minimal `console.log` debugging. Only wire up Pino structured logging after the feature works correctly.
- Do not add test files for a service until the service is implemented, working, and returning correct results.
- Do not add OpenAPI schema `examples` until the endpoint is functional and you know the real response shape.
- Do not optimize, refactor, or add abstractions until the straightforward version works. Get it working, then get it right, then get it fast.
- If a core feature is broken, fixing it takes priority over everything else — including features that are "almost done" on other branches.

---

## Build Order

### Phase 1 — Foundation (serves the Fabric mod)

**Core (build and verify first):**

1. Docker Compose with Fastify, Redis, Postgres, PostgREST — `docker compose up` works
2. `src/config/env.ts` — environment variable parsing, app boots without crashing
3. Hypixel API client — fetches a real player profile from Hypixel, handles errors
4. Cache manager — write to Redis, read from Redis, TTL expiry works, stale-while-revalidate works
5. Rate limiter — tracks Hypixel key usage, blocks requests when approaching ceiling
6. First route: `GET /v1/skyblock/profile/:uuid` — end-to-end from request to response envelope
7. HMAC auth plugin — unsigned requests rejected, signed requests pass through
8. Core processors — networth calculation and skill aggregation return correct numbers

**Verify:** At this point, the mod can call the API, get cached profile data, and the API doesn't exceed Hypixel rate limits. Test this manually by making requests with `curl` or the mod itself.

**Then (add once core is solid):**

9. Pino structured logging across all services
10. OpenAPI spec generation + ReDoc documentation UI
11. Remaining SkyBlock routes (bazaar, auctions, dungeons, slayers, collections)
12. Vitest unit tests for processors, integration tests for routes
13. Error handling refinement — all `AppError` codes, global error handler
14. PostgREST client wrapper with typed helpers

**Outcome:** The mod has a fully functional backend with caching, rate limiting, auth, and documentation.

### Phase 2 — Background Intelligence

**Core:**

1. BullMQ queue setup — jobs are created, processed, and completed
2. Bazaar tracker worker — polls Hypixel, stores snapshots via PostgREST
3. PostgreSQL schema (via node-pg-migrate) — bazaar_snapshots, auction_sales, player_profiles tables
4. Bazaar history endpoint — reads from Postgres, returns time-series data

**Then:**

5. Auction scanner worker
6. Profile tracker worker
7. Postgres functions for complex aggregations
8. Tests for workers
9. Logging for worker cycles (duration, items processed, errors)

**Outcome:** Historical data accumulates. Bazaar price graphs work.

### Phase 3 — Real-Time Layer

**Core:**

1. Redis pub/sub — workers publish events, a subscriber receives them
2. SSE endpoint — web client connects, receives bazaar price events
3. WebSocket server — bot connects, subscribes to filters, receives matched events

**Then:**

4. Subscription matching logic (price thresholds, item filters)
5. Reconnection handling and subscription persistence
6. Tests for event bus and subscription matching
7. Logging for event publishing and delivery

**Outcome:** Live alerting works for Discord bot and web app.

### Phase 4 — Public Surface

**Core:**

1. API key management — issuance, validation, rate tier assignment
2. Public rate limiting (stricter tiers)
3. Discord bot — connects to WebSocket, sends alerts to channels

**Then:**

4. Web app frontend (Next.js or SvelteKit)
5. Public API documentation and onboarding
6. Bot commands for managing subscriptions

**Outcome:** Full product suite. All clients operational.

---

## Git Workflow & CI/CD

### Branching Strategy

Use a **trunk-based development** model with short-lived feature branches and pull requests into `main`.

```
main (protected — always deployable)
  ├── feat/profile-endpoint
  ├── feat/cache-manager
  ├── fix/rate-limiter-sliding-window
  ├── feat/bazaar-worker
  └── chore/ci-pipeline
```

**Branch naming convention:** `{type}/{short-description}` using kebab-case. Types match commit prefixes: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`, `test/`.

**Rules:**
- `main` is always deployable. Never push directly to `main`.
- Every change goes through a pull request — no exceptions, even for single-line fixes.
- Feature branches are short-lived. Target 1–3 days max. If a feature takes longer, break it into smaller PRs.
- Delete branches after merge. No long-lived feature branches.
- Rebase onto `main` before merging to keep history linear. Use squash merges for multi-commit branches to keep the log clean.

### Pull Request Requirements

Every PR must meet these criteria before merge. Configure these as branch protection rules on `main` in GitHub.

**PR template** (`.github/pull_request_template.md`):

```markdown
## Summary

<!-- What does this PR do? 1-3 sentences. -->

## Type of change

- [ ] feat: New feature or endpoint
- [ ] fix: Bug fix
- [ ] refactor: Code change that neither fixes a bug nor adds a feature
- [ ] docs: Documentation only
- [ ] test: Adding or updating tests
- [ ] chore: Build, CI, dependency updates

## Changes

<!-- List the specific things changed. Be precise. -->

-

## How to test

<!-- Steps for a reviewer to verify this works. Include curl commands or test instructions. -->

1.

## Checklist

- [ ] Route schema includes `tags`, `summary`, `description`, `params`, and `response` with `examples`
- [ ] All new/modified response fields have `description` in the JSON Schema
- [ ] `AppError` thrown for error cases — no raw `reply.status().send()` in route handlers
- [ ] No `any` types — all new code is fully typed
- [ ] No `process.env` usage outside `src/config/env.ts`
- [ ] New env vars added to `env.ts`, `.env.example`, and `docker-compose.yml`
- [ ] Pino logger used (no `console.log`)
- [ ] Unit tests written for new processors/services
- [ ] Integration tests written for new routes
- [ ] All tests pass locally (`npm test`)
- [ ] ReDoc docs render correctly at `/v1/docs` for new/modified endpoints
- [ ] OpenAPI spec is valid (no broken `$ref` links)
- [ ] CHANGELOG.md updated

## Related issues

<!-- Link any related GitHub issues. Use "Closes #123" to auto-close. -->
```

**Merge rules (GitHub branch protection on `main`):**
- Require at least 1 approving review (or self-review for solo development — still require the PR process for documentation and CI checks)
- Require all status checks to pass (CI pipeline)
- Require branch to be up to date with `main` before merging
- Require linear history (squash merge or rebase)

### GitHub Actions CI Pipeline

The CI pipeline runs on every push to a PR branch and on merge to `main`. It validates that nothing is broken before code reaches `main`.

**`.github/workflows/ci.yml`:**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    name: Lint & type check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck    # tsc --noEmit
      - run: npm run lint         # eslint

  test:
    name: Tests
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    services:
      redis:
        image: redis:7-alpine
        ports: [6379:6379]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      postgres:
        image: postgres:16-alpine
        ports: [5432:5432]
        env:
          POSTGRES_DB: ninja_skyblock_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
        env:
          REDIS_URL: redis://localhost:6379
          POSTGREST_URL: http://localhost:3001
          HYPIXEL_API_KEYS: test-key
          HMAC_SECRET: test-secret
          NODE_ENV: test

  build:
    name: Build
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build        # tsc

  validate-openapi:
    name: Validate OpenAPI spec
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Boot server and validate spec
        run: |
          # Start the server in background (skip external deps for spec generation)
          NODE_ENV=test npm start &
          sleep 3
          # Fetch the spec and validate
          curl -f http://localhost:3000/v1/docs/openapi.json -o openapi.json
          npx @redocly/cli lint openapi.json
          kill %1
        env:
          REDIS_URL: redis://localhost:6379
          POSTGREST_URL: http://localhost:3001
          HYPIXEL_API_KEYS: test-key
          HMAC_SECRET: test-secret
```

**Required npm scripts in `package.json`:**

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ tests/",
    "lint:fix": "eslint src/ tests/ --fix",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "migrate": "node-pg-migrate",
    "migrate:up": "node-pg-migrate up",
    "migrate:down": "node-pg-migrate down",
    "migrate:create": "node-pg-migrate create"
  }
}
```

### Changelog

Maintain a `CHANGELOG.md` in the repo root. Every PR that changes user-facing behavior (new endpoints, changed response shapes, fixed bugs, changed caching behavior) must add an entry. Internal refactors and CI changes don't need an entry.

Follow the [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- `GET /v1/skyblock/profile/:uuid` — player profile lookup with caching
- `GET /v1/skyblock/bazaar/:itemId` — current bazaar product data
- HMAC authentication for Fabric mod requests
- Redis caching with stale-while-revalidate pattern
- ReDoc API documentation at `/v1/docs`

### Changed
-

### Fixed
-

### Removed
-

## [1.0.0] - YYYY-MM-DD

Initial release.
```

**Rules for Claude Code:**
- When creating a new file, create it on a feature branch — never on `main` directly.
- Every new endpoint, service, or worker is its own PR with a filled-out PR template.
- The CHANGELOG.md `[Unreleased]` section is updated in the same PR as the feature it describes.
- The CI pipeline must pass before any merge. If tests fail, fix the tests — do not skip or disable them.
- When a batch of features is ready for release, move the `[Unreleased]` entries to a versioned section (e.g. `[1.1.0] - 2026-04-01`) and tag the commit.

### Release Process

When ready to cut a release:

1. Create a PR that moves `[Unreleased]` changelog entries to a new versioned section.
2. Bump the version in `package.json` and in the OpenAPI spec (`info.version` in `src/plugins/swagger.ts`).
3. Merge the release PR to `main`.
4. Tag the merge commit: `git tag v1.1.0 && git push origin v1.1.0`.
5. GitHub Actions can optionally trigger a deployment on tag push (add a deploy job gated on `tags: ['v*']`).

**Version scheme:** Semantic versioning. Bump `major` for breaking response shape changes (clients must update). Bump `minor` for new endpoints or features. Bump `patch` for bug fixes and internal changes.

**What counts as a breaking change (requires major bump):**
- Removing or renaming a response field
- Changing the type of a response field
- Removing an endpoint
- Changing authentication requirements
- Changing the response envelope structure

**What does NOT count as breaking (minor or patch):**
- Adding new response fields (clients should ignore unknown fields)
- Adding new endpoints
- Adding new optional query parameters
- Changing cache TTLs or internal behavior
- Fixing incorrect data in responses

---

## Project Directory Structure

All code lives under `src/`. Each top-level directory has a single responsibility. Do not create additional top-level directories without documented justification.

```
ninja-skyblock-api/
├── src/
│   ├── index.ts                    # Entry point — boots Fastify, registers plugins, starts server
│   ├── config/
│   │   ├── env.ts                  # Environment variable parsing + validation (see Environment Variables)
│   │   └── constants.ts            # Magic numbers, TTL values, rate limit tiers, Hypixel endpoints
│   ├── routes/
│   │   ├── v1/
│   │   │   ├── skyblock/
│   │   │   │   ├── profile.ts      # GET /v1/skyblock/profile/:uuid
│   │   │   │   ├── auctions.ts     # GET /v1/skyblock/auctions/*
│   │   │   │   ├── bazaar.ts       # GET /v1/skyblock/bazaar/*
│   │   │   │   ├── networth.ts     # GET /v1/skyblock/networth/:uuid
│   │   │   │   ├── skills.ts       # GET /v1/skyblock/skills/:uuid
│   │   │   │   ├── dungeons.ts     # GET /v1/skyblock/dungeons/:uuid
│   │   │   │   ├── slayers.ts      # GET /v1/skyblock/slayers/:uuid
│   │   │   │   └── collections.ts  # GET /v1/skyblock/collections/:uuid
│   │   │   └── events/
│   │   │       ├── stream.ts       # GET /v1/events/bazaar/stream (SSE)
│   │   │       └── subscribe.ts    # WS  /v1/events/subscribe (WebSocket)
│   │   │   └── docs/
│   │   │       ├── redoc.ts        # GET /v1/docs — serves ReDoc HTML page
│   │   │       └── spec.ts         # GET /v1/docs/openapi.json + openapi.yaml
│   │   └── health.ts               # GET /v1/health
│   ├── services/
│   │   ├── hypixel-client.ts       # Hypixel API client — fetch wrappers, retry logic, key rotation
│   │   ├── cache-manager.ts        # Tiered cache — hot/warm read/write, stale-while-revalidate
│   │   ├── rate-limiter.ts         # Dual rate limiting — client-facing + Hypixel-facing
│   │   ├── postgrest-client.ts     # Typed fetch wrapper for PostgREST sidecar
│   │   └── event-bus.ts            # Redis pub/sub abstraction — publish, subscribe, match
│   ├── workers/
│   │   ├── bazaar-tracker.ts       # Scheduled: poll bazaar, snapshot, publish deltas
│   │   ├── auction-scanner.ts      # Scheduled: scan AH, detect lowest BIN, ending-soon
│   │   └── profile-tracker.ts      # Scheduled: refresh watched players, diff snapshots
│   ├── processors/
│   │   ├── networth.ts             # Compute networth from raw profile data
│   │   ├── skills.ts               # Aggregate skill averages
│   │   └── dungeons.ts             # Compute dungeon stats (class levels, secrets, PB)
│   ├── plugins/
│   │   ├── auth.ts                 # Fastify plugin — HMAC, API key, OAuth2 strategies
│   │   ├── rate-limit.ts           # Fastify plugin — per-request rate limit hook
│   │   └── swagger.ts              # Fastify plugin — @fastify/swagger OpenAPI generation
│   ├── schemas/
│   │   ├── common.ts               # Shared schemas — response-meta, error-object, uuid-param, and all data type schemas (skyblock-profile, bazaar-product, skill-data, networth-data)
│   │   └── skyblock.ts             # JSON Schemas for SkyBlock endpoint-specific params and querystrings
│   ├── types/
│   │   ├── hypixel.ts              # TypeScript types for raw Hypixel API responses
│   │   ├── skyblock.ts             # Types for processed/computed SkyBlock data
│   │   └── api.ts                  # Types for this API's request/response shapes
│   └── utils/
│       ├── redis.ts                # ioredis singleton, connection config
│       ├── queue.ts                # BullMQ queue + worker factory helpers
│       └── logger.ts               # Pino logger instance + child logger factory
├── migrations/
│   ├── 001_initial-schema.sql      # Base tables: bazaar_snapshots, auction_sales, player_profiles
│   ├── 002_user-accounts.sql       # User accounts, API keys, subscriptions
│   └── ...                         # Numbered SQL migration files (node-pg-migrate)
├── sql/
│   └── functions/
│       ├── calculate_networth.sql  # Postgres function for networth RPC
│       └── aggregate_skills.sql    # Postgres function for skill aggregation RPC
├── tests/
│   ├── unit/
│   │   ├── services/               # Mirrors src/services/ — one test file per source file
│   │   ├── processors/             # Mirrors src/processors/
│   │   └── utils/                  # Mirrors src/utils/
│   ├── integration/
│   │   ├── routes/                 # Test route handlers with mocked services
│   │   └── workers/                # Test workers with mocked Hypixel + Redis
│   └── helpers/
│       ├── fixtures.ts             # Shared test data — sample API responses, profiles
│       └── mocks.ts                # Reusable mocks — Redis, PostgREST, Hypixel responses
├── docker-compose.yml
├── Dockerfile
├── tsconfig.json
├── vitest.config.ts
├── package.json
├── CHANGELOG.md                    # Keep a Changelog format — updated in every feature PR
├── .env.example
├── .github/
│   ├── pull_request_template.md    # PR checklist (see Git Workflow section)
│   └── workflows/
│       └── ci.yml                  # Lint, typecheck, test, build, validate OpenAPI spec
```

**Rules for Claude Code:**
- One route handler per file. Each file registers its own Fastify route(s) and exports the plugin.
- One worker per file. Each worker is a standalone BullMQ worker with its own processing function.
- One processor per file. Pure functions that take raw Hypixel data and return computed results.
- Services are singletons — instantiated once in `index.ts` and passed to routes/workers via Fastify's `decorate` or dependency injection.
- Never import from `../../../` — if the path has more than two `../` segments, the file is in the wrong directory.
- New endpoints go in `src/routes/v1/skyblock/`. New API versions get a `src/routes/v2/` directory.

---

## Naming Conventions & Code Style

### Files and Directories

- **Files:** `kebab-case.ts` always. Examples: `cache-manager.ts`, `bazaar-tracker.ts`, `calculate_networth.sql`.
- **Directories:** `kebab-case`. Examples: `src/services/`, `sql/functions/`.
- **Test files:** `{source-file-name}.test.ts` in the mirrored test directory. Example: `tests/unit/services/cache-manager.test.ts`.
- **Migration files:** `NNN_description.sql` with zero-padded 3-digit prefix. Example: `001_initial-schema.sql`.

### TypeScript Code

- **Variables and functions:** `camelCase`. Examples: `fetchProfile`, `cacheManager`, `bazaarPrices`.
- **Types and interfaces:** `PascalCase`. Examples: `SkyBlockProfile`, `BazaarSnapshot`, `ApiResponse<T>`.
- **Constants:** `SCREAMING_SNAKE_CASE` for true constants (config values, magic numbers). Examples: `HOT_CACHE_TTL_SECONDS`, `HYPIXEL_RATE_LIMIT`, `MAX_AUCTION_PAGES`.
- **Enums:** `PascalCase` name, `PascalCase` members. Example: `enum CacheTier { Hot, Warm, Cold }`.
- **Exports:** Named exports always. No default exports except in `index.ts` when re-exporting a module. This makes imports greppable and refactoring safe.
- **Async functions:** Always use `async/await`. Never mix `.then()` chains with `await` in the same function.

### PostgreSQL / PostgREST

- **Tables:** `snake_case`, plural. Examples: `bazaar_snapshots`, `auction_sales`, `player_profiles`.
- **Columns:** `snake_case`. Examples: `item_id`, `buy_price`, `created_at`, `player_uuid`.
- **Postgres functions:** `snake_case`. Examples: `calculate_networth`, `aggregate_skills`.
- **PostgREST queries map directly to table/column names** — use the exact Postgres names in URL paths and query params.

### Redis Keys

Hierarchical, colon-separated, with a consistent prefix scheme:

```
cache:hot:profile:{uuid}            # Hot-cached player profile
cache:hot:auctions:{uuid}           # Hot-cached active auctions
cache:warm:bazaar:{item_id}         # Warm-cached bazaar product
cache:warm:skills:{uuid}            # Warm-cached skill data
cache:warm:networth:{uuid}          # Warm-cached computed networth
rate:client:{client_id}             # Client-facing rate limit counter
rate:hypixel:{api_key_hash}         # Hypixel API key usage counter
sub:ws:{connection_id}              # Active WebSocket subscription data
```

- Always use lowercase.
- UUIDs are stored without hyphens (matching Hypixel's format).
- Item IDs use Hypixel's format: `ENCHANTED_DIAMOND`, `ASPECT_OF_THE_END`.

### Commit Messages

Conventional commits: `type(scope): description`. Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. Examples: `feat(bazaar): add price history endpoint`, `fix(cache): correct stale-while-revalidate TTL logic`.

---

## TypeScript Configuration

Use strict mode. The project targets Node.js with ESM modules.

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "paths": {
      "@config/*": ["./src/config/*"],
      "@services/*": ["./src/services/*"],
      "@routes/*": ["./src/routes/*"],
      "@workers/*": ["./src/workers/*"],
      "@processors/*": ["./src/processors/*"],
      "@schemas/*": ["./src/schemas/*"],
      "@types/*": ["./src/types/*"],
      "@utils/*": ["./src/utils/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Rules for Claude Code:**
- Never use `any`. If the type is genuinely unknown, use `unknown` and narrow with type guards.
- Never use `@ts-ignore`. If a type error exists, fix the type.
- Every function that can fail should return a typed result or throw a typed error (see Error Handling).
- Use `satisfies` for constant objects to get both type checking and literal inference.
- Prefer `interface` for object shapes that will be extended. Use `type` for unions, intersections, and computed types.

---

## Environment Variables

All environment variables are parsed and validated at startup in `src/config/env.ts`. If a required variable is missing, the process exits immediately with a clear error message. No environment variable is read anywhere except `env.ts` — all other code imports from `@config/env`.

```typescript
// src/config/env.ts
// Parse, validate, and export all environment configuration.
// The process MUST exit on missing required variables.

export const env = {
  // Server
  PORT:                  parseInt(process.env.PORT ?? '3000'),
  NODE_ENV:              process.env.NODE_ENV ?? 'development',
  LOG_LEVEL:             process.env.LOG_LEVEL ?? 'info',

  // Redis
  REDIS_URL:             requireEnv('REDIS_URL'),

  // PostgREST
  POSTGREST_URL:         requireEnv('POSTGREST_URL'),

  // Hypixel
  HYPIXEL_API_KEYS:      requireEnv('HYPIXEL_API_KEYS').split(','),  // Comma-separated for key rotation

  // Auth
  HMAC_SECRET:           requireEnv('HMAC_SECRET'),                  // Shared secret for mod auth

  // Rate limits (overridable, sensible defaults)
  CLIENT_RATE_LIMIT:     parseInt(process.env.CLIENT_RATE_LIMIT ?? '60'),     // Requests per minute per client
  PUBLIC_RATE_LIMIT:     parseInt(process.env.PUBLIC_RATE_LIMIT ?? '30'),     // Public API tier
  HYPIXEL_RATE_LIMIT:    parseInt(process.env.HYPIXEL_RATE_LIMIT ?? '120'),   // Hypixel key limit/min

  // Cache TTLs (seconds, overridable)
  HOT_CACHE_TTL:         parseInt(process.env.HOT_CACHE_TTL ?? '60'),
  WARM_CACHE_TTL:        parseInt(process.env.WARM_CACHE_TTL ?? '300'),

  // Worker intervals (milliseconds)
  BAZAAR_POLL_INTERVAL:  parseInt(process.env.BAZAAR_POLL_INTERVAL ?? '60000'),
  AUCTION_POLL_INTERVAL: parseInt(process.env.AUCTION_POLL_INTERVAL ?? '45000'),
  PROFILE_POLL_INTERVAL: parseInt(process.env.PROFILE_POLL_INTERVAL ?? '300000'),
} as const;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return value;
}
```

**Corresponding `.env.example`:**

```env
# Server
PORT=3000
NODE_ENV=development
LOG_LEVEL=debug

# Redis
REDIS_URL=redis://localhost:6379

# PostgREST
POSTGREST_URL=http://localhost:3001

# Hypixel (comma-separated for multiple key rotation)
HYPIXEL_API_KEYS=your-api-key-here

# Auth
HMAC_SECRET=generate-a-secure-random-string

# Rate limits (per minute)
CLIENT_RATE_LIMIT=60
PUBLIC_RATE_LIMIT=30
HYPIXEL_RATE_LIMIT=120

# Cache TTLs (seconds)
HOT_CACHE_TTL=60
WARM_CACHE_TTL=300

# Worker intervals (milliseconds)
BAZAAR_POLL_INTERVAL=60000
AUCTION_POLL_INTERVAL=45000
PROFILE_POLL_INTERVAL=300000
```

**Rules for Claude Code:**
- Never use `process.env` outside of `src/config/env.ts`.
- All new environment variables must be added to `env.ts`, `.env.example`, and the Docker Compose file.
- Variables with defaults are optional. Variables using `requireEnv()` are required.

---

## Response Envelope Format

Every API response uses a consistent envelope. All route handlers must return data through this format. Never return raw data outside the envelope.

### Success Response

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

### Error Response

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

### TypeScript Types

```typescript
// src/types/api.ts

interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

interface ApiError {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    status: number;
  };
  meta: {
    timestamp: number;
  };
}

type ApiResponse<T> = ApiSuccess<T> | ApiError;

interface ResponseMeta {
  cached: boolean;
  cache_age_seconds: number | null;
  timestamp: number;
}
```

### Meta Field Details

- `cached`: Whether the response was served from Redis cache.
- `cache_age_seconds`: How old the cached data is, in seconds. `null` if not cached (fresh fetch).
- `timestamp`: Unix timestamp (milliseconds) when the response was generated.

**Rules for Claude Code:**
- Every route handler must return `ApiResponse<T>` where `T` is the endpoint's data type.
- Never return raw arrays — always wrap in `{ items: [...], count: N }` inside the `data` field.
- The `meta.cached` and `meta.cache_age_seconds` fields are populated by the cache manager, not individual routes.

---

## Error Handling

### Error Codes

Use a finite set of typed error codes. Every error returned to clients must use one of these codes. New codes require adding to this list.

```typescript
// src/types/api.ts

type ErrorCode =
  // Client errors
  | 'VALIDATION_ERROR'        // 400 — bad params, missing fields, invalid UUID
  | 'UNAUTHORIZED'            // 401 — missing or invalid auth
  | 'FORBIDDEN'               // 403 — valid auth but insufficient permissions
  | 'PLAYER_NOT_FOUND'        // 404 — no Hypixel player for this UUID
  | 'PROFILE_NOT_FOUND'       // 404 — player exists but no SkyBlock profile
  | 'RESOURCE_NOT_FOUND'      // 404 — generic not found
  | 'RATE_LIMITED'            // 429 — client has exceeded their rate limit
  // Server errors
  | 'HYPIXEL_API_ERROR'       // 502 — Hypixel API returned an error
  | 'HYPIXEL_RATE_LIMITED'    // 503 — our Hypixel API key is rate limited, retry later
  | 'HYPIXEL_UNAVAILABLE'     // 503 — Hypixel API is down
  | 'INTERNAL_ERROR';         // 500 — unexpected failure
```

### Custom Error Class

```typescript
// src/utils/errors.ts

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Factory functions for common errors
export const errors = {
  playerNotFound: (uuid: string) =>
    new AppError('PLAYER_NOT_FOUND', 404, `No SkyBlock profile found for player ${uuid}`),
  rateLimited: () =>
    new AppError('RATE_LIMITED', 429, 'Rate limit exceeded. Try again shortly.'),
  hypixelError: (cause: unknown) =>
    new AppError('HYPIXEL_API_ERROR', 502, 'Hypixel API returned an error.', cause),
  hypixelDown: () =>
    new AppError('HYPIXEL_UNAVAILABLE', 503, 'Hypixel API is currently unavailable. Retry later.'),
  validation: (message: string) =>
    new AppError('VALIDATION_ERROR', 400, message),
} as const;
```

### Global Error Handler

Fastify's `setErrorHandler` catches all thrown errors and formats them into the response envelope.

```typescript
// Registered in index.ts
app.setErrorHandler((error, request, reply) => {
  if (error instanceof AppError) {
    return reply.status(error.status).send({
      success: false,
      error: { code: error.code, message: error.message, status: error.status },
      meta: { timestamp: Date.now() }
    });
  }

  // Fastify validation errors (from JSON Schema)
  if (error.validation) {
    return reply.status(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: error.message, status: 400 },
      meta: { timestamp: Date.now() }
    });
  }

  // Unexpected errors — log full details, return generic message
  logger.error({ err: error, requestId: request.id }, 'Unhandled error');
  return reply.status(500).send({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', status: 500 },
    meta: { timestamp: Date.now() }
  });
});
```

**Rules for Claude Code:**
- Never catch errors silently. Every `catch` block must either re-throw, log, or return a meaningful error.
- Route handlers throw `AppError` — they never call `reply.status().send()` for errors directly. The global handler does that.
- Services (cache manager, Hypixel client) throw `AppError` with appropriate codes. Routes don't need try/catch for expected failures.
- Unexpected errors (network failures, Redis down) are caught at the global level and logged as `INTERNAL_ERROR`.
- Never expose internal details (stack traces, Redis keys, SQL) in error messages returned to clients.

---

## Logging

Use **Pino** as the logger. It's Fastify's native logger (zero-overhead integration), outputs structured JSON, and is the fastest Node.js logging library.

### Setup

```typescript
// src/utils/logger.ts
import pino from 'pino';
import { env } from '@config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,  // JSON output in production
});

// Child loggers for subsystems — adds { service: "..." } to every log line
export const createLogger = (service: string) => logger.child({ service });
```

### Log Levels and When to Use Them

| Level   | When to use                                                                 |
| ------- | --------------------------------------------------------------------------- |
| `fatal` | Process is about to crash. Missing required env var, can't connect to Redis on startup. |
| `error` | Something failed that shouldn't have. Unhandled exceptions, Hypixel returning unexpected status codes, PostgREST write failures. |
| `warn`  | Recoverable issues that need attention. Approaching Hypixel rate limit (>80% consumed), cache miss rate spiking, stale data served beyond expected threshold. |
| `info`  | Normal operational events. Server started, worker completed a poll cycle, new WebSocket subscription registered. |
| `debug` | Detailed flow for debugging. Cache hit/miss per request, Hypixel request/response timing, BullMQ job lifecycle. |
| `trace` | Extremely verbose. Full request/response bodies, Redis command traces. Never in production. |

### What to Log

```typescript
// Service startup
logger.info({ port: env.PORT }, 'Server started');

// Hypixel API calls (always log — critical for debugging rate issues)
hypixelLogger.debug({ endpoint, uuid, duration_ms: 142 }, 'Hypixel API request completed');
hypixelLogger.warn({ key_usage: '102/120', key_index: 0 }, 'Approaching Hypixel rate limit');
hypixelLogger.error({ endpoint, status: 502, body }, 'Hypixel API error');

// Cache operations
cacheLogger.debug({ key, hit: true, age_seconds: 23 }, 'Cache hit');
cacheLogger.debug({ key, hit: false }, 'Cache miss — queuing fetch');

// Worker cycles
workerLogger.info({ products_updated: 847, duration_ms: 312 }, 'Bazaar poll complete');
workerLogger.info({ alerts_published: 3 }, 'Price alerts triggered');

// Errors (always include the error object for stack traces)
logger.error({ err: error, requestId }, 'Unhandled error in route handler');
```

**Rules for Claude Code:**
- Every service file creates its own child logger: `const log = createLogger('cache-manager')`.
- Never use `console.log`, `console.error`, or `console.warn`. Always use Pino.
- Log at `debug` level for anything that helps trace request flow. Log at `info` for operational milestones.
- Always include `duration_ms` when logging operations with measurable latency (Hypixel calls, PostgREST queries, cache operations).
- Never log sensitive data: API keys, HMAC secrets, full player data objects. Log UUIDs and identifiers only.
- Fastify's built-in request logging (via Pino) handles access logs — do not add custom request/response logging in routes.

---

## Testing

Use **Vitest** as the test framework. It has native TypeScript support, fast execution, and compatible with Fastify's injection API for route testing.

### Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@config': path.resolve(__dirname, 'src/config'),
      '@services': path.resolve(__dirname, 'src/services'),
      '@routes': path.resolve(__dirname, 'src/routes'),
      '@workers': path.resolve(__dirname, 'src/workers'),
      '@processors': path.resolve(__dirname, 'src/processors'),
      '@schemas': path.resolve(__dirname, 'src/schemas'),
      '@types': path.resolve(__dirname, 'src/types'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
});
```

### What to Test

| Layer        | What to test                                                  | What to mock                    |
| ------------ | ------------------------------------------------------------- | ------------------------------- |
| Processors   | Pure computation — networth, skills, dungeons. Test with real Hypixel response fixtures. | Nothing — these are pure functions. |
| Services     | Cache manager TTL logic, rate limiter counter behavior, Hypixel client retry/backoff, event bus subscription matching. | Redis (use ioredis-mock or in-memory stub), PostgREST (mock fetch), Hypixel API (mock fetch). |
| Routes       | Full request → response via Fastify's `inject()`. Validates status codes, response envelope shape, error handling. | Services — inject mocked cache manager, Hypixel client, etc. |
| Workers      | Job processing logic — correct data transformation, correct events published. | Hypixel client (mock responses), Redis pub/sub (mock publish), PostgREST (mock fetch). |

### Test File Structure

```typescript
// tests/unit/processors/networth.test.ts
import { describe, it, expect } from 'vitest';
import { calculateNetworth } from '@processors/networth';
import { sampleProfile } from '../../helpers/fixtures';

describe('calculateNetworth', () => {
  it('computes total networth from inventory, bank, and sacks', () => {
    const result = calculateNetworth(sampleProfile);
    expect(result.total).toBeGreaterThan(0);
    expect(result.breakdown).toHaveProperty('inventory');
    expect(result.breakdown).toHaveProperty('bank');
    expect(result.breakdown).toHaveProperty('sacks');
  });

  it('returns zero for empty profile', () => {
    const result = calculateNetworth(emptyProfile);
    expect(result.total).toBe(0);
  });
});
```

```typescript
// tests/integration/routes/profile.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../helpers/app-builder';  // Creates Fastify instance with mocked services

describe('GET /v1/skyblock/profile/:uuid', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();  // Boots Fastify with mocked deps
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns profile data in correct envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skyblock/profile/valid-uuid-here',
      headers: { authorization: 'valid-hmac-signature' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.meta.cached).toBeDefined();
  });

  it('returns 404 envelope for unknown player', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skyblock/profile/nonexistent-uuid',
      headers: { authorization: 'valid-hmac-signature' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PLAYER_NOT_FOUND');
  });
});
```

### Test Fixtures

Store sample Hypixel API responses in `tests/helpers/fixtures.ts`. These are real response shapes from the Hypixel API, trimmed to relevant fields. Use them across all test files for consistency.

```typescript
// tests/helpers/fixtures.ts
export const sampleHypixelProfileResponse = {
  success: true,
  profiles: {
    // ... trimmed real response shape
  },
};

export const sampleBazaarResponse = {
  success: true,
  products: {
    ENCHANTED_DIAMOND: {
      quick_status: { buyPrice: 250.5, sellPrice: 248.1, buyVolume: 1200000 },
    },
    // ...
  },
};
```

**Rules for Claude Code:**
- Every new processor function gets a unit test. No exceptions.
- Every new route gets an integration test covering the success case and at least one error case.
- Tests never hit real external services — Hypixel API, Redis, PostgREST are always mocked.
- Test file names mirror source files: `src/services/cache-manager.ts` → `tests/unit/services/cache-manager.test.ts`.
- Run tests with `npm test` (mapped to `vitest run`). Run in watch mode with `npm run test:watch` (mapped to `vitest`).
- Use `describe` blocks named after the function or route being tested. Use `it` blocks that read as sentences describing the expected behavior.

---

## Reference Resources

- **Hypixel API docs:** `api.hypixel.net` — official endpoint reference
- **`hypixel-api-reborn`:** Node.js wrapper — use as reference for endpoint paths and TypeScript types, not as a runtime dependency
- **SkyCrypt (sky.shiiyu.moe):** Open source SkyBlock profile viewer — reference for networth computation, skill averages, and data transformation from raw API responses
- **NotEnoughUpdates / Skytils source:** Established Fabric/Forge mods — reference for API call patterns and client-side caching approaches
- **Moulberry's Bush Discord / SkyBlock API Discord:** Community knowledge on undocumented endpoints and response structures
- **Fastify docs:** `fastify.dev` — plugins, lifecycle hooks, schema validation
- **BullMQ docs:** `docs.bullmq.io` — queue patterns, priority, scheduled jobs
- **@fastify/swagger docs:** `github.com/fastify/fastify-swagger` — OpenAPI spec generation from route schemas
- **ReDoc docs:** `github.com/Redocly/redoc` — configuration, theming, deployment options
- **OpenAPI 3.1 spec:** `spec.openapis.org/oas/v3.1.0` — full specification reference
- **PostgREST docs:** `postgrest.org` — filtering, RPC, role-based security, configuration
- **node-pg-migrate docs:** `github.com/salsita/node-pg-migrate` — SQL migration runner
- **ioredis docs:** `github.com/redis/ioredis` — connection, pipelining, pub/sub, Lua scripts
- **GitHub Actions docs:** `docs.github.com/en/actions` — workflow syntax, service containers, caching
- **Redocly CLI:** `redocly.com/docs/cli` — OpenAPI spec linting and validation in CI
- **Keep a Changelog:** `keepachangelog.com` — changelog format convention
- **Conventional Commits:** `conventionalcommits.org` — commit message convention
