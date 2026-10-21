// Also loaded as a classic content script; keep this file free of module syntax.
(() => {
  if (globalThis.QingJianRequests) return;
  const createScope = () => {
    const pending = new Map();
    let controller = new AbortController();
    let port = null;
    let nextId = 0;
    const disconnect = () => {
      const previous = port;
      port = null;
      previous?.disconnect();
    };
    const finishAll = result => {
      for (const resolve of pending.values()) resolve(result);
      pending.clear();
    };
    const connect = () => {
      if (port) return port;
      const connection = chrome.runtime.connect({ name: 'qingjian-request-v1' });
      port = connection;
      connection.onMessage.addListener(({ requestId, response }) => {
        if (port !== connection) return;
        const resolve = pending.get(requestId);
        if (!resolve) return;
        pending.delete(requestId);
        resolve(response);
        if (pending.size === 0) disconnect();
      });
      connection.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message || '请求连接已关闭';
        if (port !== connection) return;
        port = null;
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
          pending.set(requestId, resolve);
          try { connect().postMessage({ requestId, message }); }
          catch (err) {
            disconnect();
            finishAll({ ok: false, error: err?.message || String(err) });
          }
        });
      }
    };
  };
  globalThis.QingJianRequests = { createScope };
})();
