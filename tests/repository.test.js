import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/background/repository.js';
import { KEYS } from '../src/core/config.js';

export function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return { data, get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])), set: async values => Object.assign(data, structuredClone(values)), remove: async keys => { for (const key of keys) delete data[key]; } };
}
test('一次性迁移之前的配置和固定组，保留原始记录', async () => {
  const local = memoryStorage({ modelSettings: { endpoint: 'http://localhost:8000/v1/chat/completions', model: 'custom', apiKey: 'secret', autoEnabled: true }, savedGroups: [{ title: '开发', color: 'green', tabs: [{ url: 'https://example.org', title: '示例' }] }] });
  const repo = new Repository(local, memoryStorage());
  const settings = await repo.settings();
  assert.equal(settings.secret, 'secret');
  assert.equal(settings.automatic, true);
  assert.equal((await repo.library())[0].name, '开发');
  const id = (await repo.library())[0].id;
  await new Repository(local, memoryStorage()).initialize();
  assert.equal(local.data[KEYS.library][0].id, id);
  assert.ok(local.data.savedGroups);
});
test('串行存储多个页面同时保存的固定组，不覆盖其他修改', async () => {
  const repo = new Repository(memoryStorage(), memoryStorage());
  const record = name => ({ name, color: 'blue', pages: [{ url: 'https://example.org/' + name }] });
  const ids = await Promise.all([repo.putCollection(record('A')), repo.putCollection(record('B')), repo.putCollection(record('C'))]);
  assert.equal((await repo.library()).length, 3);
  await repo.putCollection({ ...record('A2'), id: ids[0] });
  assert.equal((await repo.library()).length, 3);
  assert.equal((await repo.library())[0].name, 'A2');
  await repo.deleteCollection(ids[1]);
  assert.equal((await repo.library()).length, 2);
  await assert.rejects(repo.putCollection({ ...record('B'), id: ids[1] }), /已被删除/);
  await repo.putCollection(record('D'));
  assert.equal((await repo.library()).length, 3);
});
test('新标签页设置独立保存，不要求填写模型配置', async () => {
  const local = memoryStorage();
  const repo = new Repository(local, memoryStorage());
  assert.equal((await repo.appearance()).newTabEnabled, false);
  await repo.saveAppearance({ newTabEnabled: true, searchEngine: 'google' });
  assert.deepEqual(await repo.appearance(), { newTabEnabled: true, searchEngine: 'google' });
  assert.equal(local.data[KEYS.preferences], undefined);
});
