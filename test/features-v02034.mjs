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
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const RECIPES = [
  'lib/rpa/dsls/taobao/tb_shop_overview.json',
  'lib/rpa/dsls/tmall/tmall_shop_overview.json',
];

await test('A1 evaluate 动作编译成页内 eval op，并带上输出键', () => {
  const dsl = {
    id: 'probe_evaluate',
    platform: 'taobao',
    template: {
      steps: [
        { id: 'p:goto', action: 'goto', url: 'https://example.invalid/' },
        { id: 'p:read', action: 'evaluate', expression: 'return (1 + 1) + "";', outputKey: 'probe_value' },
      ],
    },
  };
  const compiled = compileExecution(dsl, { start: '2026-11-13', end: '2026-11-13' });
  const ops = compiled.ops || compiled;
  const evalOp = ops.find((o) => o.op === 'eval' && String(o.expr).includes('(1 + 1)'));
  assert.ok(evalOp, 'evaluate 动作应编译成 eval op');
  assert.equal(evalOp.outputKey, 'probe_value');
  assert.ok(String(evalOp.expr).includes('try {'), '表达式会被包一层 try/catch');
});

await test('A2 页内脚本执行失败会判这一步失败（不再静默写进产物）', () => {
  const src = read('lib/rpa.mjs');
  assert.ok(
    src.includes('value.ok === false') && src.includes('页内脚本执行失败'),
    'runOps 的 eval 分支应当检查 ok:false 并抛出失败',
  );
  assert.ok(src.includes('code: o.notFoundCode || RPA_CODES.STEP_FAILED'), '失败时应当带 STEP_FAILED 错误码');
});

await test('A3 两条配方的接口读取都排在登录守卫之后、记录地址之前', () => {
  for (const rel of RECIPES) {
    const steps = JSON.parse(read(rel)).template.steps;
    const readIdx = steps.findIndex((s) => s.action === 'evaluate' && String(s.expression || '').includes('trend/v3.json'));
    const guardIdx = steps.findIndex((s) => s.id === 'tmall_store_overview_30d_rpa:login-iframe-form-detected');
    const urlIdx = steps.findIndex((s) => s.action === 'readPageUrl' && String(s.outputKey) === 'finalUrl');
    assert.ok(readIdx >= 0, rel + ' 缺少读接口步骤');
    assert.ok(guardIdx >= 0 && guardIdx < readIdx, rel + ' 登录守卫要在读接口之前');
    assert.ok(urlIdx > readIdx, rel + ' 记录 finalUrl 在读接口之后');
  }
});

await test('B1 README 写明了接口在页内读取、不跳转页面', () => {
  const readme = read('README.md');
  assert.ok(
    readme.includes('页内请求') || readme.includes('不再跳转到接口页面') || readme.includes('不离开首页'),
    'README 需要说明接口是页内读取',
  );
});

await test('C1 版本号已到 0.20.34', () => {
  const parts = String(pkg.version).split('.').map(Number);
  const atLeast = (v) => {
    const p = v.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      if ((parts[i] || 0) > (p[i] || 0)) return true;
      if ((parts[i] || 0) < (p[i] || 0)) return false;
    }
    return true;
  };
  assert.ok(atLeast('0.20.34'), '当前版本 ' + pkg.version);
});

await test('C2 CHANGELOG 记录了 v0.20.34 与页内读取', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.20.34'), 'CHANGELOG 缺少 v0.20.34');
  assert.ok(changelog.includes('页内') || changelog.includes('不再跳转'), 'CHANGELOG 缺少说明');
});

console.log('');
if (failures.length) {
  console.log('FAIL ' + failures.length + ' / ' + (passed.length + failures.length));
  process.exitCode = 1;
} else {
  console.log('OK  ' + passed.length + ' / ' + passed.length);
}
