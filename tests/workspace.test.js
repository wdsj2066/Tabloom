import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workspace } from '../src/background/workspace.js';

const tab = (id, fields = {}) => ({ id, url: 'https://example.org/' + id, title: '页面 ' + id, groupId: -1, pinned: false, index: id, windowId: 1, ...fields });
function fixture(input = {}) {
  let tabs = input.tabs || [tab(1), tab(2)];
  let groups = input.groups || [];
  let managed = input.managed || [];
  let saved = input.saved || [{ id: 'saved', name: '工具', color: 'green', pages: [{ url: 'https://tool.org/' }, { url: 'https://docs.org/' }] }];
  let automatic = input.automatic ?? true;
  let nextId = 100;
  const calls = { grouped: [], removed: [], alarms: [], cleared: [], states: [], saved: [] };
  const browser = {
    alarms: { create: async (...args) => calls.alarms.push(args), clear: async name => calls.cleared.push(name) },
    windows: { getAll: async () => [{ id: 1 }] },
    tabs: {
      query: async () => structuredClone(tabs),
      group: async options => {
        calls.grouped.push(options);
        const groupId = options.groupId ?? ++nextId;
        if (!groups.some(group => group.id === groupId)) groups.push({ id: groupId, title: '' });
        tabs = tabs.map(item => options.tabIds.includes(item.id) ? { ...item, groupId } : item);
        return groupId;
      },
      create: async options => {
        if (input.failCreation && calls.grouped.length) throw new Error('创建失败');
        const created = tab(++nextId, options); tabs.push(created); return created;
      },
      update: async () => {},
      remove: async ids => { const list = Array.isArray(ids) ? ids : [ids]; calls.removed.push(...list); tabs = tabs.filter(item => !list.includes(item.id)); },
      ungroup: async ids => { tabs = tabs.map(item => ids.includes(item.id) ? { ...item, groupId: -1 } : item); }
    },
    tabGroups: {
      query: async () => structuredClone(groups),
      update: async (id, values) => { groups = groups.map(group => group.id === id ? { ...group, ...values } : group); }
    }
  };
  const repository = {
    settings: async () => ({ automatic, settleSeconds: input.settleSeconds ?? 20 }),
    managed: async () => managed,
    setManaged: async (id, ids) => { managed = ids; },
    setState: async (id, state) => calls.states.push(state),
    library: async () => saved,
    putCollection: async record => { calls.saved.push(record); return 'new'; },
    setAutomatic: async value => { automatic = value; }
  };
  const classifier = input.classifier || (async (settings, batch) => [{ name: '研发', ids: batch.map(item => item.id) }]);
  const engine = new Workspace(browser, repository, classifier);
  return { engine, calls, browser, repository, mutateTabs: value => { tabs = value; }, get tabs() { return tabs; }, get managed() { return managed; } };
}
test('超过 60 页统一规划并重排浏览器分组，保留固定标签', async () => {
  const tabs = Array.from({ length: 65 }, (_, index) => tab(index + 1));
  tabs.push(tab(80, { pinned: true }), tab(81, { groupId: 5 }));
  let requests = 0;
  const app = fixture({ tabs, groups: [{ id: 5, title: '手动组' }], classifier: async (settings, pages) => {
    requests += 1;
    assert.equal(pages.length, 66);
    return [{ name: '研发', ids: pages.map(page => page.id) }];
  } });
  const result = await app.engine.analyze(1);
  assert.equal(requests, 1);
  assert.equal(result.pages, 66);
  assert.equal(result.groups, 1);
  assert.equal(app.calls.grouped.length, 1);
  assert.equal(app.tabs.find(item => item.id === 80).groupId, -1);
  assert.equal(app.tabs.find(item => item.id === 81).groupId, app.tabs.find(item => item.id === 1).groupId);
});
test('模型等待期间标签跳转、关闭或被手动分组时重新核对', async () => {
  let release;
  const app = fixture({ classifier: () => new Promise(resolve => { release = resolve; }) });
  const job = app.engine.analyze(1);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  app.mutateTabs([tab(1, { url: 'https://changed.org/' }), tab(2, { groupId: 5 })]);
  release([{ name: '研发', ids: [1, 2] }]);
  assert.equal((await job).pages, 0);
  assert.equal(app.calls.grouped.length, 0);
});

test('自动整理合并同名托管组，保留手动同名组', async () => {
  const app = fixture({
    tabs: [tab(1, { groupId: 8 }), tab(2, { groupId: 9 }), tab(3), tab(4, { groupId: 10 })],
    groups: [{ id: 8, title: '开发' }, { id: 9, title: ' 开发 ' }, { id: 10, title: '开发' }],
    managed: [8, 9],
    classifier: async (settings, batch, context) => {
      assert.equal(context.length, batch.some(item => item.groupId === 9) ? 2 : 1);
      return [{ name: '开发', ids: batch.map(item => item.id) }];
    }
  });
  await app.engine.analyze(1, true);
  assert.equal(app.tabs.find(item => item.id === 3).groupId, 8);
  assert.ok(app.tabs.filter(item => item.id <= 3).every(item => item.groupId === 8));
  await app.engine.analyze(1);
  assert.ok(app.tabs.filter(item => item.id <= 3).every(item => item.groupId === 8));
  assert.equal(app.tabs.find(item => item.id === 4).groupId, 10);
});

test('模型等待期间目标组被删除时复用其他同名托管组', async () => {
  const app = fixture({
    tabs: [tab(1, { groupId: 8 }), tab(2, { groupId: 9 }), tab(3)],
    groups: [{ id: 8, title: 'Chat' }, { id: 9, title: 'chat' }], managed: [8, 9],
    classifier: async () => {
      app.browser.tabGroups.query = async () => [{ id: 9, title: 'chat' }];
      return [{ name: ' CHAT ', ids: [1, 2, 3] }];
    }
  });
  await app.engine.analyze(1, true);
  assert.equal(app.calls.grouped[0].groupId, 9);
});
test('固定浏览器组会解除 AI 托管资格', async () => {
  const app = fixture({ tabs: [tab(1, { groupId: 8 })], groups: [{ id: 8, title: '研发', color: 'blue' }], managed: [8] });
  await app.engine.saveNative(1, 8);
  assert.deepEqual(app.managed, []);
  assert.equal(app.calls.saved[0].pages.length, 1);
});
test('固定组一键打开并恢复名称颜色，不成为 AI 托管组', async () => {
  const app = fixture();
  await app.engine.openSaved(1, 'saved');
  assert.equal(app.calls.grouped.length, 2);
  assert.equal(app.calls.grouped[1].groupId, app.tabs.find(item => item.url === 'https://tool.org/').groupId);
  assert.deepEqual(app.managed, []);
});
test('固定组恢复失败只回滚本次新建标签', async () => {
  const app = fixture({ failCreation: true });
  await assert.rejects(app.engine.openSaved(1, 'saved'), /创建失败/);
  assert.equal(app.calls.removed.length, 1);
  assert.deepEqual(app.tabs.map(item => item.id), [1, 2]);
});
test('解散操作取消在途分析，避免解散后被重新分组', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const app = fixture({ classifier: (settings, pages, names, signal) => new Promise((resolve, reject) => {
    entered();
    signal.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true });
  }) });
  const analysis = app.engine.analyze(1);
  const rejected = assert.rejects(analysis, /停止/);
  await ready;
  await app.engine.dissolve(1);
  await rejected;
  assert.equal(app.calls.grouped.length, 0);
  assert.equal((await app.repository.settings()).automatic, false);
});
test('用户关闭自动整理后，在途模型回复不会应用', async () => {
  let release;
  const app = fixture({ classifier: () => new Promise(resolve => { release = resolve; }) });
  const task = app.engine.analyze(1, true);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await app.repository.setAutomatic(false);
  release([{ name: '研发', ids: [1, 2] }]);
  await task;
  assert.equal(app.calls.grouped.length, 0);
});
test('连续标签事件使用同名任务重新计时，按配置延迟合并请求', async () => {
  const app = fixture({ settleSeconds: 35 });
  const originalNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    await app.engine.schedule(1);
    now += 8000;
    await app.engine.schedule(1);
    assert.equal(app.calls.alarms[0][0], app.calls.alarms[1][0]);
    assert.equal(app.calls.alarms[0][1].when, 135000);
    assert.equal(app.calls.alarms[1][1].when, 143000);
  } finally { Date.now = originalNow; }
});
test('关闭自动整理时清除待处理任务，不创建新任务', async () => {
  const app = fixture({ automatic: false });
  await app.engine.schedule(1);
  assert.equal(app.calls.alarms.length, 0);
  assert.deepEqual(app.calls.cleared, ['tabloom.window.1']);
});
test('等待期间全部标签关闭时不向模型发送请求', async () => {
  let requests = 0;
  const app = fixture({ classifier: async () => { requests++; return []; } });
  await app.engine.schedule(1);
  app.mutateTabs([]);
  await app.engine.analyze(1, true);
  assert.equal(requests, 0);
});
test('全局规划期间关闭的标签不会被移动', async () => {
  const batches = [];
  const app = fixture({ tabs: Array.from({ length: 65 }, (_, index) => tab(index + 1)), classifier: async (settings, batch) => {
    batches.push(batch.map(item => item.id));
    app.mutateTabs(app.tabs.filter(item => item.id <= 60));
    return [{ name: '研发', ids: batch.map(item => item.id) }];
  } });
  const result = await app.engine.analyze(1, true);
  assert.equal(batches.length, 1);
  assert.equal(result.pages, 60);
});
test('手动整理重新分析 AI 品牌组，按 Chat 合并并保留手动和固定组', async () => {
  const app = fixture({
    tabs: [tab(1, { title: 'Xiaomi MiMo Studio', groupId: 8 }), tab(2, { title: 'ChatGPT', groupId: 9 }), tab(3, { groupId: 10 }), tab(4, { pinned: true })],
    groups: [{ id: 8, title: '小米AI平台' }, { id: 9, title: 'AI 对话助手' }, { id: 10, title: '用户固定的组' }],
    managed: [8, 9],
    classifier: async (settings, batch, context) => {
      assert.deepEqual(batch.map(item => item.id), [1, 2]);
      assert.equal(context[0].pages[0].title, 'Xiaomi MiMo Studio');
      assert.equal(context[1].pages[0].title, 'ChatGPT');
      return [{ name: 'Chat', ids: [1, 2] }];
    }
  });
  assert.equal((await app.engine.analyze(1)).groups, 1);
  assert.equal(app.tabs.find(item => item.id === 1).groupId, app.tabs.find(item => item.id === 2).groupId);
  assert.equal(app.tabs.find(item => item.id === 3).groupId, 10);
  assert.equal(app.tabs.find(item => item.id === 4).groupId, -1);
});
test('自动整理将旧品牌组与新增标签一起重构', async () => {
  const app = fixture({
    tabs: [tab(1, { title: 'ChatGPT', groupId: 8 }), tab(2, { title: 'Xiaomi MiMo Studio' })],
    groups: [{ id: 8, title: 'ChatGPT' }], managed: [8],
    classifier: async (settings, batch, context) => {
      assert.deepEqual(batch.map(item => item.id), [1, 2]);
      assert.equal(context[0].name, 'ChatGPT');
      assert.equal(context[0].pages[0].title, 'ChatGPT');
      return [{ name: 'Chat', ids: [1, 2] }];
    }
  });
  await app.engine.analyze(1, true);
  assert.equal(app.tabs[0].groupId, app.tabs[1].groupId);
  assert.equal((await app.browser.tabGroups.query())[1].title, 'Chat');
});
test('重新整理时 AI 组中的标签若已被用户移动，不再移动该标签', async () => {
  let release;
  const app = fixture({ tabs: [tab(1, { groupId: 8 })], groups: [{ id: 8, title: '品牌组' }], managed: [8], classifier: () => new Promise(resolve => { release = resolve; }) });
  const job = app.engine.analyze(1);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  app.mutateTabs([tab(1, { groupId: 99 })]);
  release([{ name: 'Chat', ids: [1] }]);
  assert.equal((await job).pages, 0);
  assert.equal(app.calls.grouped.length, 0);
});
