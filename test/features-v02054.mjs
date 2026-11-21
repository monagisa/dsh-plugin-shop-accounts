import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    console.log('  ✗ ' + name);
    console.log(String((err && err.message) || err));
  }
}

const egoSrc = read('lib/ego.mjs');
const versionAtLeast = (got, want) => {
  const a = got.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
};

console.log('1. 被用户控制时自动换窗口');
test('A1 只对 ego_user_in_control 重试', () => {
  assert.ok(egoSrc.includes("if (!first || first.code !== 'ego_user_in_control') return first;"), '缺少重试判断');
});
test('A2 换窗口用同 profile 的新空间名（(2)/(3)）', () => {
  assert.ok(egoSrc.includes("for (const suffix of [' (2)', ' (3)'])"), '缺少备用窗口后缀');
  assert.ok(egoSrc.includes('const altSpace = baseName + suffix;'), '缺少拼接备用空间名');
});
test('A3 关闭/交还控制权不重试（那两种操作本来就不该碰用户窗口）', () => {
  assert.ok(egoSrc.includes("if (op === 'close' || op === 'handoff') return first;"), 'close/handoff 不该重试');
});
test('A4 已经是备用名时不再套叠（(2) 不会再变成 (2) (2)）', () => {
  assert.ok(egoSrc.includes("const baseName = payload.space.replace(/ \\((2|3|4|5)\\)$/, '');"), '缺少备用名归一化');
  assert.ok(egoSrc.includes('if (baseName !== payload.space) return first;'), '缺少已备用名短路');
});
test('A5 结果里标明「原来是哪个窗口被用户占着」与「换成了哪个」', () => {
  assert.ok(egoSrc.includes('autoAltSpace: altSpace'), '缺少 autoAltSpace');
  assert.ok(egoSrc.includes('spaceWasInUserControl: payload.space'), '缺少 spaceWasInUserControl');
});

console.log('2. 换窗口后仍能正常收尾');
test('B1 换窗口的执行结果透传给上层（失败仍如实返回）', () => {
  assert.ok(egoSrc.includes('if (retried && retried.code !=='), '换窗口后应判断结果');
  assert.ok(egoSrc.includes('return Object.assign({}, retried'), '应返回换窗口后的结果');
});

console.log('3. 版本与文档');
test('C1 版本号已到 0.20.54', () => {
  const got = (read('package.json').match(/"version":\s*"([^"]+)"/) || [])[1] || '';
  assert.ok(versionAtLeast(got, '0.20.54'), '版本落后：' + got);
});
test('C2 更新日志写清了这次的自动换窗口', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(cl.includes('## v0.20.54'), 'CHANGELOG 缺 v0.20.54');
  assert.ok(cl.includes('归你控制'), 'CHANGELOG 没提「归你控制」');
  assert.ok(cl.includes('新开'), 'CHANGELOG 没提新开窗口');
});

console.log('\n全部通过（' + passed + ' 项）');
if (failed) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
