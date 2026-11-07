// Isolated Studio function harnesses supply model replies directly. Keep their
// page request scope lifecycle explicit; real transport is tested in cancellation.
export function installPdfRequestScopes(context) {
  context.documentPageRequests = new Set();
  context.DOMException ??= DOMException;
  context.QingJianRequests = { createScope() {
    const controller = new AbortController();
    return { signal: controller.signal, cancel: () => controller.abort(),
      request: message => context.sendModelRequest(message) };
  } };
  context.cancelDocumentRequests = () => {
    context.documentRequests?.cancel();
    for (const scope of context.documentPageRequests) scope.cancel();
    context.documentPageRequests.clear();
  };
}
