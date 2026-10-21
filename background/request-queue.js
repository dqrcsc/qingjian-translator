// FIFO admission with explicit slot ownership: aborting a waiter never consumes a slot.
let active = 0;
const queue = [];

export function abortRequestScope(controllers) {
  const targets = [...controllers];
  const signals = new Set(targets.map(controller => controller.signal));
  // Remove ALL waiters before aborting any running fetch. Native abort callbacks
  // can release a slot before the rest of a scope's abort events are delivered.
  for (let i = queue.length - 1; i >= 0; i--) {
    const entry = queue[i];
    if (!signals.has(entry.signal)) continue;
    queue.splice(i, 1);
    entry.signal.removeEventListener('abort', entry.onAbort);
    entry.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  for (const controller of targets) controller.abort();
  drain();
}

function drain() {
  while (queue.length && active < queue[0].limit) {
    const entry = queue.shift();
    entry.signal?.removeEventListener('abort', entry.onAbort);
    active++;
    entry.resolve();
  }
}

export async function withConcurrencyLimit(maxConcurrency, fn, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const entry = { limit: Math.max(1, Math.min(8, Number(maxConcurrency) || 3)), resolve, reject, signal };
    entry.onAbort = () => {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      reject(signal.reason);
      drain();
    };
    queue.push(entry);
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    drain();
  });
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    active--;
    drain();
  }
}
