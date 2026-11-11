import os from 'node:os';
import { Worker } from 'node:worker_threads';
import bcrypt from 'bcryptjs';
import { HttpError } from '../lib/errors.js';

/**
 * Password hashing off the event loop.
 * bcryptjs is pure JavaScript: one cost-12 hash or compare takes 250-600 ms of CPU. On the request thread that delayed
 * every other request on the worker during a shift-start burst of logins. A small pool of worker threads runs the work
 * instead (no new dependency: node:worker_threads), with a bounded queue so a flood of logins cannot grow memory without
 * limit. Threads start on first use and are unref'd while idle, so tests and scripts exit normally.
 *
 * PASSWORD_HASH_THREADS (default 2 on 4+ cores, else 1) and PASSWORD_HASH_QUEUE (default 200) tune it per process.
 * If worker threads cannot start, it falls back to bcryptjs' async API on the main thread.
 */
export const BCRYPT_COST = 12;

// A real cost-12 bcrypt hash of a random value nobody knows. Comparing an unknown email's password against it takes as
// long as comparing against a real account's hash, so response timing does not reveal which emails have accounts.
export const DUMMY_HASH = '$2a$12$0QkA6z0Ieyn0bjj29CSKq.5z.rYupXBmOmaXsVV/wyS8LCkIuP7AC';

const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const THREADS = Math.max(1, Math.min(8, Number(process.env.PASSWORD_HASH_THREADS) || (cores >= 4 ? 2 : 1)));
const MAX_QUEUE = Math.max(1, Number(process.env.PASSWORD_HASH_QUEUE) || 200);
const TASK_TIMEOUT_MS = 30_000;
const WORKER_URL = new URL('./passwordHash.worker.js', import.meta.url);

const workers = new Set(); // live workers
const idle = []; // workers waiting for a task
const queue = []; // tasks waiting for a worker: { op, args, resolve, reject }
let seq = 0;
let threadsUnavailable = false;

function settle(task, err, result) {
  if (task.done) return;
  task.done = true;
  clearTimeout(task.timer);
  if (err) task.reject(err);
  else task.resolve(result);
}

function retire(w, err) {
  if (!workers.has(w)) return;
  workers.delete(w);
  const i = idle.indexOf(w);
  if (i >= 0) idle.splice(i, 1);
  if (w.task) settle(w.task, err || new Error('Password worker stopped'));
  w.task = null;
  pump();
}

function spawn() {
  const w = new Worker(WORKER_URL);
  w.task = null;
  w.unref();
  w.on('message', (msg) => {
    const task = w.task;
    w.task = null;
    if (task && msg?.id === task.id) settle(task, msg.ok ? null : new Error(msg.error), msg.result);
    w.unref();
    idle.push(w);
    pump();
  });
  w.on('error', (err) => retire(w, err));
  w.on('exit', (code) => retire(w, new Error(`Password worker exited with code ${code}`)));
  workers.add(w);
  return w;
}

function pump() {
  while (queue.length) {
    let w = idle.pop();
    if (!w && workers.size < THREADS && !threadsUnavailable) {
      try {
        w = spawn();
      } catch (err) {
        threadsUnavailable = true;
        console.error(`[passwords] worker threads unavailable, hashing on the main thread: ${err.message}`);
      }
    }
    if (!w) {
      if (threadsUnavailable && !workers.size) {
        while (queue.length) runInline(queue.shift());
      }
      return;
    }
    const task = queue.shift();
    task.id = ++seq;
    w.task = task;
    w.ref();
    task.timer = setTimeout(() => {
      settle(task, new HttpError(503, 'Signing in is taking longer than usual. Try again in a moment.'));
      w.task = null;
      w.terminate().catch(() => {});
    }, TASK_TIMEOUT_MS);
    task.timer.unref?.();
    w.postMessage({ id: task.id, op: task.op, args: task.args });
  }
}

function runInline(task) {
  const p = task.op === 'hash' ? bcrypt.hash(String(task.args[0]), task.args[1]) : bcrypt.compare(String(task.args[0]), task.args[1]);
  p.then((r) => settle(task, null, r), (e) => settle(task, e));
}

function run(op, args) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      reject(new HttpError(503, 'Too many sign-ins are being processed right now. Try again in a few seconds.'));
      return;
    }
    queue.push({ op, args, resolve, reject, done: false, timer: null });
    pump();
  });
}

/** bcrypt hash of a new password (cost 12), computed on a worker thread. */
export function hashPassword(plain, cost = BCRYPT_COST) {
  return run('hash', [String(plain), cost]);
}

/** Constant-work check of `plain` against a stored bcrypt hash. A missing hash is compared against DUMMY_HASH and fails. */
export async function verifyPassword(plain, hash) {
  if (typeof hash !== 'string' || hash.length !== 60) {
    await run('compare', [String(plain ?? ''), DUMMY_HASH]);
    return false;
  }
  return run('compare', [String(plain ?? ''), hash]);
}

/** For tests and diagnostics. */
export function passwordPoolStats() {
  return { threads: workers.size, idle: idle.length, queued: queue.length, maxThreads: THREADS, maxQueue: MAX_QUEUE, inline: threadsUnavailable };
}
