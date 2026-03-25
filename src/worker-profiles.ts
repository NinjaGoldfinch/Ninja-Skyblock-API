import { logger } from './utils/logger.js';
import { closeRedis } from './utils/redis.js';
import { closeQueues } from './utils/queue.js';
import { closeEventBus } from './services/event-bus.js';
import { startProfileTracker } from './workers/profile-tracker.js';

const log = logger.child({ service: 'worker-profiles' });

log.info('Starting profile tracker worker');
startProfileTracker();

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down profile worker');
  await closeQueues();
  await closeEventBus();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
