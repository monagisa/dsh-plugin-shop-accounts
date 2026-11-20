// 自检：页面字体解码（v0.20.44）
// 参考实现的做法：数字是私有区字符、字形是标准无衬线数字，所以「画字形 + 比位图」就能建当次会话的码位映射。
// 我们之前把画字形放在隔离世界里执行，取不到像素；这版改成在页面主世界求值，并允许「只解出一部分」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const rpa = await import(pathToFileURL(path.join(ROOT, 'lib/rpa.mjs')).href);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'lib/rpa.mjs'), 'utf8');
const egoSrc = fs.readFileSync(path.join(ROOT, 'lib/ego.mjs'), 'utf8');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, message: String((err && err.message) || err) });
    console.log('  ✗ ' + name + '\n      ' + String((err && err.message) || err).slice(0, 300));
  }
}

console.log('\nv0.20.44 页面字体解码（主世界求值 + 部分解码 + 未知符号按缺失）');

await test('A1 参考位图包含常用符号，符号判据比数字更严', () => {
  assert.ok(rpa.FONT_DECODE_EXPR_FN.includes("const SYMBOLS = ['-', '.', '%'"), '缺符号参考清单');
  assert.ok(rpa.FONT_DECODE_EXPR_FN.includes('0.78'), '符号应有更严的相似度门槛');
});

await test('A2 映射的 key 是裸十六进制（不带 U+ 前缀）', () => {
  assert.ok(/mapping\[String\(items\[0\]\.code\)\.replace\(\/\^U\\\+/.test(rpa.FONT_DECODE_EXPR_FN), '映射 key 没有归一化成裸十六进制');
});

await test('A3 解析指标前会去掉解不出的私有区标记', () => {
  const spec = { metrics: [{ id: 'payAmt', label: '成交金额' }] };
  const parsed = rpa.parseTextMetrics('成交金额[?U+E761]55.28 较前1日0.00', spec);
  assert.equal(parsed.values.payAmt, 55.28);
});

await test('B1 ego 执行器里有主世界求值动作（画字形要在主世界才取得到像素）', () => {
  assert.ok(egoSrc.includes("if (op === 'maineval')"), 'ego 执行器缺 maineval 动作');
  assert.ok(egoSrc.includes("page.cdp('Runtime.evaluate'"), '主世界求值没走 CDP Runtime.evaluate');
});

await test('B2 解码结果为空时会再等一次（页面字体是懒加载的）', () => {
  assert.ok(serverSrc.includes('页面字体是懒加载的'), '缺「空结果重试」的处理');
});

await test('B3 只解出一部分时不再判整轮失败', () => {
  const egoPart = serverSrc.slice(serverSrc.indexOf('export const EGO_EXECUTOR_SOURCE'));
  assert.ok(egoPart.includes("action = 'decrypt-partial'"), 'ego 执行器应把部分解码标成 decrypt-partial');
  assert.ok(!/if \(unresolved\.length\) \{\s*return \{ ok: false/.test(egoPart), '部分解码不应直接判失败');
});

await test('C1 一个字形都认不出时仍然报失败，不把没解开的当业务数据', async () => {
  const driver = {
    async goto(u) { return { url: u }; },
    async evaluate(expr) {
      const e = String(expr);
      if (e.includes('document.fonts')) return { ok: true, mapping: {} };
      return { found: true, text: '商品访客数\ue3f7' };
    },
    async find() { return { found: true }; },
    async click() { return { ok: true }; },
    async readText() { return { text: '商品访客数\ue3f7' }; },
    async sleep() {},
    async currentUrl() { return 'about:blank'; },
  };
  const res = await rpa.runOps(
    { ops: [{ op: 'eval', stepId: 'read-home', expr: 'x', outputKey: 'home_text' }], postprocess: ['pdd_decrypt'], declaredArtifacts: [] },
    driver,
    {},
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PDD_FONT_DECRYPT_FAILED');
});

await test('D1 版本已到 0.20.44，且 CHANGELOG / README 有记录', () => {
  const version = String(pkg.version);
  console.log('      当前版本：' + version);
  assert.ok(version >= '0.20.44' || version.startsWith('0.20.4'), '版本号没跟上');
  assert.ok(changelog.includes('v0.20.44'), 'CHANGELOG 缺 v0.20.44');
  assert.ok(readme.includes('features-v02044'), 'README 自检清单缺 features-v02044');
  assert.ok(readme.includes(version), 'README 版本行没跟上');
});

if (failures.length) {
  console.log('\n✗ ' + failures.length + ' failed (' + passed + ' passed)');
  process.exitCode = 1;
} else {
  console.log('\n✓ all passed (' + passed + ' checks)');
}
