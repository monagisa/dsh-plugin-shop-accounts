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
const DASHBOARD = 'https://sycm.taobao.com/portal/home.htm';

await test('A1 淘宝配方读完接口后回到生意参谋首页', () => {
  const steps = readJson(RECIPES[0][1]).template.steps;
  const readUrlIdx = steps.findIndex((s) => s.action === 'readPageUrl' && String(s.outputKey) === 'finalUrl');
  assert.ok(readUrlIdx >= 0, '必须有记录 finalUrl 的 readPageUrl 步骤');
  const tail = steps.slice(readUrlIdx + 1);
  assert.ok(tail.some((s) => s.action === 'goto' && s.url === DASHBOARD), '读完后要回到首页');
  assert.ok(steps.filter((s) => s.action === 'goto' && String(s.url).includes('trend/v3.json')).length === 1, '接口只打开一次');
});

await test('A2 天猫配方同样在读完后回到首页', () => {
  const steps = readJson(RECIPES[1][1]).template.steps;
  const readUrlIdx = steps.findIndex((s) => s.action === 'readPageUrl' && String(s.outputKey) === 'finalUrl');
  assert.ok(readUrlIdx >= 0);
  const tail = steps.slice(readUrlIdx + 1);
  assert.ok(tail.some((s) => s.action === 'goto' && s.url === DASHBOARD));
});

await test('A3 回到首页这一步是可选步骤（失败不影响采集结果）', () => {
  for (const [, rel] of RECIPES) {
    const steps = readJson(rel).template.steps;
    const back = steps.filter((s) => s.action === 'goto' && s.url === DASHBOARD).pop();
    assert.ok(back, rel + ' 缺少回首页步骤');
    assert.equal(back.optional, true, rel + ' 回首页应当可选');
    assert.equal(back.onError, 'continue', rel + ' 回首页失败应当继续');
  }
});

await test('B1 编译后的 ops 顺序是「记录 finalUrl → 回首页」', () => {
  const compiled = compileExecution(readJson(RECIPES[0][1]), { start: '2026-11-13', end: '2026-11-13' });
  const ops = compiled.ops || compiled;
  const urlIdx = ops.findIndex((o) => o.op === 'url' && String(o.stepId).includes('read-url'));
  assert.ok(urlIdx >= 0, '应当有记录 finalUrl 的 url op');
  const after = ops.slice(urlIdx + 1).filter((o) => o.op === 'goto' && o.url === DASHBOARD);
  assert.ok(after.length >= 1, '记录之后应当回到首页');
  const jsonGotoIdx = ops.findIndex((o) => o.op === 'goto' && String(o.url).includes('trend/v3.json'));
  assert.ok(jsonGotoIdx >= 0 && jsonGotoIdx < urlIdx, '接口页要在记录 finalUrl 之前打开');
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

await test('C2 CHANGELOG 与 README 记录了「读完后回到首页」', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.20.33'), 'CHANGELOG 缺少 v0.20.33');
  assert.ok(changelog.includes('回到生意参谋首页') || changelog.includes('回首页'), 'CHANGELOG 缺少说明');
  const readme = read('README.md');
  assert.ok(readme.includes('回到生意参谋首页') || readme.includes('退回生意参谋首页'), 'README 缺少说明');
});

console.log('');
if (failures.length) {
  console.log('FAIL ' + failures.length + ' / ' + (passed.length + failures.length));
  process.exitCode = 1;
} else {
  console.log('OK  ' + passed.length + ' / ' + passed.length);
}
