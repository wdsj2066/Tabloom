import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NewTabRouter, isNativeNewTab } from '../src/background/newtab-router.js';

test('识别 Chrome 和 Edge 原生新标签页，拒绝其他页面和扩展自身', () => {
  for (const address of ['chrome://newtab', 'chrome://newtab/', 'edge://newtab/', 'https://ntp.msn.cn/edge/ntp?locale=zh-CN', 'https://ntp.msn.com/edge/ntp']) assert.ok(isNativeNewTab(address));
  for (const address of ['edge://new-tab-page/', 'chrome://settings/', 'https://newtab/', 'chrome-extension://id/newtab.html', 'about:blank', undefined]) assert.equal(isNativeNewTab(address), false);
});

function setup(initial, enabled = true) {
  let tab = initial;
  const updates = [];
  const router = new NewTabRouter({ tabs: {
    get: async () => tab,
    update: async (id, value) => updates.push({ id, ...value })
  }, runtime: { getURL: path => 'chrome-extension://tabloom/' + path } }, { appearance: async () => ({ newTabEnabled: enabled }) });
  return { router, updates, setTab: value => { tab = value; } };
}
test('开启时 Edge 新标签页路由到本地页面，不访问无效内部地址', async () => {
  const tab = { id: 1, url: 'edge://newtab/' };
  const app = setup(tab);
  await app.router.handle(tab);
  assert.deepEqual(app.updates, [{ id: 1, url: 'chrome-extension://tabloom/newtab.html' }]);
});
test('关闭时不导航，Chrome 和 Edge 均保留原生页', async () => {
  for (const address of ['chrome://newtab/', 'edge://newtab/']) {
    const tab = { id: 1, url: address };
    const app = setup(tab, false);
    await app.router.handle(tab);
    assert.equal(app.updates.length, 0);
  }
});
test('用户已输入网址或正在导航时不覆盖页面', async () => {
  const initial = { id: 1, url: 'edge://newtab/' };
  for (const live of [{ id: 1, url: 'https://example.org/' }, { ...initial, pendingUrl: 'https://example.org/' }]) {
    const app = setup(initial);
    app.setTab(live);
    await app.router.handle(initial);
    assert.equal(app.updates.length, 0);
  }
});
test('创建与更新事件重复到达只跳转一次，不对扩展页重复路由', async () => {
  const tab = { id: 1, url: 'chrome://newtab/' };
  const app = setup(tab);
  await Promise.all([app.router.handle(tab), app.router.handle(tab)]);
  assert.equal(app.updates.length, 1);
  await app.router.handle({ id: 1, url: 'chrome-extension://tabloom/newtab.html' });
  assert.equal(app.updates.length, 1);
});
