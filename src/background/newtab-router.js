export function isNativeNewTab(address) {
  try {
    const url = new URL(address);
    if (url.protocol === 'https:' && ['ntp.msn.com', 'ntp.msn.cn'].includes(url.hostname) && /^\/edge\/ntp\/?$/.test(url.pathname)) return true;
    return ['chrome:', 'edge:'].includes(url.protocol) && url.hostname === 'newtab' && ['/', ''].includes(url.pathname);
  } catch { return false; }
}

export class NewTabRouter {
  constructor(browser, repository) {
    this.browser = browser;
    this.repository = repository;
    this.pending = new Map();
  }
  handle(tab) {
    if (!Number.isInteger(tab.id) || !isNativeNewTab(tab.pendingUrl || tab.url)) return Promise.resolve();
    if (this.pending.has(tab.id)) return this.pending.get(tab.id);
    const task = this.redirect(tab.id).finally(() => this.pending.delete(tab.id));
    this.pending.set(tab.id, task);
    return task;
  }
  async redirect(tabId) {
    if (!(await this.repository.appearance()).newTabEnabled) return;
    // 再次核对，避免覆盖用户已经输入的网址或正在进行的导航。
    const live = await this.browser.tabs.get(tabId);
    if (!isNativeNewTab(live.pendingUrl || live.url)) return;
    if (!(await this.repository.appearance()).newTabEnabled) return;
    await this.browser.tabs.update(tabId, { url: this.browser.runtime.getURL('newtab.html') });
  }
}
