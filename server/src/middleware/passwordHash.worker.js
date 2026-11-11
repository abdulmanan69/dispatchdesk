// Worker thread for password hashing (see passwordHash.js). bcryptjs is pure JavaScript, so running it here keeps the
// HTTP event loop free. Synchronous calls are fine inside the worker: it does nothing else.
import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

parentPort.on('message', ({ id, op, args }) => {
  try {
    let result;
    if (op === 'hash') result = bcrypt.hashSync(String(args[0]), Number(args[1]));
    else if (op === 'compare') result = typeof args[1] === 'string' && args[1].length === 60 ? bcrypt.compareSync(String(args[0]), args[1]) : false;
    else throw new Error(`Unknown operation ${op}`);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
