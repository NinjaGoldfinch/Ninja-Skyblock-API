import { logger } from './utils/logger.js';
import { closeRedis } from './utils/redis.js';
import { closeQueues } from './utils/queue.js';
import { closeEventBus } from './services/event-bus.js';
import { startAuctionScanner } from './workers/auction-scanner.js';

const log = logger.child({ service: 'worker-auctions' });

log.info('Starting auction scanner worker');
startAuctionScanner();

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down auction worker');
  await closeQueues();
  await closeEventBus();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
