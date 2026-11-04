#!/usr/bin/env node
/**
 * features-v0173.mjs —— v0.17.3：代填时自动勾选「同意用户协议 / 隐私条款」
 *
 * 用户实测反馈：抖店登录时没有勾选「同意用户守则」，登录因此被拒。
 *
 * 实测页面（fxg.jinritemai.com/login/common，邮箱登录页签）：
 *   · 勾选框是 input.auxo-checkbox-input（在 label.auxo-checkbox-wrapper 里，16×16）；
 *   · 旁边文案「登录即代表同意 用户协议 和 隐私条款」；
 *   · 表单填满后登录按钮就会变可用（勾选与否都不置灰），但不勾服务端会拒，
 *     所以不能靠按钮状态判断，必须主动勾上。
 *
 * 这一版给表单流程加了「填完之后勾选协议」这一步：
 *   · 抖店走显式选择器（flow.agree）；
 *   · 其它平台没有显式选择器，按文案（协议 / 条款 / 隐私 / 守则）找，找不到就不动；
 *   · 只勾不取消，已经勾上的不动。
 *
 * 跑法：node test/features-v0173.mjs （B 段会启动无头 Chrome，纯本地页面，不联网）
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
    console.log('  ok  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n      ' + String((err && err.message) || err).split('\n').join('\n      '));
  }
}

const A = await import(url('lib/autologin.mjs'));
const { resolveBrowserPath, pickPort, waitForCdp, waitPortGone } = await import(url('lib/chrome.mjs'));
const { evaluateInFrames, listPages } = await import(url('lib/cdp.mjs'));

console.log('\n== A 表单流程与勾选逻辑 ==');

await test('抖店的表单流程声明了协议勾选框的选择器', () => {
  const flow = A.LOGIN_FLOWS.douyin;
  assert.ok(Array.isArray(flow.agree) && flow.agree.length > 0, '抖店缺少 agree 选择器');
  assert.ok(flow.agree.includes('input.auxo-checkbox-input'), '缺少实测到的 auxo-checkbox 选择器');
});

await test('其它平台的表单流程没有显式协议选择器（走按文案识别）', () => {
  for (const id of ['taobao', 'tmall', 'ali1688', 'jd', 'pdd']) {
    const flow = A.LOGIN_FLOWS[id];
    const base = flow.same ? A.LOGIN_FLOWS[flow.same] : flow;
    assert.equal(base.agree, undefined, id + ' 不应写死协议选择器');
  }
});

await test('填充脚本里有勾选协议这一步，且在提交之前执行', () => {
  const expr = A.buildFillExpression({ username: 'u', password: 'p', flow: A.LOGIN_FLOWS.douyin });
  assert.match(expr, /out\.agreeFound/, '填充脚本没有勾选协议的结果字段');
  assert.match(expr, /out\.agreeChecked/, '填充脚本没有记录勾选结果');
  assert.match(expr, /'协议', '条款', '隐私', '守则'/, '缺少按文案识别协议勾选框的关键词');
  assert.ok(expr.indexOf('out.agreeChecked') < expr.indexOf('out.submitted = true'), '勾选协议必须在提交之前');
});

await test('按文案识别只认登录须知，不会误勾「记住我」这类勾选', () => {
  const expr = A.buildFillExpression({ username: 'u', password: 'p', flow: A.LOGIN_FLOWS.jd });
  assert.ok(!expr.includes("'记住我'"), '不应把「记住我」当成协议勾选');
  assert.ok(expr.includes("'协议'"), '缺少协议关键词');
});

console.log('\n== B 真实浏览器：本地页面复刻协议勾选 ==');

const PAGE = (opts) => {
  const { checkboxCls, labelText, checkedAttr } = opts;
  return `<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head>
<body>
  <form>
    <input name="email" type="text" placeholder="请输入邮箱" />
    <input name="password" type="password" placeholder="密码" />
    <label class="${checkboxCls}">
      <span class="auxo-checkbox">
        <input class="auxo-checkbox-input" type="checkbox" ${checkedAttr ? 'checked' : ''} />
        <span class="auxo-checkbox-inner"></span>
      </span>
      <span>${labelText}</span>
    </label>
    <button class="ace-ui-btn account-center-action-button" type="submit">登录</button>
    <button class="other" type="button">重置密码</button>
  </form>
  <script>
    // 记录「点提交那一刻勾选框的状态」：站点就是这样判断有没有同意协议。
    // 记到 DOM 上（不是 window 变量）—— 代填脚本跑在 CDP 的独立执行上下文里，window 上的自定义属性看不到。
    document.querySelector('.account-center-action-button').addEventListener('click', function (ev) {
      ev.preventDefault();
      var cb = document.querySelector('input[type="checkbox"]');
      document.body.dataset.submittedAgree = cb ? String(cb.checked) : 'none';
      document.body.dataset.clicks = String((Number(document.body.dataset.clicks || '0')) + 1);
    });
  </script>
</body></html>`;
};

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function startPage(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  const pagePort = await listen(server);
  return { pageUrl: `http://127.0.0.1:${pagePort}/login`, close() { server.close(); } };
}

async function launchHeadless(basePort) {
  const port = await pickPort(basePort, []);
  const profileDir = path.join(os.tmpdir(), 'dsh-sa-test-v173-' + Math.random().toString(36).slice(2));
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
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* 留给系统清理 */ }
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
  const page = pages.find((p) => String(p.url || '').includes('/login')) || pages[0];
  return page.webSocketDebuggerUrl;
}

const CHECK_STATE = `JSON.stringify({
  agree: !!document.querySelector('input[type="checkbox"]') && document.querySelector('input[type="checkbox"]').checked,
  clicked: document.body.dataset.submittedAgree === undefined ? null : document.body.dataset.submittedAgree === 'true',
  clicks: Number(document.body.dataset.clicks || '0'),
  email: (document.querySelector('input[name="email"]') || {}).value || ''
})`;

const exe = resolveBrowserPath('');

if (!exe) {
  await test('（跳过）本机没装 Chrome/Edge，跑不了真实浏览器验证', () => {
    assert.ok(true);
  });
} else {
  await test('未勾选协议时：代填会主动勾上，并带着勾选状态提交', async () => {
    const p1 = await startPage(PAGE({ checkboxCls: 'auxo-checkbox-wrapper', labelText: '登录即代表同意 用户协议 和 隐私条款', checkedAttr: false }));
    const browser = await launchHeadless(9710);
    try {
      const ws = await openPage(browser, p1.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe@example.com', password: 'probe-pass', flow: A.LOGIN_FLOWS.douyin }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.agreeFound, true, '应该找到协议勾选框');
      assert.equal(v.agreeChecked, true, '应该把协议勾上');
      assert.equal(v.submitted, true, '应该点提交');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: CHECK_STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.agree, true, '页面上的勾选框应处于已勾选状态');
      assert.equal(st.clicked, true, '提交时勾选框应为已勾选');
    } finally {
      p1.close();
      await browser.close();
    }
  });

  await test('只有「记住我」这类勾选时：不会误勾', async () => {
    const p2 = await startPage(PAGE({ checkboxCls: 'remember-wrapper', labelText: '记住我', checkedAttr: false }));
    const browser = await launchHeadless(9720);
    try {
      const ws = await openPage(browser, p2.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe@example.com', password: 'probe-pass', flow: A.LOGIN_FLOWS.jd }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.agreeFound, false, '没有协议勾选框时不应勾选');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: CHECK_STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.agree, false, '「记住我」不能被勾上');
    } finally {
      p2.close();
      await browser.close();
    }
  });

  await test('协议已经勾上时：保持已勾选，不做多余的点击', async () => {
    const p3 = await startPage(PAGE({ checkboxCls: 'auxo-checkbox-wrapper', labelText: '登录即代表同意 用户协议 和 隐私条款', checkedAttr: true }));
    const browser = await launchHeadless(9730);
    try {
      const ws = await openPage(browser, p3.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe@example.com', password: 'probe-pass', flow: A.LOGIN_FLOWS.douyin }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.agreeChecked, true, '已勾选时结果应为已勾选');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: CHECK_STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.agree, true, '已勾选不应被取消');
    } finally {
      p3.close();
      await browser.close();
    }
  });
}

console.log('\n== C 版本与文档 ==');

await test('版本号与文档已覆盖 0.17.3', () => {
  const pkg = JSON.parse(readText('package.json'));
  const parts = String(pkg.version).split('.').map(Number);
  const [maj, min, patch] = parts;
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patch >= 3)), 'version 应 ≥0.17.3，实际 ' + pkg.version);
  assert.match(readText('CHANGELOG.md'), /0\.17\.3/, 'CHANGELOG 缺少 0.17.3');
  const readme = readText('README.md');
  assert.match(readme, /0\.17\.3/, 'README 缺少 0.17.3');
  assert.match(readme, /协议/, 'README 更新说明应提到协议勾选');
});

console.log(`\n${failures.length ? 'FAILED' : 'PASS'}  ${passed} 项通过${failures.length ? '，' + failures.length + ' 项失败' : ''}`);
if (failures.length) process.exitCode = 1;
