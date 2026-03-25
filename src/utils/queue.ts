import { Queue, Worker } from 'bullmq';
import type { Processor } from 'bullmq';
import { env } from '../config/env.js';

const connection = {
  host: new URL(env.REDIS_URL).hostname,
  port: parseInt(new URL(env.REDIS_URL).port || '6379'),
};

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection });
    queues.set(name, queue);
  }
  return queue;
}

export function createWorker<T>(name: string, processor: Processor<T>): Worker<T> {
  return new Worker<T>(name, processor, { connection });
}

export async function closeQueues(): Promise<void> {
  const closing = Array.from(queues.values()).map((q) => q.close());
  await Promise.all(closing);
  queues.clear();
}
