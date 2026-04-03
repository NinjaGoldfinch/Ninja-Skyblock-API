import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventPayload } from '../../../src/services/event-bus.js';

// Track mock instances and the message listener
const mockPublish = vi.fn().mockResolvedValue(1);
const mockSubscribe = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue('OK');
const mockOn = vi.fn();
const mockPipelinePublish = vi.fn().mockReturnThis();
const mockPipelineExec = vi.fn().mockResolvedValue([]);

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    publish: mockPublish,
    subscribe: mockSubscribe,
    quit: mockQuit,
    on: mockOn,
    pipeline: vi.fn(() => ({
      publish: mockPipelinePublish,
      exec: mockPipelineExec,
    })),
  })),
}));

vi.mock('../../../src/config/env.js', () => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
  },
}));

// We need to re-import the module for each test to reset singleton state
async function freshImport() {
  vi.resetModules();
  // Re-apply mocks after resetModules
  vi.doMock('ioredis', () => ({
    Redis: vi.fn().mockImplementation(() => ({
      publish: mockPublish,
      subscribe: mockSubscribe,
      quit: mockQuit,
      on: mockOn,
      pipeline: vi.fn(() => ({
        publish: mockPipelinePublish,
        exec: mockPipelineExec,
      })),
    })),
  }));
  vi.doMock('../../../src/config/env.js', () => ({
    env: {
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    },
  }));

  return await import('../../../src/services/event-bus.js');
}

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleEvent: EventPayload = {
  type: 'bazaar:price_change',
  item_id: 'DIAMOND',
  old_instant_buy_price: 10,
  new_instant_buy_price: 12,
  old_instant_sell_price: 9,
  new_instant_sell_price: 11,
  old_avg_buy_price: 10,
  new_avg_buy_price: 12,
  old_avg_sell_price: 9,
  new_avg_sell_price: 11,
  change_pct: 20,
  timestamp: Date.now(),
};

describe('publish', () => {
  it('publishes JSON-serialized event to correct channel', async () => {
    const { publish } = await freshImport();
    await publish('bazaar:alerts', sampleEvent);

    expect(mockPublish).toHaveBeenCalledWith('bazaar:alerts', JSON.stringify(sampleEvent));
  });

  it('calls Redis publish on the created client', async () => {
    const { publish } = await freshImport();
    await publish('bazaar:alerts', sampleEvent);

    // If publish was called, the lazy client was successfully created
    expect(mockPublish).toHaveBeenCalledOnce();
  });
});

describe('publishBatch', () => {
  it('publishes all events via pipeline', async () => {
    const { publishBatch } = await freshImport();
    const events = [
      { channel: 'bazaar:alerts' as const, event: sampleEvent },
      { channel: 'auction:alerts' as const, event: { ...sampleEvent, type: 'auction:new_lowest_bin' as const, item_name: 'Diamond', price: 100, auction_id: 'abc' } },
    ];

    await publishBatch(events);

    expect(mockPipelinePublish).toHaveBeenCalledTimes(2);
    expect(mockPipelineExec).toHaveBeenCalledOnce();
  });

  it('returns immediately for empty array', async () => {
    const { publishBatch } = await freshImport();
    await publishBatch([]);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockPipelinePublish).not.toHaveBeenCalled();
  });
});

describe('subscribe', () => {
  it('registers handler and subscribes to channel', async () => {
    const { subscribe } = await freshImport();
    const handler = vi.fn();
    await subscribe('bazaar:alerts', handler);

    expect(mockSubscribe).toHaveBeenCalledWith('bazaar:alerts');
  });

  it('attaches message listener on sub client', async () => {
    const { subscribe } = await freshImport();
    await subscribe('bazaar:alerts', vi.fn());

    expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
  });
});

describe('message dispatch', () => {
  it('dispatches to matching channel handler', async () => {
    const { subscribe } = await freshImport();
    const handler = vi.fn();
    await subscribe('bazaar:alerts', handler);

    // Get the message listener that was registered with .on('message', ...)
    const messageListener = mockOn.mock.calls.find(
      (call) => call[0] === 'message',
    )?.[1] as (channel: string, message: string) => void;

    expect(messageListener).toBeDefined();
    messageListener('bazaar:alerts', JSON.stringify(sampleEvent));

    expect(handler).toHaveBeenCalledWith('bazaar:alerts', sampleEvent);
  });

  it('does not dispatch to non-matching channel', async () => {
    const { subscribe } = await freshImport();
    const bazaarHandler = vi.fn();
    const auctionHandler = vi.fn();
    await subscribe('bazaar:alerts', bazaarHandler);
    await subscribe('auction:alerts', auctionHandler);

    const messageListener = mockOn.mock.calls.find(
      (call) => call[0] === 'message',
    )?.[1] as (channel: string, message: string) => void;

    messageListener('bazaar:alerts', JSON.stringify(sampleEvent));

    expect(bazaarHandler).toHaveBeenCalledOnce();
    expect(auctionHandler).not.toHaveBeenCalled();
  });

  it('dispatches to multiple handlers on same channel', async () => {
    const { subscribe } = await freshImport();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    await subscribe('bazaar:alerts', handler1);
    await subscribe('bazaar:alerts', handler2);

    const messageListener = mockOn.mock.calls.find(
      (call) => call[0] === 'message',
    )?.[1] as (channel: string, message: string) => void;

    messageListener('bazaar:alerts', JSON.stringify(sampleEvent));

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });
});

describe('closeEventBus', () => {
  it('quits both pub and sub clients after use', async () => {
    const { publish, subscribe, closeEventBus } = await freshImport();
    await publish('bazaar:alerts', sampleEvent);
    await subscribe('bazaar:alerts', vi.fn());
    await closeEventBus();

    expect(mockQuit).toHaveBeenCalledTimes(2);
  });

  it('handles close when no clients initialized', async () => {
    const { closeEventBus } = await freshImport();
    // Should not throw
    await expect(closeEventBus()).resolves.toBeUndefined();
    expect(mockQuit).not.toHaveBeenCalled();
  });
});
