import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.TABLOOM_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.TABLOOM_PLAYWRIGHT_MODULE).href : 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const context = await chromium.launchPersistentContext(path.join(root, 'artifacts', 'edge-profile-' + Date.now()), {
  executablePath: process.env.TABLOOM_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const app = await context.newPage();
  await app.goto('chrome-extension://' + id + '/app.html#settings');
  await app.locator('#newtab-enabled').waitFor();
  await app.locator('#newtab-enabled').check();
  await app.getByRole('button', { name: '保存新标签页设置' }).click();
  await app.locator('#feedback').filter({ hasText: '新标签页设置已保存' }).waitFor();
  const enabled = await context.newPage();
  await enabled.goto('edge://newtab/', { waitUntil: 'commit' }).catch(error => { if (!error.message.includes('ERR_ABORTED')) throw error; });
  await enabled.locator('#start-content').waitFor({ state: 'visible' });
  assert.equal(new URL(enabled.url()).pathname, '/newtab.html');
  await enabled.screenshot({ path: path.join(root, 'artifacts', 'newtab-edge.png'), fullPage: true });
  await app.bringToFront();
  await app.locator('#newtab-enabled').uncheck();
  await app.getByRole('button', { name: '保存新标签页设置' }).click();
  await app.locator('#feedback').filter({ hasText: '新标签页设置已保存' }).waitFor();
  const disabled = await context.newPage();
  await disabled.goto('edge://newtab/', { waitUntil: 'commit' });
  const nativeUrl = new URL(disabled.url());
  assert.ok(nativeUrl.protocol === 'edge:' || (['ntp.msn.com', 'ntp.msn.cn'].includes(nativeUrl.hostname) && nativeUrl.pathname === '/edge/ntp'));
  assert.equal(await disabled.locator('#start-content').count(), 0);
  console.log('真实 Microsoft Edge 验证通过：开启显示 Tabloom，关闭保留原生新标签页，没有无效内部地址。');
} finally { await context.close(); }
