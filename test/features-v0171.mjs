#!/usr/bin/env node
/**
 * features-v0171.mjs —— v0.17.1：抖店（抖音电商后台）的账密代填要先切「邮箱登录」
 *
 * 用户实测反馈：抖店后台默认只有手机号 + 验证码登录，代填一直失败，需要先切到邮箱登录。
 *
 * 实测页面（fxg.jinritemai.com/login/common）：
 *   · 默认页签「手机登录」：input[name="mobile"]（手机号码）+ input[name="mobilecaptcha"]（验证码），没有密码框；
 *   · 页签是 div.account-center-switch-button.email（文字「邮箱登录」）；
 *   · 点它之后才出现 input[name="email"]（请输入邮箱）+ input[name="password"]，
 *     提交按钮 button.account-center-action-button[type="submit"]。
 *
 * 这一版给流程加了「先点页签、等表单渲染、再填」这一步（preClick / preTexts / preWaitMs），
 * 并在 Chrome 与 ego 两条链路都接上。
 *
 * 跑法：node test/features-v0171.mjs （B 段会启动一个无头 Chrome，纯本地页面，不联网）
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

const A = await import(url('lib/autologin.mjs'));
const { LOGIN_FLOWS, buildFillExpression, preClickExpression, loginFlowFor } = A;
const { resolveBrowserPath, pickPort, waitForCdp, waitPortGone } = await import(url('lib/chrome.mjs'));
const { evaluateInFrames, listPages } = await import(url('lib/cdp.mjs'));

// ── A. 流程与接线 ───────────────────────────────────────────────────────────
section('A. 抖店流程的定义与接线');

await test('抖店流程：先点「邮箱登录」页签，再按邮箱/密码表单填', () => {
  const flow = LOGIN_FLOWS.douyin;
  assert.ok(Array.isArray(flow.preClick) && flow.preClick.includes('.account-center-switch-button.email'), '要有邮箱页签的 CSS 选择器');
  assert.ok(Array.isArray(flow.preTexts) && flow.preTexts.includes('邮箱登录'), 'CSS 找不到时要能按文字点');
  assert.equal(typeof flow.preWaitMs, 'number');
  assert.ok(flow.preWaitMs >= 300, '点完页签要给表单渲染一点时间');
  assert.equal(flow.user[0], 'input[name="email"]', '账号框优先找邮箱输入框');
  assert.ok(flow.pass.includes('input[name="password"]'));
  assert.ok(flow.submit.includes('.account-center-action-button'));
});

await test('别的平台不受影响：只有抖店带 preClick', () => {
  for (const id of ['taobao', 'tmall', 'ali1688', 'jd', 'pdd']) {
    const flow = LOGIN_FLOWS[id];
    assert.equal(flow.preClick, undefined, id + ' 不该有 preClick');
    assert.equal(flow.preTexts, undefined, id + ' 不该有 preTexts');
  }
  assert.ok(loginFlowFor('douyin', 'seller'), '抖店卖家有流程');
});

await test('preClickExpression 是一段能跑的脚本，按 CSS 或文字点页签', () => {
  const expr = preClickExpression(LOGIN_FLOWS.douyin);
  assert.ok(typeof expr === 'string' && expr.length > 100);
  assert.match(expr, /account-center-switch-button\.email/);
  assert.match(expr, /邮箱登录/);
  const fn = new Function(expr); // 只编译不执行（浏览器里才有 document）
  assert.equal(typeof fn, 'function', '表达式应是可编译的脚本');
  assert.match(expr, /out\.clicked = true/, '点中要留下记录');
  assert.match(expr, /by = 'css'/, '优先按选择器点');
  assert.match(expr, /by = 'text'/, '选择器选不中时按文字点');
});

await test('Chrome 链路：填之前先点页签并等待', () => {
  const src = readText('lib/autologin.mjs');
  assert.match(src, /preClickExpression\(flow\)/, '要先执行点页签脚本');
  assert.match(src, /satisfy: \(v\) => Boolean\(v && v\.clicked\)/, '点到才算成功');
  assert.match(src, /await sleep\(Number\(flow\.preWaitMs\)/, '点完要等表单渲染');
});

await test('ego 链路：点页签脚本与等待时间都传进运行时', () => {
  const al = readText('lib/autologin.mjs');
  assert.match(al, /preExpr: hasPreClick/);
  const ego = readText('lib/ego.mjs');
  assert.match(ego, /P\.preExpr/, '运行时里要比对点页签脚本');
  assert.match(ego, /Number\(P\.preWaitMs\)/, '运行时里要等渲染');
  assert.match(ego, /preExpr: String\(preExpr \|\| ''\)/, 'payload 里要有 preExpr');
});

// ── B. 真实浏览器：本地复刻抖店的页签结构 ───────────────────────────────────
section('B. 真实浏览器：先切页签再填（本地页面，不联网）');

const exe = resolveBrowserPath('');

const PAGE_HTML = (withClass) => `<!doctype html><html><head><meta charset="utf-8"><title>抖店登录</title></head>
<body>
  <div class="account-center-switch-row switch-type-switch">
    <div class="${withClass ? 'account-center-switch-button switch-switch true mobile' : ''}" id="tab-mobile">手机登录</div>
    <div class="${withClass ? 'account-center-switch-button switch-switch false email' : 'plain-tab'}" id="tab-email">邮箱登录</div>
  </div>
  <div id="panel-mobile">
    <input name="mobile" type="number" placeholder="手机号码" />
    <input name="mobilecaptcha" id="code" placeholder="验证码" />
  </div>
  <div id="panel-email" style="display:none">
    <input name="email" type="text" placeholder="请输入邮箱" />
    <input name="password" type="password" placeholder="密码" />
    <button class="ace-ui-btn account-center-action-button" type="submit">登录</button>
  </div>
  <script>
    // 真实站点的表单是框架异步渲染的：点页签后要过一会儿才出现邮箱表单。
    // 这里用 setTimeout 复刻这个事实，正是「在填充脚本里顺手点一下页签不够用」的原因。
    document.getElementById('tab-email').addEventListener('click', function () {
      setTimeout(function () {
        document.getElementById('panel-email').style.display = '';
        document.getElementById('panel-mobile').style.display = 'none';
      }, 250);
    });
  </script>
</body></html>`;

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function startPage(withClass) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML(withClass));
  });
  const pagePort = await listen(server);
  return { pageUrl: `http://127.0.0.1:${pagePort}/login/common`, close() { server.close(); } };
}

async function launchHeadless(basePort) {
  const port = await pickPort(basePort, []);
  const profileDir = path.join(os.tmpdir(), 'dsh-sa-test-dy-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1200,800',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore', detached: false });
  await waitForCdp(port, 15000);
  return {
    port, child, profileDir,
    async close() {
      try { child.kill(); } catch (e) { /* 已退出 */ }
      await waitPortGone(port, 5000).catch(() => {});
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* 文件被占就留给系统清理 */ }
    },
  };
}

async function openPage(browser, pageUrl) {
  const p0 = (await listPages(browser.port))[0];
  await evaluateInFrames(p0.webSocketDebuggerUrl, {
    expression: 'location.href=' + JSON.stringify(pageUrl) + ";'go'", expectedPort: browser.port, satisfy: (v) => v === 'go',
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const pages = await listPages(browser.port);
  const page = pages.find((p) => String(p.url || '').includes(pageUrl.replace(/^http:\/\/[^/]+/, ''))) || pages[0];
  return page.webSocketDebuggerUrl;
}

const STATE_EXPR = `JSON.stringify({
  emailShown: !!document.querySelector('#panel-email') && getComputedStyle(document.querySelector('#panel-email')).display !== 'none',
  email: (document.querySelector('input[name="email"]') || {}).value || '',
  pass: (document.querySelector('input[name="password"]') || {}).value || '',
  mobile: (document.querySelector('input[name="mobile"]') || {}).value || ''
})`;

if (!exe) {
  await test('（跳过）本机没装 Chrome/Edge，跑不了真实浏览器验证', () => {
    assert.ok(true);
  });
} else {
  await test('没点页签直接填 → 只填到手机号框、密码填不上（这就是之前失败的原因）', async () => {
    const p1 = await startPage(true);
    const browser = await launchHeadless(9700);
    try {
      const ws = await openPage(browser, p1.pageUrl);
      // 手机号框是 type=number，用数字账号才能看出「值被塞进了手机号框」。
      const fill = await evaluateInFrames(ws, { expression: buildFillExpression({ username: '13800138000', password: 'probe-pass', flow: LOGIN_FLOWS.douyin }), expectedPort: browser.port });
      const v = fill && fill.value;
      assert.ok(v, '填充脚本应返回结果');
      assert.equal(v.passFilled, false, '密码框还藏在没显示的页签里，填不上');
      assert.equal(v.submitted, false, '账号/密码没填全就不该提交');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: STATE_EXPR, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.mobile, '13800138000', '账号被塞进了手机号框');
      assert.equal(st.emailShown, false, '邮箱表单还没露出来');
    } finally {
      await browser.close();
      p1.close();
    }
  });

  await test('先点「邮箱登录」→ 邮箱表单出现 → 邮箱与密码都填上并提交', async () => {
    const p2 = await startPage(true);
    const browser = await launchHeadless(9710);
    try {
      const ws = await openPage(browser, p2.pageUrl);
      const pre = await evaluateInFrames(ws, { expression: preClickExpression(LOGIN_FLOWS.douyin), expectedPort: browser.port, satisfy: (v) => Boolean(v && v.clicked) });
      assert.equal(pre.value.clicked, true, '应点中邮箱页签');
      assert.equal(pre.value.by, 'css', '优先按选择器点');
      await new Promise((r) => setTimeout(r, Number(LOGIN_FLOWS.douyin.preWaitMs) || 600));
      const fill = await evaluateInFrames(ws, { expression: buildFillExpression({ username: 'probe@example.com', password: 'probe-pass', flow: LOGIN_FLOWS.douyin }), expectedPort: browser.port });
      const v = fill && fill.value;
      assert.equal(v.userFilled, true, '邮箱框应填上');
      assert.equal(v.passFilled, true, '密码框应填上');
      assert.equal(v.submitted, true, '填全后应点登录');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: STATE_EXPR, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.email, 'probe@example.com', '值应落在邮箱框');
      assert.equal(st.pass, 'probe-pass', '值应落在密码框');
      assert.equal(st.mobile, '', '手机号框不该被填');
    } finally {
      await browser.close();
      p2.close();
    }
  });

  await test('页签没有 class 时按文字点（站点改样式也不会一刀切失效）', async () => {
    const p3 = await startPage(false);
    const browser = await launchHeadless(9720);
    try {
      const ws = await openPage(browser, p3.pageUrl);
      const pre = await evaluateInFrames(ws, { expression: preClickExpression(LOGIN_FLOWS.douyin), expectedPort: browser.port, satisfy: (v) => Boolean(v && v.clicked) });
      assert.equal(pre.value.clicked, true);
      assert.equal(pre.value.by, 'text', 'CSS 选不中时按文字兜底');
      assert.equal(pre.value.target, '邮箱登录');
    } finally {
      await browser.close();
      p3.close();
    }
  });
}

// ── C. 版本与文档 ───────────────────────────────────────────────────────────
section('C. 版本与文档');

await test('版本号与文档已覆盖 0.17.1', () => {
  const pkg = JSON.parse(readText('package.json'));
  const [maj, min, patchNo] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patchNo >= 1)), '版本号应 ≥0.17.1，实际 ' + pkg.version);
  assert.ok(readText('CHANGELOG.md').includes('0.17.1'));
  assert.ok(readText('README.md').includes('0.17.1'));
});

console.log('\n' + (failures.length ? '\u2717 ' + failures.length + ' failed' : '\u2713 all passed') + ' (' + passed + ' checks)');
if (failures.length) {
  console.error(failures.map((f) => f.name + ': ' + (f.err && f.err.stack ? f.err.stack : f.err)).join('\n\n'));
  process.exit(1);
}
