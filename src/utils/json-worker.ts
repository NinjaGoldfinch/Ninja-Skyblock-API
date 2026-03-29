import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// --- Worker thread side ---
if (!isMainThread && parentPort) {
  parentPort.on('message', (msg: { op: 'parse'; text: string } | { op: 'stringify'; data: unknown }) => {
    if (msg.op === 'stringify') {
      parentPort!.postMessage(JSON.stringify(msg.data));
    } else {
      parentPort!.postMessage(JSON.parse(msg.text));
    }
  });
}

// --- Main thread side ---

const POOL_SIZE = 4;
const workerPath = fileURLToPath(import.meta.url);

interface PooledWorker {
  worker: Worker;
  busy: boolean;
}

const pool: PooledWorker[] = [];
const taskQueue: Array<{ message: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
let initialized = false;

function initPool(): void {
  if (initialized) return;
  initialized = true;
  for (let i = 0; i < POOL_SIZE; i++) {
    const worker = new Worker(workerPath);
    const entry: PooledWorker = { worker, busy: false };
    worker.on('message', () => {}); // placeholder, replaced per-task
    pool.push(entry);
  }
}

function dispatch(): void {
  if (taskQueue.length === 0) return;
  const available = pool.find((w) => !w.busy);
  if (!available) return;

  const task = taskQueue.shift()!;
  available.busy = true;

  const onMessage = (result: unknown): void => {
    available.busy = false;
    available.worker.removeListener('message', onMessage);
    available.worker.removeListener('error', onError);
    task.resolve(result);
    dispatch(); // process next queued task
  };

  const onError = (err: Error): void => {
    available.busy = false;
    available.worker.removeListener('message', onMessage);
    available.worker.removeListener('error', onError);
    task.reject(err);
    dispatch();
  };

  available.worker.on('message', onMessage);
  available.worker.on('error', onError);
  available.worker.postMessage(task.message);
}

/**
 * Parse JSON text in a worker thread, freeing the main event loop.
 * Falls back to synchronous JSON.parse for small payloads.
 */
export function parseJsonAsync<T>(text: string): Promise<T> {
  // Small payloads aren't worth the thread overhead
  if (text.length < 50_000) {
    return Promise.resolve(JSON.parse(text) as T);
  }

  initPool();

  return new Promise<T>((resolve, reject) => {
    taskQueue.push({ message: { op: 'parse', text }, resolve: resolve as (v: unknown) => void, reject });
    dispatch();
  });
}

/**
 * Stringify a large object in a worker thread, freeing the main event loop.
 * Falls back to synchronous JSON.stringify for small objects.
 */
export function stringifyAsync(data: unknown, sizeHint?: number): Promise<string> {
  // If caller knows it's small, or we can't estimate, fall back to sync
  if (sizeHint !== undefined && sizeHint < 1000) {
    return Promise.resolve(JSON.stringify(data));
  }

  initPool();

  return new Promise<string>((resolve, reject) => {
    taskQueue.push({ message: { op: 'stringify', data }, resolve: resolve as (v: unknown) => void, reject });
    dispatch();
  });
}

export function shutdownJsonWorkers(): void {
  for (const entry of pool) {
    void entry.worker.terminate();
  }
  pool.length = 0;
  initialized = false;
}
