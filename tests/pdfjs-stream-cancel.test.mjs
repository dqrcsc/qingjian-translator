import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { patchName, patchPdfjsStream } from '../scripts/pdfjs-stream-patch.mjs';

// Exercise the bundled message handlers, with CLOSE held in transit while the
// consumer cancels. The producer has already removed its stream sink.
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
  test(`${file}: cancelling an already closed worker stream acknowledges and settles`, async () => {
    const source = fs.readFileSync(new URL(`../studio/vendor/pdfjs/${file}`, import.meta.url), 'utf8');
    const inventory = JSON.parse(fs.readFileSync(new URL('../studio/vendor/pdfjs/provenance.json', import.meta.url)));
    assert.equal(inventory.files[file].patch, patchName);
    assert.equal(createHash('sha256').update(patchPdfjsStream(source, { reverse: true })).digest('hex'), inventory.files[file].upstreamSha256);
    const section = source.slice(source.indexOf('const CallbackKind ='), source.indexOf('\n;//', source.indexOf('class MessageHandler {')));
    const exception = class extends Error {};
    const ctx = vm.createContext({ AbortController, ReadableStream, Error, Promise,
      AbortException: exception, InvalidPDFException: exception, PasswordException: exception,
      ResponseException: exception, UnknownErrorException: exception,
      assert, util_assert: assert, unreachable: message => { throw new Error(message); } });
    const Handler = vm.runInContext(`${section}\nMessageHandler`, ctx);
    let receiveConsumer, receiveWorker, closeMessage, sink, acknowledgements = 0;
    const worker = new Handler('worker', 'main', {
      addEventListener(_, fn) { receiveWorker = fn; },
      postMessage(data) {
        if (data.stream === 3) { closeMessage = data; return; }
        if (data.stream === 2) acknowledgements++;
        queueMicrotask(() => receiveConsumer({ data }));
      }
    });
    const consumer = new Handler('main', 'worker', {
      addEventListener(_, fn) { receiveConsumer = fn; },
      postMessage(data) { queueMicrotask(() => receiveWorker({ data })); }
    });
    worker.on('text', (_, stream) => { sink = stream; });
    const reader = consumer.sendWithStream('text', {}).getReader();
    await new Promise(resolve => setImmediate(resolve));
    sink.close();
    assert.ok(closeMessage);
    const cancellation = reader.cancel(new Error('navigation'));
    receiveConsumer({ data: closeMessage });
    // Flush the message/microtask chain; no wall-clock sleep or library mock.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acknowledgements, 1, 'closed producer must acknowledge late cancel');
    await cancellation;
    worker.destroy(); consumer.destroy();
  });
}
