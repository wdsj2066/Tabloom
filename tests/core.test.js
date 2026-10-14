import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collection, disclosureUrl, modelAddress, preferences, colorFor } from '../src/core/validation.js';
import { eligibleTabs, readPlan, survivingIds } from '../src/core/plan.js';
import { requestPlan } from '../src/core/model.js';

const page = (id, fields = {}) => ({ id, title: '资料 ' + id, url: 'https://example.org/path/' + id + '?token=private#fragment', pinned: false, groupId: -1, ...fields });
test('接口规范化支持完整地址和基础地址，拒绝危险协议和凭据', () => {
  assert.equal(modelAddress('https://service.test/v1/'), 'https://service.test/v1/chat/completions');
  assert.equal(modelAddress('http://localhost:8000'), 'http://localhost:8000/v1/chat/completions');
  assert.equal(modelAddress('https://service.test/api/chat/completions'), 'https://service.test/api/chat/completions');
  for (const address of ['file:///secret', 'https://user:pass@example.org', 'https://example.org/?secret=1']) assert.throws(() => modelAddress(address));
  assert.throws(() => preferences({ endpoint: 'http://localhost:8000', model: ' ' }), /模型名称/);
});
test('自动等待时间默认 20 秒，可配置 5–300 秒，拒绝非法值', () => {
  const base = { endpoint: 'https://service.test/v1', model: 'custom' };
  assert.equal(preferences(base).settleSeconds, 20);
  assert.equal(preferences({ ...base, settleSeconds: '45' }).settleSeconds, 45);
  for (const value of [0, 4, 301, 5.5, '', 'invalid']) assert.throws(() => preferences({ ...base, settleSeconds: value }), /等待时间/);
});
test('固定组验证网址、名称、颜色与数量', () => {
  const result = collection({ name: ' 工作 ', color: 'invalid', pages: [{ url: 'https://example.org' }] });
  assert.equal(result.name, '工作');
  assert.equal(result.color, 'blue');
  assert.equal(result.pages[0].url, 'https://example.org/');
  assert.throws(() => collection({ name: '', pages: [] }));
  assert.throws(() => collection({ name: '组', pages: [{ url: 'javascript:alert(1)' }] }));
  assert.throws(() => collection({ name: '组', pages: Array(301).fill({ url: 'https://example.org' }) }));
});
test('默认清除网址查询参数和片段，参数可显式开启', () => {
  assert.equal(disclosureUrl(page(1).url, false), 'https://example.org/path/1');
  assert.equal(disclosureUrl(page(1).url, true), 'https://example.org/path/1?token=private');
  assert.equal(colorFor('研发'), colorFor('研发'));
});
test('解析代码围栏 JSON，合并同名主题，完整分配每个标签', () => {
  const plan = readPlan('```json\n{"collections":[{"name":"工作","ids":[1]},{"name":"工作","ids":[2]}]}\n```', [page(1), page(2)]);
  assert.deepEqual(plan, [{ name: '工作', ids: [1, 2] }]);
});
test('模型结果遗漏、重复、越界和错误结构均不能通过校验', () => {
  for (const result of [null, {}, { collections: [] }, { collections: [{ name: '工作', ids: [1, 1] }] }, { collections: [{ name: '工作', ids: [999] }] }, { collections: [{ name: '', ids: [1] }] }, { collections: [{ name: '工作', ids: ['1'] }] }]) {
    assert.throws(() => readPlan(JSON.stringify(result), [page(1)]));
  }
  assert.throws(() => readPlan('not json', [page(1)]));
});

test('同名组忽略首尾空白、全角字符与大小写差异', () => {
  assert.deepEqual(readPlan(JSON.stringify({ collections: [
    { name: 'Chat', ids: [1] }, { name: ' ＣＨＡＴ ', ids: [2] }
  ] }), [page(1), page(2)]), [{ name: 'Chat', ids: [1, 2] }]);
});
test('保留手动分组、固定标签和分析期间发生变化的页面', () => {
  assert.deepEqual(eligibleTabs([page(1), page(2, { groupId: 8 }), page(3, { pinned: true }), page(4, { url: 'chrome://settings' })]).map(tab => tab.id), [1]);
  const snapshot = new Map([1, 2, 3, 4].map(id => [id, page(id).url]));
  assert.deepEqual(survivingIds([1, 2, 3, 4], snapshot, [page(1), page(2, { url: 'https://other.org/' }), page(3, { groupId: 8 })]), [1]);
});
test('模型请求使用用户配置，发送清理后的网址并解析结果', async () => {
  let request;
  const result = await requestPlan({ endpoint: 'http://localhost:8000/v1', model: 'local-custom', secret: 'key', guidance: '按项目分类' }, [page(1)], ['工作'], new AbortController().signal, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"collections":[{"name":"工作","ids":[1]}]}' } }] }) };
  });
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'local-custom');
  assert.equal(request.options.headers.Authorization, 'Bearer key');
  const user = JSON.parse(body.messages[1].content);
  assert.equal(user.pages[0].address, 'https://example.org/path/1');
  assert.deepEqual(user.existingNames, ['工作']);
  assert.equal(result[0].name, '工作');
});
test('服务错误和网络错误不会暴露响应正文或密钥', async () => {
  const settings = { endpoint: 'https://service.org/v1', model: 'model' };
  await assert.rejects(requestPlan(settings, [page(1)], [], new AbortController().signal, async () => ({ ok: false, status: 401 })), /HTTP 401/);
  await assert.rejects(requestPlan(settings, [page(1)], [], new AbortController().signal, async () => { throw new Error('private secret'); }), /无法连接/);
});
test('已有组提供少量用途样本，清理网址参数并限制上下文数量', async () => {
  let submitted;
  await requestPlan({ endpoint: 'https://service.test/v1', model: 'custom' }, [page(3)], [{ name: 'AI 对话助手', pages: [
    { title: 'ChatGPT', url: 'https://chatgpt.com/c/private?token=secret#part' },
    { title: 'Xiaomi MiMo Studio', url: 'https://mimo.example/chat?session=secret' },
    { title: '第三个页面不发送', url: 'https://example.org/' }
  ] }], new AbortController().signal, async (url, options) => {
    submitted = JSON.parse(JSON.parse(options.body).messages[1].content);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"collections":[{"name":"Chat","ids":[3]}]}' } }] }) };
  });
  assert.equal(submitted.existingGroups[0].pages.length, 2);
  assert.equal(submitted.existingGroups[0].pages[0].address, 'https://chatgpt.com/c/private');
  assert.equal(submitted.existingGroups[0].pages[1].title, 'Xiaomi MiMo Studio');
});
