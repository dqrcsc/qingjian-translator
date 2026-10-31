// Also loaded as a classic content script; keep this file free of module syntax.
(() => {
  if (globalThis.QingJianRequests) return;
  const KEEPALIVE_INTERVAL_MS = 15000;
  const createScope = () => {
    const pending = new Map();
    let controller = new AbortController();
    let port = null;
    let keepaliveTimer = null;
    let nextId = 0;
    const stopKeepalive = () => {
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    };
    const startKeepalive = connection => {
      if (keepaliveTimer !== null || pending.size === 0) return;
      keepaliveTimer = setInterval(() => {
        if (port !== connection || pending.size === 0) {
          stopKeepalive();
          return;
        }
        try { connection.postMessage({ type: 'keepalive' }); } catch {}
      }, KEEPALIVE_INTERVAL_MS);
      keepaliveTimer?.unref?.();
    };
    const disconnect = () => {
      stopKeepalive();
      const previous = port;
      port = null;
      previous?.disconnect();
    };
    const finishAll = result => {
      for (const entry of pending.values()) entry.resolve(result);
      pending.clear();
    };
    const connect = () => {
      if (port) return port;
      const connection = chrome.runtime.connect({ name: 'qingjian-request-v1' });
      port = connection;
      connection.onMessage.addListener((packet = {}) => {
        if (port !== connection || packet?.type === 'keepalive') return;
        const { requestId, response } = packet;
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        entry.resolve(response);
        if (pending.size === 0) disconnect();
      });
      connection.onDisconnect.addListener(() => {
        const lastErrorMsg = chrome.runtime.lastError?.message || '';
        const error = lastErrorMsg || '请求连接已关闭';
        if (port !== connection) return;
        stopKeepalive();
        port = null;
        if (!controller.signal.aborted && !/invalidated/i.test(lastErrorMsg)) {
          const retryable = [];
          const exhausted = [];
          for (const entry of pending.values()) {
            if (!entry.retried) {
              entry.retried = true;
              retryable.push(entry);
            } else {
              exhausted.push(entry);
            }
          }
          for (const entry of exhausted) {
            pending.delete(entry.requestId);
            entry.resolve({ ok: false, error });
          }
          if (retryable.length > 0) {
            try {
              const nextConn = connect();
              startKeepalive(nextConn);
              for (const entry of retryable) {
                nextConn.postMessage({ requestId: entry.requestId, message: entry.message });
              }
              return;
            } catch (err) {
              disconnect();
              finishAll({ ok: false, error: err?.message || error });
              return;
            }
          }
        }
        finishAll({ ok: false, error });
      });
      return connection;
    };
    return {
      get signal() { return controller.signal; },
      cancel() {
        controller.abort();
        controller = new AbortController();
        // One disconnect aborts the whole scope atomically in the worker, before
        // releasing queue slots. Separate per-request ports would race admission.
        disconnect();
        finishAll({ ok: false, cancelled: true, error: '请求已取消' });
      },
      request(message) {
        return new Promise(resolve => {
          const requestId = ++nextId;
          pending.set(requestId, { resolve, requestId, message, retried: false });
          try {
            const conn = connect();
            startKeepalive(conn);
            conn.postMessage({ requestId, message });
          } catch (err) {
            disconnect();
            finishAll({ ok: false, error: err?.message || String(err) });
          }
        });
      }
    };
  };
  globalThis.QingJianRequests = { createScope };
})();
