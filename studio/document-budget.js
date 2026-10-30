// A single import deadline and actual-byte accounting, separate from model requests.
const MiB = 1024 * 1024;
export const DOCUMENT_LIMITS = Object.freeze({
  timeoutMs: 90000, maxInputBytes: 100 * MiB, maxEntryBytes: 32 * MiB,
  maxExpandedBytes: 256 * MiB, maxEntries: 10000, maxCompressionRatio: 200,
  compressionRatioGraceBytes: MiB
});

export function createDocumentBudget(options = {}) {
  const limits = { ...DOCUMENT_LIMITS, ...options };
  for (const key of Object.keys(DOCUMENT_LIMITS)) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) limits[key] = DOCUMENT_LIMITS[key];
  }
  const controller = new AbortController();
  const deadline = performance.now() + limits.timeoutMs;
  let expandedBytes = 0, waiters = 0;
  const expire = () => controller.abort(new DOMException(
    `文档导入已超过总时间预算（${limits.timeoutMs / 1000} 秒），下载和解压已停止。`, 'TimeoutError'));
  const timer = setTimeout(expire, limits.timeoutMs);
  // Lazy ZIP readers should not keep a Node process alive after their caller finishes.
  timer.unref?.();
  const onAbort = () => controller.abort(options.signal.reason || new DOMException('文档导入已取消', 'AbortError'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const check = () => {
    if (!controller.signal.aborted && performance.now() >= deadline) expire();
    controller.signal.throwIfAborted();
  };
  const fail = message => {
    const error = new Error(message);
    error.name = 'DocumentLimitError';
    controller.abort(error);
    throw error;
  };
  const checkInputBytes = bytes => {
    check();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxInputBytes) {
      fail(`文档输入大小超过上限（${limits.maxInputBytes} 字节），已停止读取。`);
    }
  };
  const checkEntryBytes = (bytes, compressedBytes) => {
    check();
    if (bytes > limits.maxEntryBytes) fail(`文档单项解压大小超过上限（${limits.maxEntryBytes} 字节）。`);
    if (bytes > Math.max(limits.compressionRatioGraceBytes, compressedBytes * limits.maxCompressionRatio)) {
      fail(`文档解压压缩比超过上限（${limits.maxCompressionRatio} 倍），已停止解压。`);
    }
  };
  const addExpandedBytes = (count, entryBytes, compressedBytes) => {
    checkEntryBytes(entryBytes, compressedBytes);
    if (expandedBytes + count > limits.maxExpandedBytes) fail(`文档累计解压大小超过上限（${limits.maxExpandedBytes} 字节）。`);
    expandedBytes += count;
  };
  const wait = promise => {
    waiters++; timer.ref?.();
    return new Promise((resolve, reject) => {
      const signal = controller.signal;
      const done = (fn, value) => {
        signal.removeEventListener('abort', abort);
        fn(value);
      };
      const abort = () => done(reject, signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(value => {
        try { check(); done(resolve, value); } catch (error) { done(reject, error); }
      }, error => done(reject, signal.aborted ? signal.reason : error));
      try { check(); } catch (error) { done(reject, error); }
    }).finally(() => { if (--waiters === 0) timer.unref?.(); });
  };
  return {
    signal: controller.signal, limits, wait, check, fail, checkInputBytes, checkEntryBytes, addExpandedBytes,
    get expandedBytes() { return expandedBytes; },
    dispose() { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
  };
}

export async function readBoundedStream(stream, budget, acceptChunk) {
  budget.check();
  if (!stream?.getReader) throw new Error('文档读取流不可用，无法安全读取文件');
  const reader = stream.getReader();
  const chunks = [];
  let size = 0, completed = false;
  try {
    while (true) {
      const { done, value } = await budget.wait(reader.read());
      if (done) { completed = true; break; }
      budget.check();
      size += value.byteLength;
      acceptChunk(value.byteLength, size);
      chunks.push(value);
    }
    budget.check();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } finally {
    if (!completed) {
      // Do not wait on a hostile source's cancellation promise after our deadline.
      void reader.cancel(budget.signal.reason).catch(() => {});
    }
    reader.releaseLock();
  }
}

export async function readBoundedResponse(response, budget) {
  try {
    budget.check();
    const declared = response.headers?.get('Content-Length');
    if (declared && /^\d+$/.test(declared)) budget.checkInputBytes(Number(declared));
    return await readBoundedStream(response.body, budget, (_, size) => budget.checkInputBytes(size));
  } catch (error) {
    if (response.body && !response.body.locked) void response.body.cancel(error).catch(() => {});
    throw error;
  }
}

export async function readBoundedFile(file, budget) {
  budget.checkInputBytes(file.size);
  return readBoundedStream(file.stream(), budget, (_, size) => budget.checkInputBytes(size));
}
