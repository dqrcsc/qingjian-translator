// Shared by classic content scripts and ES modules. Resolve BEFORE merging defaults.
(() => {
  if (globalThis.QingJianSettings) return;
  const resolveProtocol = (raw = {}) => {
    if (raw?.apiProtocol === 'gemini' || raw?.apiProtocol === 'openai') return raw.apiProtocol;
    return !raw?.providerId || raw.providerId === 'google' ? 'gemini' : 'openai';
  };
  globalThis.QingJianSettings = { resolveProtocol };
})();
