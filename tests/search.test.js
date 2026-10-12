import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAddress } from '../src/core/search.js';
import { appearance } from '../src/core/validation.js';

test('搜索编码中文和特殊字符，使用选定搜索引擎', () => {
  const result = new URL(searchAddress('标签分组 & AI', 'bing'));
  assert.equal(result.origin, 'https://www.bing.com');
  assert.equal(result.searchParams.get('q'), '标签分组 & AI');
  assert.equal(new URL(searchAddress('test', 'google')).hostname, 'www.google.com');
  assert.equal(new URL(searchAddress('test', 'duckduckgo')).hostname, 'duckduckgo.com');
});
test('完整网址或域名直接导航，拒绝含凭据的网址', () => {
  assert.equal(searchAddress('https://example.org/docs?q=1'), 'https://example.org/docs?q=1');
  assert.equal(searchAddress('example.org/docs'), 'https://example.org/docs');
  assert.throws(() => searchAddress('https://user:password@example.org/'), /用户名或密码/);
});
test('空搜索、无效引擎被拒绝，脚本协议作为普通搜索词', () => {
  assert.throws(() => searchAddress('   '));
  assert.throws(() => searchAddress('query', 'invalid'));
  const result = new URL(searchAddress('javascript:alert(1)'));
  assert.equal(result.protocol, 'https:');
  assert.equal(result.searchParams.get('q'), 'javascript:alert(1)');
});
test('新标签页默认关闭，搜索选项受验证', () => {
  assert.deepEqual(appearance(), { newTabEnabled: false, searchEngine: 'bing' });
  assert.deepEqual(appearance({ newTabEnabled: true, searchEngine: 'google' }), { newTabEnabled: true, searchEngine: 'google' });
  assert.throws(() => appearance({ searchEngine: '__proto__' }));
});
