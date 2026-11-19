import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function versionAtLeast(actual, min) {
  const a = String(actual).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

const rpaSource = read('lib/rpa.mjs');

await test('A1 ego 执行器的 eval 分支遇到页内脚本抛错要硬失败', () => {
  assert.ok(rpaSource.includes('if (v && typeof v === \'object\' && v.ok === false)'), 'ego 执行器缺少 ok:false 硬失败');
  assert.ok(rpaSource.includes('页内脚本执行失败'), '缺少页内脚本执行失败的提示');
  assert.ok(rpaSource.includes("{ code: o.notFoundCode || 'STEP_FAILED' }"), '失败码不对');
});

await test('A2 ego 执行器的 eval 分支解包 {ok:true,value}', () => {
  assert.ok(rpaSource.includes('v.ok === true && Object.prototype.hasOwnProperty.call(v, \'value\')'), 'ego 执行器没有把接口返回的字符串解出来');
});

await test('A3 产物仍优先取表达式里的 text 字段', () => {
  assert.ok(rpaSource.includes("Object.prototype.hasOwnProperty.call(v, 'text')"), 'ego 执行器不再取 text');
});

await test('B1 本地执行器同样解包 {ok,value}，两边行为一致', () => {
  assert.ok(rpaSource.includes("value && typeof value === 'object' && 'value' in value ? value.value : value"), '本地执行器没有解包');
  assert.ok(rpaSource.includes("Object.prototype.hasOwnProperty.call(value, 'text')"), '本地执行器没有取 text');
});

await test('B2 两处 eval 分支都写入产物（不会有一边漏）', () => {
  const count = (rpaSource.match(/outputs\[o\.outputKey\] =/g) || []).length;
  assert.ok(count >= 2, '只找到 ' + count + ' 处写产物，应该有本地与 ego 两处');
});

await test('C1 版本号已到 0.20.36', () => {
  assert.ok(versionAtLeast(pkg.version, '0.20.36'), 'package.json 版本还是 ' + pkg.version);
});

await test('C2 CHANGELOG 写清这次修的是什么', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(cl.includes('v0.20.36'), 'CHANGELOG 缺 v0.20.36');
  assert.ok(cl.includes('[object Object]') || cl.includes('15 字节'), 'CHANGELOG 没说明产物变成 [object Object] 的现象');
});

if (failures.length) {
  console.log('\n' + failures.length + ' 项失败');
  for (const f of failures) {
    if (f.err && f.err.stack) console.log(f.err.stack);
  }
  process.exitCode = 1;
} else {
  console.log('\n\u2713 全部通过（' + passed.length + ' 项）');
}
