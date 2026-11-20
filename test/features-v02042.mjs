import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIB = path.join(ROOT, 'lib');
const SRC = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0;
function test(name, fn) {
  fn();
  pass += 1;
  console.log(`OK   ${name}`);
}

function versionAtLeast(a, b) {
  const pa = String(a).split('.').map((x) => Number(x.replace(/[^0-9]/g, '')) || 0);
  const pb = String(b).split('.').map((x) => Number(x.replace(/[^0-9]/g, '')) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

test('A1 采集内容改成「详细配置」弹窗：标题带店铺名', () => {
  assert.ok(SRC.includes("h('h3', { className: 'sa-dialog-title' }, '详细配置 · ' + (a.name || ''))"), '弹窗标题要带店铺名');
  assert.ok(SRC.includes('sa-overlay'), '要有遮罩层');
});

test('A2 弹窗里是勾选清单（不是一排按钮）', () => {
  assert.ok(SRC.includes("type: 'checkbox'"), '要用复选框');
  assert.ok(SRC.includes('collDraft'), '勾选状态存在草稿里，取消不落盘');
  assert.ok(SRC.includes("'全选采集内容'"), '要有全选按钮');
  assert.ok(SRC.includes("'取消'"), '要有取消');
  assert.ok(SRC.includes("'应用配置'"), '要有应用配置');
});

test('A3 说明文案与提示句', () => {
  assert.ok(SRC.includes('建议保持全部 '), '要有「建议保持全部 N 项」的说明');
  assert.ok(SRC.includes('不会删除已有数据'), '要说明关闭不会删数据');
  assert.ok(SRC.includes('点击「应用配置」即保存更改'), '要有保存提示');
});

test('A4 每个采集内容标出可跑份数 / 暂无配方', () => {
  assert.ok(SRC.includes('function domRows()'), '清单数据源');
  assert.ok(SRC.includes("' 可跑 · 共 '"), '可跑份数文案');
  assert.ok(SRC.includes('暂无配方'), '没有配方的要写明');
});

test('B1 不再置灰：所有采集内容都可勾选', () => {
  assert.ok(!SRC.includes('var disabled = runnable === 0;'), 'v0.20.42 去掉了按可跑数置灰');
  assert.ok(!SRC.includes("'（这个域现在没有能跑的配方）'"), '去掉旧的置灰提示');
});

test('B2 应用配置走采集域接口并刷新', () => {
  assert.ok(SRC.includes("function applyColl(list)"), '要有应用函数');
  assert.ok(SRC.includes("'/collection',"), '写回采集域接口');
  assert.ok(SRC.includes('setCollOpen(false);'), '保存后关闭弹窗');
});

test('C1 版本号与文档覆盖 v0.20.42', () => {
  assert.ok(versionAtLeast(PKG.version, '0.20.42'), `版本号要 ≥ 0.20.42，实际 ${PKG.version}`);
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(cl.includes('v0.20.42'), 'CHANGELOG 要有 v0.20.42');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`**${PKG.version}**`) || readme.includes(`当前版本 **${PKG.version}**`), 'README 版本行要跟上');
  assert.ok(readme.includes('node test/features-v02042.mjs'), 'README 自检清单要含本套件');
});

console.log(`\n通过 ${pass} 项`);
