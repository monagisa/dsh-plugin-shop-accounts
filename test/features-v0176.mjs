#!/usr/bin/env node
/**
 * features-v0176.mjs —— v0.17.6：站点配方里的 jQuery 扩展伪类与 xpath 文本标记
 *
 * 背景：抖音采集配方用的选择器不是标准 CSS，也不是干净的 xpath：
 *   · CSS 侧：`:visible` / `:text-is("$近30天")` / `:has-text("$近30天")` / `:has(...)`；
 *   · xpath 侧：`//*[...][normalize-space(.)='$近30天']`（`$` 是「精确文字」标记，不是字符）。
 * 旧实现直接 querySelectorAll / document.evaluate，前者抛错、后者把 `$` 当字面量 →
 * 元素「找不到」→ 采集时等不到日期栏、点不到时间维度。
 *
 * 这一版在页面预置脚本里做三件事：
 *   1) 拆掉扩展伪类，能用 CSS 的部分照常用，拆不出来的退化为「按文字找可见元素」；
 *   2) `:visible` 走真实可见性判断；
 *   3) xpath 里的 `$` 标记在求值前去干净。
 * 同时把「点击」从合成 click 改成真实鼠标事件（抖音的页签组件只认真实输入），
 * 并修掉 ego 执行器里 assert 用了未定义变量的问题。
 *
 * 跑法：node test/features-v0176.mjs （B 段会启动一个无头 Chrome，纯本地页面，不联网）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message ? err.message : String(err)));
  }
}
const section = (t) => console.log('\n' + t);

const R = await import(url('lib/rpa.mjs'));
const { PAGE_PRELUDE, EGO_EXECUTOR_SOURCE, exprRect, makeCdpDriver, compileExecution } = R;
const { resolveBrowserPath, pickPort, waitForCdp, waitPortGone } = await import(url('lib/chrome.mjs'));
const { evaluateInFrames, listPages, newPage, closePage } = await import(url('lib/cdp.mjs'));

// ── A. 预置脚本与执行器接线 ──────────────────────────────────────────────────
section('A. 选择器脚本与执行器接线');

await test('页面预置脚本认识 :visible / :text-is / :has-text，并去干净 xpath 里的 $ 标记', () => {
  assert.ok(PAGE_PRELUDE.includes('function splitPseudo'), '缺少 splitPseudo');
  assert.ok(PAGE_PRELUDE.includes('function cleanXPath'), '缺少 cleanXPath');
  assert.ok(PAGE_PRELUDE.includes('function selectNodes'), '缺少 selectNodes');
  assert.ok(PAGE_PRELUDE.includes(':visible'), '缺少 :visible 处理');
  // 伪类表里要同时认 text-is 与 has-text
  assert.ok(PAGE_PRELUDE.includes('has-text'), '伪类表里没有 has-text');
  // 关键：模板字符串里的正则必须写成 \\$ 才能在页面里成为「字面量 $」
  assert.ok(PAGE_PRELUDE.includes('\\$'), '页面脚本里没有转义后的字面量 $（模板字符串把反斜杠吃了）');
  assert.ok(!PAGE_PRELUDE.includes("= out.replace(/'$("), '页面脚本里的正则是裸 $（会被当成结尾锚点）');
});

await test('xpath 分支在求值前会先清掉 $ 标记', () => {
  const xpathUses = (PAGE_PRELUDE.match(/document\.evaluate\(cleanXPath\(value\)/g) || []).length;
  const docUses = (PAGE_PRELUDE.match(/doc\.evaluate\(cleanXPath\(value\)/g) || []).length;
  assert.ok(xpathUses >= 1, 'queryOne 的 xpath 分支没有走 cleanXPath');
  assert.ok(docUses >= 1, 'queryIn 的 xpath 分支没有走 cleanXPath');
});

await test('点击走真实鼠标事件：rectExpr + driver.clickAt', () => {
  const rect = exprRect([{ by: 'css', value: 'body' }], null);
  assert.ok(rect.includes('window.__rpa.find'), 'exprRect 没有用 find');
  assert.ok(rect.includes('scrollIntoView'), 'exprRect 没有滚动到可见区');
  assert.ok(rect.includes('getBoundingClientRect'), 'exprRect 没取坐标');
  const src = readText('lib/rpa.mjs');
  assert.ok(src.includes('makeCdpDriver') && src.includes('async clickAt('), 'Chrome driver 没有 clickAt');
  assert.ok(src.includes("rec.clickedBy = 'mouse'"), '主执行器没有记录真实鼠标点击');
  assert.ok(src.includes('Input.dispatchMouseEvent'), '没有走 CDP 真实鼠标事件');
});

await test('ego 执行器的 assert 不再引用未定义变量', () => {
  assert.ok(EGO_EXECUTOR_SOURCE.includes('const assertValue = await evalIn(o.expr)'), 'ego assert 没有先求值');
  assert.ok(!EGO_EXECUTOR_SOURCE.includes('matchState(v, o.expect)'), 'ego assert 仍在用未定义的 v');
});

await test('编译 click 步骤时带上 rectExpr', () => {
  const dsl = {
    id: 'x',
    template: { steps: [{ action: 'click', target: [{ by: 'css', value: '.t' }] }] },
  };
  const exec = compileExecution(dsl);
  const clickOp = exec.ops.find((o) => o.op === 'click');
  assert.ok(clickOp, '没有编译出 click');
  assert.ok(clickOp.rectExpr && clickOp.rectExpr.includes('getBoundingClientRect'), 'click op 没有 rectExpr');
});

// ── B. 真机：选择器与真实点击 ────────────────────────────────────────────────
section('B. 真机（无头 Chrome）');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  .hidden { display: none; }
</style></head><body>
  <div data-dynamic-module-component="BusinessAnalysisV3">
    <div class="aurora-dorami-date-picker-wrapper">
      <div role="tablist" class="aurora-tabs" style="display:flex">
        <div role="tab" class="aurora-tabs-tab-btn aurora-tabs-tab-active" aria-selected="true">近7天</div>
        <div role="tab" class="aurora-tabs-tab-btn" aria-selected="false" id="t30">近30天</div>
        <div role="tab" class="aurora-tabs-tab-btn hidden" aria-selected="false">近1天</div>
      </div>
    </div>
  </div>
<script>
  window.__events = [];
  var t30 = document.getElementById('t30');
  t30.addEventListener('mousedown', function () {
    window.__events.push('mousedown');
    document.body.dataset.clicked = '1';
  });
</script></body></html>`;

let profile = '';
let port = 0;
let child = null;
let pageWs = '';

async function boot() {
  const exe = resolveBrowserPath('');
  port = await pickPort(9700, []);
  profile = path.join(os.tmpdir(), 'dsh-sa-v0176-' + Date.now());
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(profile, { recursive: true });
  // 直接把测试页面当启动页，避免多开一个空白标签导致真实点击落到别的标签上
  const startUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE);
  child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + port, startUrl], { stdio: 'ignore', windowsHide: true });
  await waitForCdp(port, 20000);
  let pages = [];
  for (let i = 0; i < 20; i += 1) {
    pages = await listPages(port).catch(() => []);
    if (pages.some((x) => String(x.url || '').startsWith('data:text/html'))) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const found = pages.find((x) => String(x.url || '').startsWith('data:text/html'));
  assert.ok(found && found.webSocketDebuggerUrl, '启动页没有被打开');
  pageWs = found.webSocketDebuggerUrl;
  // 等页面真的渲染完：不同机器上启动页就绪时间差别很大，直接读会读到空 DOM
  for (let i = 0; i < 30; i += 1) {
    const ready = await evaluateInFrames(pageWs, {
      expression: 'JSON.stringify({ s: document.readyState, has: Boolean(document.querySelector && document.querySelector(\'[role="tablist"]\')) })',
      satisfy: (v) => Boolean(v),
      timeoutMs: 5000,
    }).catch(() => null);
    let st = null;
    try { st = ready && ready.value ? JSON.parse(typeof ready.value === 'string' ? ready.value : JSON.stringify(ready.value)) : null; } catch (e) { st = null; }
    if (st && st.s === 'complete' && st.has) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}

await test('真机：扩展伪类能选出元素，负向用例不误判', async () => {
  if (!pageWs) await boot();
  const expr = `${PAGE_PRELUDE};(() => {
    const q = (t) => { try { const el = window.__rpa.queryOne(t); return el ? String((el.textContent || '').trim()) : null; } catch (e) { return 'ERR:' + e.message; } };
    return JSON.stringify({
      tablist: q({ by: 'css', value: '[role="tablist"]:visible' }),
      byTextIs: q({ by: 'css', value: '[role="tab"]:visible:is(:text-is("$近30天"))' }),
      byHasText: q({ by: 'css', value: '.aurora-tabs-tab-active:has-text("$近7天")' }),
      byXpath: q({ by: 'xpath', value: "//*[contains(@class,'aurora-tabs-tab-btn')][normalize-space(.)='$近30天']" }),
      selectedMismatch: q({ by: 'css', value: '[role="tab"][aria-selected="true"]:is(:text-is("$近30天"))' }),
      hiddenTab: q({ by: 'css', value: '[role="tab"]:visible:is(:text-is("$近1天"))' })
    });
  })()`;
  const res = await evaluateInFrames(pageWs, { expression: expr, satisfy: (v) => Boolean(v), timeoutMs: 8000 });
  assert.ok(res.ok, '求值失败');
  const out = typeof res.value === 'string' ? JSON.parse(res.value) : res.value;
  assert.ok(out.tablist, ':visible 没选中 tablist（实际 ' + out.tablist + '）');
  assert.equal(out.byTextIs, '近30天', ':text-is 没选中近30天');
  assert.equal(out.byHasText, '近7天', ':has-text 没选中当前页签');
  assert.equal(out.byXpath, '近30天', 'xpath 的 $ 标记没去掉');
  assert.equal(out.selectedMismatch, null, 'aria-selected 负向用例被误判成命中');
  assert.equal(out.hiddenTab, null, ':visible 把隐藏的页签也算上了');
});

await test('真机：driver.clickAt 用真实鼠标事件点中元素', async () => {
  if (!pageWs) await boot();
  const rect = await evaluateInFrames(pageWs, {
    expression: exprRect([{ by: 'css', value: '#t30' }], null), satisfy: (v) => Boolean(v && v.found), timeoutMs: 8000,
  });
  assert.ok(rect.ok && rect.value && rect.value.found, '没拿到按钮坐标');
  const driver = makeCdpDriver({ port });
  await driver.clickAt(rect.value.x, rect.value.y);
  await new Promise((r) => setTimeout(r, 300));
  const after = await evaluateInFrames(pageWs, {
    expression: `JSON.stringify({ clicked: document.body.dataset.clicked || '', events: (window.__events || []).length, sel: (document.getElementById('t30') || {}).getAttribute ? document.getElementById('t30').getAttribute('aria-selected') : '' })`,
    satisfy: (v) => Boolean(v), timeoutMs: 8000,
  });
  const st = typeof after.value === 'string' ? JSON.parse(after.value) : after.value;
  assert.equal(st.clicked, '1', '真实鼠标点击没触发页面的 mousedown');
  // 注意：CDP 隔离世界共享 DOM 但不共享 window 上的变量，
  // 所以这里只断言页面写进 DOM 的标记，不信 window.__events。
});

// ── C. 文档与版本 ────────────────────────────────────────────────────────────
section('C. 文档与版本');

await test('版本号与变更记录已覆盖 0.17.6', () => {
  const pkg = JSON.parse(readText('package.json'));
  const parts = String(pkg.version).split('.').map(Number);
  const ok = parts[0] === 0 && (parts[1] > 17 || (parts[1] === 17 && parts[2] >= 6));
  assert.ok(ok, 'package.json 版本还没到 0.17.6（当前 ' + pkg.version + '）');
  assert.ok(readText('CHANGELOG.md').includes('0.17.6'), 'CHANGELOG 里没有 0.17.6');
  assert.ok(readText('CHANGELOG.md').includes('0.17.6'), 'CHANGELOG 里没有 0.17.6');
});

// ── 收尾 ─────────────────────────────────────────────────────────────────────
if (child) {
  try { child.kill(); } catch (e) {}
  await waitPortGone(port, 3000).catch(() => {});
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n通过 ' + passed + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项' : ''));
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f.name + ': ' + (f.err && f.err.stack ? f.err.stack : f.err));
  process.exitCode = 1;
}
