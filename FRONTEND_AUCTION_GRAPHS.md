# Frontend Changes: Auction Price History

Changes needed to support auction price history charts on the frontend.

---

## API Changes

### New response field: `sparse`

The `GET /v2/skyblock/auctions/price-history/:item?range=` response now includes a `sparse` boolean:

```json
{
  "data": {
    "item": "Hyperion",
    "skyblock_id": "HYPERION",
    "range": "24h",
    "resolution": "~60s",
    "sparse": true,
    "count": 142,
    "summary": { ... },
    "datapoints": [ ... ]
  }
}
```

- `sparse: true` — 1h, 6h, 24h ranges. Datapoints only exist when values changed.
- `sparse: false` — 7d (1-minute buckets), 30d (1-hour buckets). Regular intervals.

### Updated resolution and caching

| Range | Resolution | Cache max-age |
|-------|-----------|---------------|
| 1h    | ~60s (sparse) | 10s |
| 6h    | ~60s (sparse) | 30s |
| 24h   | ~60s (sparse) | 60s |
| 7d    | 1 minute      | 120s |
| 30d   | 1 hour        | 3600s |

---

## 1. Step Interpolation for Sparse Data

When `data.sparse === true`, gaps between datapoints mean "no change." Use step interpolation:

```typescript
const lineType = data.sparse ? 'stepAfter' : 'monotone';
```

**Recharts:** `<Line type="stepAfter" />`
**Chart.js:** `{ stepped: 'before' }`
**TradingView:** `{ lineType: LineType.WithSteps }`

When `sparse === false` (7d/30d), use normal smooth lines.

---

## 2. Real-Time Updates via WebSocket

New channel `auction:price-updates` publishes full datapoints when items change (~60s per changed item).

**Event payload:**
```json
{
  "type": "auction:price-snapshot",
  "base_item": "Hyperion",
  "skyblock_id": "HYPERION",
  "lowest_bin": 920000000,
  "median_bin": 935000000,
  "listing_count": 142,
  "sale_count": 0,
  "avg_sale_price": null,
  "timestamp": 1711929600000
}
```

**WebSocket (preferred — server-side filtered):**
```typescript
const ws = new WebSocket(`${WS_URL}/v1/events/subscribe`);
ws.onopen = () => {
  ws.send(JSON.stringify({
    action: 'subscribe',
    channel: 'auction:price-updates',
    filters: { item_ids: ['HYPERION'] }
  }));
};
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'auction:price-snapshot') appendDatapoint(data);
};
```

**SSE (simpler, all items, client-side filter):**
```typescript
const es = new EventSource(`${API_URL}/v1/events/auctions/prices`);
es.onmessage = (event) => {
  const snapshot = JSON.parse(event.data);
  if (snapshot.skyblock_id === currentItem) appendDatapoint(snapshot);
};
```

---

## 3. Append + Prune for Live Updates

```typescript
function appendDatapoint(snapshot: PriceSnapshot) {
  setDatapoints(prev => {
    const cutoff = Date.now() - rangeDurationMs;
    return [...prev.filter(p => p.timestamp > cutoff), {
      timestamp: snapshot.timestamp,
      lowest_bin: snapshot.lowest_bin,
      median_bin: snapshot.median_bin,
      listing_count: snapshot.listing_count,
      sale_count: snapshot.sale_count,
      avg_sale_price: snapshot.avg_sale_price,
    }];
  });
}
```

**Flow:**
1. Fetch history: `GET /v2/skyblock/auctions/price-history/:item?range=1h`
2. Connect WebSocket, subscribe to `auction:price-updates` with `item_ids` filter
3. Append incoming events, prune old points
4. On range change: re-fetch history, keep WS open

---

## 4. Backfilled Data

Rows with `listing_count === 0` are backfilled from historical sales (no live snapshot existed). Hide the listing count line for those points or show "Historical data from sales records."
