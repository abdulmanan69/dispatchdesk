import cluster from 'node:cluster';

/**
 * Cross-process cache invalidation for cluster mode.
 * A worker calls broadcast(topic, data); the primary relays it to every worker (including the sender),
 * and each worker runs the handlers registered with onBroadcast(topic, fn).
 * In a single process (dev, tests) handlers run locally and immediately.
 */
const handlers = new Map(); // topic -> Set<fn>
const MSG = 'dd:broadcast';

export function onBroadcast(topic, fn) {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
}

function runLocal(topic, data) {
  for (const fn of handlers.get(topic) || []) {
    try { fn(data); } catch (err) { console.error(`[broadcast] ${topic} handler failed: ${err.message}`); }
  }
}

export function broadcast(topic, data = null) {
  // Always apply locally first so the calling worker never serves stale data for its own next request.
  runLocal(topic, data);
  if (cluster.isWorker && typeof process.send === 'function') {
    try { process.send({ type: MSG, topic, data, from: cluster.worker.id }); } catch { /* primary gone during shutdown */ }
  }
}

if (cluster.isWorker) {
  process.on('message', (msg) => {
    if (msg && msg.type === MSG && msg.from !== cluster.worker.id) runLocal(msg.topic, msg.data);
  });
}

/** Primary side: relay broadcasts from one worker to all workers. */
export function relayBroadcasts() {
  cluster.on('message', (_worker, msg) => {
    if (!msg || msg.type !== MSG) return;
    for (const w of Object.values(cluster.workers || {})) {
      if (w && w.isConnected()) {
        try { w.send(msg); } catch { /* worker exiting */ }
      }
    }
  });
}
