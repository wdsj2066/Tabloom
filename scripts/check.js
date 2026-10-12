import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]);
for (const file of walk(path.join(root, 'src')).filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, 'newtab.html', ...Object.values(manifest.icons)]) assert.ok(fs.existsSync(path.join(root, file)), '缺少资源：' + file);
for (const file of ['app.html', 'popup.html', 'newtab.html']) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), file + ' 引用了不存在的文件：' + match[1]);
  }
}
console.log('模块语法、扩展入口和页面资源检查通过。');
