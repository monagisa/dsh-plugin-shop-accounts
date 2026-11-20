import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const R = (rel) => path.join(ROOT, rel);
const rpa = await import(pathToFileURL(R('lib/rpa.mjs')).href);
const rpaSrc = fs.readFileSync(R('lib/rpa.mjs'), 'utf8');
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

const driverOf = (value) => ({
  async goto(u) { return { url: u }; },
  async evaluate() { return value; },
  async url() { return 'https://yingxiao.pinduoduo.com/mains/promotionOverview'; },
  async sleep() {},
});

async function assertStep(value, expect) {
  return rpa.runOps(
    {
      ops: [{ op: 'assert', expr: 'x', expect, code: 'LOGIN_REQUIRED', message: '未登录或登录态失效（登录框仍可见）', stepId: 'g' }],
      postprocess: [],
      declaredArtifacts: [],
    },
    driverOf(value),
    {},
  );
}

console.log('\nfeatures-v02046 登录守卫的 detached 语义（推广后台误判修复）');

test('A1 「不存在」类断言在元素没找到时通过（detached 不再误判成未登录）', async () => {
  const r = await assertStep({ found: false, visible: false }, 'detached');
  assert.equal(r.ok, true, '元素不存在却判成失败');
});

test('A2 元素存在且可见时仍然判失败（真的是登录页要拦住）', async () => {
  const r = await assertStep({ found: true, visible: true }, 'detached');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LOGIN_REQUIRED');
});

test('A3 元素存在但不可见时通过（DOM 里有隐藏模板不算登录页）', async () => {
  const r = await assertStep({ found: true, visible: false }, 'detached');
  assert.equal(r.ok, true, '隐藏的登录模板把正常页面误判成未登录');
});

test('A4 not-present / absent / hidden 三种写法都按「必须不存在」处理', async () => {
  for (const expect of ['not-present', 'absent', 'hidden', 'not-visible']) {
    const r = await assertStep({ found: false, visible: false }, expect);
    assert.equal(r.ok, true, expect + ' 没按「不存在」处理');
  }
});

test('A5 可见性断言不受影响（visible 仍然要求找到且可见）', async () => {
  const ok = await assertStep({ found: true, visible: true }, 'visible');
  assert.equal(ok.ok, true);
  const bad = await assertStep({ found: false, visible: false }, 'visible');
  assert.equal(bad.ok, false);
});

test('B1 本地执行器与 ego 执行器的状态判断都认 detached（两处都改过）', () => {
  const count = rpaSrc.split("want === 'detached'").length - 1;
  assert.equal(count, 2, '两处状态判断只有 ' + count + ' 处认 detached');
});

test('B2 上游移植配方里确实存在用 detached 写的登录守卫', () => {
  const files = fs.readdirSync(R('lib/rpa/dsls/pdd')).filter((f) => f.endsWith('.json'));
  let foundDetached = 0;
  for (const f of files) {
    const d = J('lib/rpa/dsls/pdd/' + f);
    const hits = JSON.stringify(d).split('"state":"detached"').length - 1;
    foundDetached += hits;
  }
  assert.ok(foundDetached >= 1, '拼多多配方里没有 detached 守卫，测试失去意义');
});

test('C1 版本已到 0.20.46，且 CHANGELOG / README 有记录', () => {
  assert.ok(pkg.version >= '0.20.46');
  assert.ok(fs.readFileSync(R('CHANGELOG.md'), 'utf8').includes('v0.20.46'));
  assert.ok(fs.readFileSync(R('README.md'), 'utf8').includes(pkg.version));
});

const passed = 8 - failed;
if (failed) {
  console.log('\n✗ failed');
} else {
  console.log('\n通过 ' + passed + ' 项');
}
