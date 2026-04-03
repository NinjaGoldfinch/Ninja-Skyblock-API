import { logger } from './utils/logger.js';
import { closeRedis } from './utils/redis.js';
import { closeQueues } from './utils/queue.js';
import { startCollectionsTracker } from './workers/resource-collections.js';
import { startSkillsTracker } from './workers/resource-skills.js';
import { startItemsTracker } from './workers/resource-items.js';
import { startElectionTracker } from './workers/resource-election.js';
import { startFireSalesTracker } from './workers/resource-firesales.js';
import { startNewsTracker } from './workers/resource-news.js';

const log = logger.child({ service: 'worker-resources' });

log.info('Starting resource tracker workers (collections, skills, items, election, firesales, news)');
startCollectionsTracker();
startSkillsTracker();
startItemsTracker();
startElectionTracker();
startFireSalesTracker();
startNewsTracker();

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down resource workers');
  await closeQueues();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
