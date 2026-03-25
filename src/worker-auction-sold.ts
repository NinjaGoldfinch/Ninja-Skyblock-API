import { logger } from './utils/logger.js';
import { closeRedis } from './utils/redis.js';
import { closeQueues } from './utils/queue.js';
import { closeEventBus } from './services/event-bus.js';
import { startAuctionSoldTracker } from './workers/auction-sold.js';

const log = logger.child({ service: 'worker-auction-sold' });

log.info('Starting auction sold tracker worker');
startAuctionSoldTracker();

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down auction sold worker');
  await closeQueues();
  await closeEventBus();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
