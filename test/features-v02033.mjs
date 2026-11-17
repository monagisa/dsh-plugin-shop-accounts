import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { compileExecution } from '../lib/rpa.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const passed = [];
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u2717 ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const RECIPES = [
  ['淘宝', 'lib/rpa/dsls/taobao/tb_shop_overview.json'],
  ['天猫', 'lib/rpa/dsls/tmall/tmall_shop_overview.json'],
];

await test('A1 淘宝配方不再跳转到接口 JSON 页面', () => {
  const steps = readJson(RECIPES[0][1]).template.steps;
  assert.equal(
    steps.filter((s) => s.action === 'goto' && String(s.url).includes('trend/v3.json')).length,
    0,
    '不应该再有 goto 接口 JSON 页的步骤',
  );
  const read = steps.filter((s) => s.action === 'evaluate' && String(s.expression || '').includes('XMLHttpRequest'));
  assert.equal(read.length, 1, '应当有一步 evalScript 读接口');
  assert.equal(read[0].outputKey, 'overviewResponse');
  assert.ok(String(read[0].expression).includes('return x.responseText'), '表达式要返回接口文本');
  assert.ok(String(read[0].expression).includes('trend/v3.json'), '表达式里要请求趋势接口');
});

await test('A2 天猫配方同样在页内请求接口，不跳转页面', () => {
  const steps = readJson(RECIPES[1][1]).template.steps;
  assert.equal(steps.filter((s) => s.action === 'goto' && String(s.url).includes('trend/v3.json')).length, 0);
  const read = steps.filter((s) => s.action === 'evaluate' && String(s.expression || '').includes('XMLHttpRequest'));
  assert.equal(read.length, 1);
  assert.ok(String(read[0].expression).includes('trend/v3.json'));
});

await test('A3 页内请求是同步 XHR、带 cookie、并检查 HTTP 状态', () => {
  for (const [name, rel] of RECIPES) {
    const step = readJson(rel).template.steps.find((s) => s.action === 'evaluate' && String(s.expression || '').includes('XMLHttpRequest'));
    const expr = String(step.expression);
    assert.ok(/new XMLHttpRequest\(\)/.test(expr), name + ' 应当用 XMLHttpRequest');
    assert.ok(/x\.open\('GET', url, false\)/.test(expr), name + ' 应当是同步请求（第三个参数 false）');
    assert.ok(/x\.withCredentials = true/.test(expr), name + ' 要带上登录 cookie');
    assert.ok(/x\.status !== 200/.test(expr), name + ' 要检查 HTTP 状态');
  }
});

await test('B1 编译后没有跳转接口页的 goto，读接口是 eval op', () => {
  const compiled = compileExecution(readJson(RECIPES[0][1]), { start: '2026-11-13', end: '2026-11-13' });
  const ops = compiled.ops || compiled;
  assert.equal(
    ops.filter((o) => o.op === 'goto' && String(o.url).includes('trend/v3.json')).length,
    0,
    '编译结果里不应再有跳转接口页的 goto',
  );
  const evalIdx = ops.findIndex((o) => o.op === 'eval' && String(o.expr).includes('XMLHttpRequest'));
  assert.ok(evalIdx >= 0, '应当有读接口的 eval op');
  const urlIdx = ops.findIndex((o) => o.op === 'url' && String(o.stepId).includes('read-url'));
  assert.ok(urlIdx > evalIdx, '记录 finalUrl 在读取接口之后');
});

await test('C1 版本号已到 0.20.33', () => {
  const parts = String(pkg.version).split('.').map(Number);
  const atLeast = (v) => {
    const p = v.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((parts[i] || 0) > (p[i] || 0)) return true;
      if ((parts[i] || 0) < (p[i] || 0)) return false;
    }
    return true;
  };
  assert.ok(atLeast('0.20.33'), '当前版本 ' + pkg.version);
});

await test('C2 CHANGELOG 与 README 记录了「读接口不再留在窗口里」', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.20.34'), 'CHANGELOG 缺少 v0.20.34');
  assert.ok(
    changelog.includes('不再跳转') || changelog.includes('页内') || changelog.includes('不离开'),
    'CHANGELOG 缺少说明',
  );
  const readme = read('README.md');
  assert.ok(
    readme.includes('不再跳转到接口页面') || readme.includes('页内请求') || readme.includes('不离开首页'),
    'README 缺少说明',
  );
});

console.log('');
if (failures.length) {
  console.log('FAIL ' + failures.length + ' / ' + (passed.length + failures.length));
  process.exitCode = 1;
} else {
  console.log('OK  ' + passed.length + ' / ' + passed.length);
}
