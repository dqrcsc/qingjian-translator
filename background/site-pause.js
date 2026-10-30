// Session storage survives service-worker suspension, but Chrome clears it on
// browser restart and extension reload/update. Never change persistent rules.
export const SITE_PAUSE_KEY = 'qingjian_site_pause_v1';
let writes = Promise.resolve();

export function sitePauseScope(rawUrl, domainRules = '') {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('此页面不支持站点暂停');
  const host = url.hostname.toLowerCase();
  const rules = String(domainRules).split(/\r?\n/).map(s => s.trim().toLowerCase())
    .filter(d => d && (host === d || host.endsWith('.' + d)));
  // The broadest explicitly configured parent owns the site, never a guessed
  // registrable domain (e.g. unrelated projects on a public suffix).
  return rules.sort((a, b) => a.length - b.length)[0] || host;
}

export async function getSitePause(rawUrl, domainRules) {
  await writes.catch(() => {});
  const site = sitePauseScope(rawUrl, domainRules);
  const data = (await chrome.storage.session.get(SITE_PAUSE_KEY))[SITE_PAUSE_KEY] || {};
  return { site, paused: data[site] === true };
}

export function setSitePause(rawUrl, domainRules, paused) {
  if (typeof paused !== 'boolean') return Promise.reject(new Error('站点暂停状态无效'));
  const task = writes.catch(() => {}).then(async () => {
    const site = sitePauseScope(rawUrl, domainRules);
    const data = { ...((await chrome.storage.session.get(SITE_PAUSE_KEY))[SITE_PAUSE_KEY] || {}) };
    if (paused) data[site] = true; else delete data[site];
    await chrome.storage.session.set({ [SITE_PAUSE_KEY]: data });
    return { site, paused };
  });
  writes = task;
  return task;
}

export async function sitePauseRequestUrl(sender, payload, extensionUrl) {
  const base = String(sender?.url || '').split(/[?#]/)[0];
  if (base === `${extensionUrl}popup/popup.html`) {
    if (!Number.isInteger(payload?.tabId)) throw new Error('缺少目标标签页');
    return (await chrome.tabs.get(payload.tabId)).url;
  }
  if (sender?.tab && /^https?:\/\//i.test(sender.url || '')) return sender.url;
  throw new Error('站点暂停仅支持当前网页或扩展弹窗');
}
