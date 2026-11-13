// QingJian local patch (2026-11-13): acknowledge cancellation after sink.close()
// removed the producer. Otherwise PDF.js can leave reader.cancel() pending forever.
export const patchName = 'acknowledge-closed-stream-cancel';
const before = `      case StreamKind.CANCEL:
        if (!streamSink) {
          break;
        }`;
const after = `      case StreamKind.CANCEL:
        if (!streamSink) {
          // QingJian patch: a completed producer still acknowledges a late cancel.
          comObj.postMessage({ sourceName, targetName,
            stream: StreamKind.CANCEL_COMPLETE, streamId, success: true });
          break;
        }`;
export function patchPdfjsStream(source, { reverse = false } = {}) {
  const from = reverse ? after : before, to = reverse ? before : after;
  if (source.split(from).length !== 2) throw new Error('PDF.js cancel patch context changed');
  return source.replace(from, to);
}
