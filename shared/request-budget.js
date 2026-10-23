export const DEFAULT_REQUEST_BUDGET_SECONDS = 90;

export function normalizeRequestBudgetSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.max(30, Math.min(300, seconds)) : DEFAULT_REQUEST_BUDGET_SECONDS;
}

// One controller for the complete request, also registered in the port scope's
// controller map so bulk cancellation can remove all waiters before releasing slots.
export function createRequestBudget(timeoutMs = DEFAULT_REQUEST_BUDGET_SECONDS * 1000) {
  const controller = new AbortController();
  const startedAt = performance.now();
  let timer;
  const configure = durationMs => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    const expire = () => controller.abort(new DOMException(
      `请求已超过总时间预算（${durationMs / 1000} 秒），已停止排队和重试，请重试或在设置中调整预算。`, 'TimeoutError'));
    const remaining = durationMs - (performance.now() - startedAt);
    if (remaining <= 0) expire();
    else timer = setTimeout(expire, remaining);
  };
  configure(timeoutMs);
  const wait = promise => new Promise((resolve, reject) => {
    const signal = controller.signal;
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
    if (signal.aborted) onAbort();
  });
  return { controller, signal: controller.signal, configure, wait, dispose: () => clearTimeout(timer) };
}
