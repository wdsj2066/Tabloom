import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.TABLOOM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.TABLOOM_PLAYWRIGHT_MODULE).href : 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts');
fs.mkdirSync(output, { recursive: true });
let requests = 0;
const requestedPages = [];
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const user = JSON.parse(body.messages[1].content);
    assert.equal(body.model, 'test-local-model');
    assert.ok(user.pages.every(page => !page.address.includes('?')));
    requests++;
    requestedPages.push(user.pages.map(page => page.address));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ collections: [{ name: '项目研发', ids: user.pages.map(page => page.id) }] }) } }] }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>项目研发 · ' + req.url.replace(/[<>]/g, '') + '</title><h1>本地测试资料</h1>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(output, 'browser-profile-' + Date.now()), {
    headless: true, channel: 'chromium', executablePath: process.env.TABLOOM_CHROMIUM || undefined, viewport: { width: 1440, height: 1100 },
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root]
  });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const first = await context.newPage(); await first.goto(origin + '/docs?private=secret');
  const second = await context.newPage(); await second.goto(origin + '/repository');
  const app = await context.newPage();
  await app.goto('chrome-extension://' + id + '/app.html#settings');
  await app.locator('#endpoint').fill(origin + '/v1');
  await app.locator('#model').fill('test-local-model');
  await app.locator('#guidance').fill('按项目整理');
  await app.locator('#settle-seconds').fill('5');
  await app.getByRole('button', { name: '保存模型设置' }).click();
  await app.locator('#feedback').filter({ hasText: '模型设置已保存' }).waitFor();
  await app.locator('a[data-route="workspace"]').click();
  await app.locator('#workspace-view').waitFor({ state: 'visible' });
  await app.locator('#analyze').click();
  await app.locator('#feedback').filter({ hasText: '已将 2 个页面整理到 1 个主题组' }).waitFor();
  assert.equal(requests, 1);
  await app.getByRole('button', { name: '固定这组' }).click();
  await app.locator('#feedback').filter({ hasText: '已固定' }).waitFor();
  await app.locator('a[data-route="collections"]').click();
  await app.locator('#collections-view').waitFor({ state: 'visible' });
  await app.locator('#collection-list').getByRole('button', { name: '编辑' }).click();
  await app.locator('#collection-name').fill('开发工作台');
  await app.getByRole('button', { name: '保存固定组', exact: true }).click();
  await app.locator('#editor').waitFor({ state: 'hidden' });
  await app.locator('#collection-list').getByRole('heading', { name: '开发工作台' }).waitFor();
  await app.screenshot({ path: path.join(output, 'collections-desktop.png'), fullPage: true });
  await app.getByRole('button', { name: '一键打开' }).click();
  await app.locator('#feedback').filter({ hasText: '已打开“开发工作台”的 2 个页面' }).waitFor();
  const native = await app.evaluate(async () => chrome.tabGroups.query({ windowId: (await chrome.windows.getCurrent()).id }));
  assert.equal(native.length, 2);
  assert.ok(native.some(group => group.title === '开发工作台'));
  await app.bringToFront();
  await app.locator('a[data-route="workspace"]').click();
  await app.locator('#workspace-view').waitFor({ state: 'visible' });
  await app.locator('#library-count').filter({ hasText: '1' }).waitFor();
  await app.screenshot({ path: path.join(output, 'workspace-desktop.png'), fullPage: true });
  await app.locator('a[data-route="settings"]').click();
  await app.locator('#settings-view').waitFor({ state: 'visible' });
  await app.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
  await app.setViewportSize({ width: 390, height: 844 });
  await app.locator('a[data-route="collections"]').click();
  await app.locator('#collections-view').waitFor({ state: 'visible' });
  await app.screenshot({ path: path.join(output, 'collections-mobile.png'), fullPage: true });
  assert.equal(await app.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const popup = await context.newPage();
  await popup.goto('chrome-extension://' + id + '/popup.html');
  await popup.locator('#quick-list').getByText('开发工作台').waitFor();
  await popup.locator('body').screenshot({ path: path.join(output, 'popup.png') });
  await app.bringToFront();
  await app.locator('a[data-route="workspace"]').click();
  await app.locator('#workspace-view').waitFor({ state: 'visible' });
  await app.locator('#automatic').check();
  const third = await context.newPage(); await third.goto(origin + '/automatic');
  const fourth = await context.newPage(); await fourth.goto(origin + '/automatic-second');
  const transient = await context.newPage(); await transient.goto(origin + '/transient');
  await app.evaluate(async () => {
    const tabs = (await chrome.tabs.query({})).filter(tab => ['/automatic', '/automatic-second', '/transient'].some(path => tab.url?.endsWith(path)));
    // Chromium 在当前组旁边创建标签时可能自动继承该组，显式建立未分组的测试前提。
    await chrome.tabs.ungroup(tabs.map(tab => tab.id));
  });
  await transient.close();
  assert.equal(requests, 1, '等待期内不应立即发起模型请求');
  let automaticallyGrouped = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    automaticallyGrouped = await app.evaluate(async () => (await chrome.tabs.query({})).some(tab => tab.url?.endsWith('/automatic') && tab.groupId !== -1));
    if (automaticallyGrouped) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(automaticallyGrouped, '自动整理没有在预期时间内完成');
  assert.equal(requests, 2);
  assert.equal(requestedPages[1].length, 2, '连续打开的页面应合并为一次请求');
  assert.ok(requestedPages[1].every(address => !address.endsWith('/transient')), '短暂打开后关闭的页面不应提交模型');
  await app.bringToFront();
  await app.locator('#automatic').uncheck();
  await app.locator('a[data-route="settings"]').click();
  await app.locator('#settings-view').waitFor({ state: 'visible' });
  await app.locator('#newtab-enabled').check();
  await app.getByRole('button', { name: '保存新标签页设置' }).click();
  await app.locator('#feedback').filter({ hasText: '新标签页设置已保存' }).waitFor();
  const start = await context.newPage();
  await start.goto('chrome://newtab/', { waitUntil: 'commit' }).catch(error => { if (!error.message.includes('ERR_ABORTED')) throw error; });
  await start.locator('#start-content').waitFor({ state: 'visible' });
  await start.getByRole('heading', { name: '开发工作台' }).waitFor();
  await start.screenshot({ path: path.join(output, 'newtab-desktop.png'), fullPage: true });
  const beforeOpen = (await start.evaluate(() => chrome.tabGroups.query({}))).length;
  await start.getByRole('button', { name: '一键打开' }).click();
  await start.locator('#feedback').filter({ hasText: '已打开' }).waitFor();
  assert.equal((await start.evaluate(() => chrome.tabGroups.query({}))).length, beforeOpen + 1);
  await start.bringToFront();
  await start.route('https://www.bing.com/search?**', route => route.fulfill({ contentType: 'text/html', body: '<title>模拟搜索结果</title>' }));
  await start.locator('#web-query').fill('标签分组 & AI');
  await start.getByRole('button', { name: '搜索', exact: false }).click();
  await start.waitForURL('https://www.bing.com/search?**');
  assert.equal(new URL(start.url()).searchParams.get('q'), '标签分组 & AI');
  await app.bringToFront();
  await app.locator('#newtab-enabled').uncheck();
  await app.getByRole('button', { name: '保存新标签页设置' }).click();
  await app.locator('#feedback').filter({ hasText: '新标签页设置已保存' }).waitFor();
  const nativeStart = await context.newPage();
  await nativeStart.goto('chrome://newtab/');
  assert.match(nativeStart.url(), /^chrome:\/\/(newtab|new-tab-page)\//);
  assert.equal(await nativeStart.locator('#start-content').count(), 0);
  const preview = await context.newPage();
  await preview.goto('chrome-extension://' + id + '/newtab.html#preview');
  await preview.locator('#start-content').waitFor({ state: 'visible' });
  await preview.setViewportSize({ width: 390, height: 844 });
  await preview.screenshot({ path: path.join(output, 'newtab-mobile.png'), fullPage: true });
  assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('真实 Chromium 扩展验证通过：模型分组、固定组、自动整理、新标签页开关、搜索、恢复固定组、响应式布局和弹窗。');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
