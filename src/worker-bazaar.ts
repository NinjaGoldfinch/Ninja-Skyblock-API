import { logger } from './utils/logger.js';
import { closeRedis } from './utils/redis.js';
import { closeQueues } from './utils/queue.js';
import { closeEventBus } from './services/event-bus.js';
import { startBazaarTracker } from './workers/bazaar-tracker.js';

const log = logger.child({ service: 'worker-bazaar' });

log.info('Starting bazaar tracker worker');
startBazaarTracker();

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down bazaar worker');
  await closeQueues();
  await closeEventBus();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
