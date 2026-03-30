# Frontend Implementation Prompt: SkyBlock Price Charts

Use this prompt in your Vite + React + TypeScript frontend project to implement bazaar price charting.

---

## Prompt

```
Implement a bazaar price chart page using Lightweight Charts (TradingView) that connects to my SkyBlock API backend.

### Dependencies to install

npm install lightweight-charts

### API Endpoints (backend is already running)

Base URL: configure via VITE_API_URL environment variable (e.g. http://localhost:3000)

1. GET /v2/skyblock/items
   Returns all items with metadata. Use to populate item search/select.
   Response shape:
   {
     success: true,
     data: {
       items: [
         {
           id: "ENCHANTED_DIAMOND",        // SCREAMING_SNAKE_CASE item ID
           name: "Enchanted Diamond",       // Display name (color codes already stripped)
           material: "DIAMOND",
           tier?: "RARE",
           category?: "MISC",
           is_bazaar_sellable?: true,       // true if item is on bazaar
           is_auctionable?: true            // true if item has been seen in auctions
         }
       ],
       count: 1250
     }
   }

   Filter items where is_bazaar_sellable === true for the bazaar chart item picker.

2. GET /v2/skyblock/bazaar/:itemId
   Returns current live prices. Use for the "current price" display above the chart.
   Response shape:
   {
     success: true,
     data: {
       item_id: "ENCHANTED_DIAMOND",
       display_name: "Enchanted Diamond",
       instant_buy_price: 172.5,       // what you pay to buy instantly
       instant_sell_price: 170.2,      // what you get selling instantly
       avg_buy_price: 171.8,
       avg_sell_price: 170.5,
       buy_volume: 50000,
       sell_volume: 48000,
       buy_orders: 150,
       sell_orders: 120,
       buy_moving_week: 350000,
       sell_moving_week: 340000,
       top_buy_orders: [{ amount, price_per_unit, orders }],
       top_sell_orders: [{ amount, price_per_unit, orders }]
     }
   }
   Cache-Control: public, max-age=10

3. GET /v2/skyblock/bazaar/:itemId/history?range=24h
   Returns historical price datapoints for charting.
   Supported ranges: 1h, 6h, 24h, 7d, 30d
   Response shape:
   {
     success: true,
     data: {
       item_id: "ENCHANTED_DIAMOND",
       range: "24h",
       resolution: "5m",              // data granularity
       count: 288,
       summary: {
         avg_instant_buy: 172.50,
         avg_instant_sell: 170.20,
         avg_buy: 171.80,
         avg_sell: 170.50
       },
       datapoints: [
         {
           timestamp: 1774858000000,   // milliseconds
           instant_buy_price: 172.5,
           instant_sell_price: 170.2,
           avg_buy_price: 171.8,
           avg_sell_price: 170.5,
           buy_volume: 50000,
           sell_volume: 48000
         }
       ]
     }
   }
   Supports ETag / If-None-Match (returns 304 when unchanged).
   Cache-Control varies by range: 1h=10s, 6h=30s, 24h=60s, 7d/30d=3600s.

4. WebSocket: WS /v1/events/subscribe
   For live streaming price updates to the chart.
   After connecting, send subscription message:
   { "type": "subscribe", "channels": ["bazaar:alerts"], "filters": { "item_ids": ["ENCHANTED_DIAMOND"] } }

   Incoming messages shape:
   {
     type: "bazaar:price_change",
     item_id: "ENCHANTED_DIAMOND",
     old_instant_buy_price: 172.5,
     new_instant_buy_price: 173.0,
     old_instant_sell_price: 170.2,
     new_instant_sell_price: 170.8,
     change_pct: 0.29,
     timestamp: 1774858060000
   }

### Component Structure

Create these components:

1. **BazaarChart** (main component)
   - Item search/select dropdown (filterable, shows only is_bazaar_sellable items)
   - Range selector buttons: 1H | 6H | 24H | 7D | 30D
   - TradingView Lightweight Chart with two line series:
     - Instant buy price (blue line) — what buyers pay
     - Instant sell price (red/orange line) — what sellers receive
   - Volume histogram below the price chart (use histogram series)
   - Current price display above chart showing live instant_buy and instant_sell
   - Price spread indicator (buy - sell)

2. **useBazaarHistory** (custom hook)
   - Fetches history from API on item/range change
   - Transforms datapoints to Lightweight Charts format:
     { time: timestamp / 1000 (seconds), value: price }
   - Returns { datapoints, summary, loading, error }

3. **useBazaarLive** (custom hook)
   - Connects to WebSocket for the selected item
   - On price_change event, calls chart.update() to append the new tick
   - Also updates the "current price" display
   - Reconnects on disconnect with exponential backoff

### Lightweight Charts Integration Notes

- Import: import { createChart, LineSeries, HistogramSeries } from 'lightweight-charts';
- Chart time format: Lightweight Charts expects time as Unix timestamp in SECONDS (not ms)
  So convert: datapoint.timestamp / 1000
- Use chart.timeScale().fitContent() after setting data to auto-zoom
- For the volume histogram, use a separate pane or overlay
- Set chart options:
  {
    layout: { background: { color: '#1a1a2e' }, textColor: '#e0e0e0' },
    grid: { vertLines: { color: '#2a2a3e' }, horzLines: { color: '#2a2a3e' } },
    timeScale: { timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 }  // Normal crosshair mode
  }

### Data Flow

1. On mount: fetch /v2/skyblock/items, filter to bazaar items, populate dropdown
2. On item select: fetch /v2/skyblock/bazaar/:id (current) + /v2/skyblock/bazaar/:id/history?range=24h
3. Set chart data from history datapoints
4. Connect WebSocket, subscribe to bazaar:alerts with item_id filter
5. On each WS price_change: append new point to chart via series.update(), update current price display
6. On range change: re-fetch history, call series.setData() with new datapoints
7. On item change: disconnect old WS subscription, repeat from step 2

### Styling

Use a dark theme that matches typical trading/financial dashboards.
The chart should be responsive and fill its container width.
Price values should be formatted with appropriate decimal places (coins in SkyBlock).
Use green for price increases, red for decreases in the current price display.
```

---

## Quick Start

1. Copy the prompt above into your Vite + React + TypeScript project
2. Run `npm install lightweight-charts`
3. Set `VITE_API_URL=http://localhost:3000` in your `.env`
4. Have Claude implement the components described in the prompt
