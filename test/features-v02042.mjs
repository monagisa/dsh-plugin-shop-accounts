import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const R = (rel) => path.join(ROOT, rel);
const client = fs.readFileSync(R('lib/client.js'), 'utf8');
const pkg = J('package.json');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    console.log('  ✗ ' + name);
    console.log('      ' + (e && e.message));
    process.exitCode = 1;
  }
}

console.log('\nfeatures-v02042 采集内容保持简洁样式（内联勾选 + 保存采集域）');

test('A1 采集域直接内联勾选，不再用弹窗', () => {
  assert.ok(!client.includes('collOpen'), '不应再有采集内容弹窗状态');
  assert.ok(!client.includes('应用配置'), '不应再出现「应用配置」按钮');
});

test('A2 每个采集域是一个可勾选项，勾选状态读账号上的 collectionDomains', () => {
  assert.ok(client.includes('collectionDomains'), '没读账号的采集域');
  assert.ok(client.includes("h('input', { type: 'checkbox'"), '没有勾选框');
});

test('A3 保存走 PUT /collection 并刷新状态', () => {
  assert.ok(client.includes("/collection', {"), '保存接口不对');
  assert.ok(client.includes("method: 'PUT'"), '保存方法不对');
  assert.ok(client.includes('props.reload()'), '保存后没刷新');
});

test('A4 有「保存采集域」按钮与「保存中…」状态', () => {
  assert.ok(client.includes('保存采集域'), '缺保存按钮');
  assert.ok(client.includes('保存中'), '缺保存中的状态文案');
});

test('A5 保留「复制采集任务提示词」这个辅助动作', () => {
  assert.ok(client.includes('复制采集任务提示词'), '把复制提示词一起删掉了');
});

test('A6 采集域旁边仍标出有几项指标（保持信息但不弹窗）', () => {
  assert.ok(client.includes('项指标'), '采集域旁边没有指标数');
});

test('B1 版本已到 0.20.49，且 CHANGELOG / README 有记录', () => {
  assert.ok(pkg.version >= '0.20.49');
  assert.ok(fs.readFileSync(R('CHANGELOG.md'), 'utf8').includes('v0.20.49'));
  assert.ok(fs.readFileSync(R('README.md'), 'utf8').includes(pkg.version));
});

if (failed) {
  console.log('\n✗ failed');
} else {
  console.log('\n通过 ' + (7 - failed) + ' 项');
}
