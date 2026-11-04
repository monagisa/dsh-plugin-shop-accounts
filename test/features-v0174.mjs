#!/usr/bin/env node
/**
 * features-v0174.mjs —— v0.17.4：天猫买家改从淘宝登录页进 + 通用协议勾选在淘宝页生效
 *
 * 背景：v0.17.3 补了「代填时勾选同意协议」。为了确认别的平台是否也有同样的坑，
 * 2026-11-04 把六个平台的登录页都真机抓了一遍（headless Chrome，结果见 CHANGELOG）：
 *
 *   · 淘宝买家 login.taobao.com：有「已阅读并同意以下协议」勾选框（默认不勾）→ 与抖店同款问题，
 *     由通用按文案识别覆盖（本套 A/B 段验它真的会被勾上）；
 *   · 淘宝卖家（表单在 iframe 内）、京东买卖家、拼多多、1688：没有协议勾选；
 *   · 天猫买家 login.tmall.com：壳页面 + **跨站** iframe（login.tmall.com → login.taobao.com），
 *     跨站 iframe 不在 CDP frame 树里，代填摸不到输入框 → 本版把入口改到淘宝登录页。
 *
 * 跑法：node test/features-v0174.mjs （B 段会启动无头 Chrome，纯本地页面，不联网）
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

const P = await import(url('lib/platforms.mjs'));
const A = await import(url('lib/autologin.mjs'));
const { resolveBrowserPath, pickPort, waitForCdp, waitPortGone } = await import(url('lib/chrome.mjs'));
const { evaluateInFrames, listPages } = await import(url('lib/cdp.mjs'));

console.log('\n== A 天猫买家入口 ==');

await test('天猫买家的登录入口是淘宝登录页，不再从 login.tmall.com 进去', () => {
  const v = P.variantOf(P.platformOf('tmall'), 'buyer');
  assert.equal(v.loginUrl, 'https://login.taobao.com/havanaone/login/login.htm', '天猫买家入口应改为淘宝登录页');
  assert.ok(!String(v.loginUrl).includes('login.tmall.com'), '不应再指向跨站 iframe 的壳页面');
  assert.match(v.accountHint, /淘宝登录页/, '提示里应说明走淘宝登录页');
});

await test('天猫买家沿用淘宝那套登录态判据（cookie 落在 taobao.com）', () => {
  const v = P.variantOf(P.platformOf('tmall'), 'buyer');
  assert.ok(v.cookieDomains.includes('taobao.com'), '需要认 taobao.com 域上的 cookie');
  for (const name of ['cookie2', 'unb', '_tb_token_', 'sgcookie']) {
    assert.ok(v.sessionCookies.includes(name), '缺少登录态 cookie：' + name);
  }
});

await test('买家入口与卖家入口不混用（天猫卖家仍是千牛登录页）', () => {
  const seller = P.variantOf(P.platformOf('tmall'), 'seller');
  const buyer = P.variantOf(P.platformOf('tmall'), 'buyer');
  assert.notEqual(seller.loginUrl, buyer.loginUrl, '卖家与买家入口不应相同');
  assert.match(seller.loginUrl, /loginmyseller\.taobao\.com/, '天猫卖家应走千牛登录页');
});

console.log('\n== B 通用协议勾选：淘宝登录页同款结构 ==');

const PAGE = (withAgree) => `<!doctype html><html><head><meta charset="utf-8"><title>淘宝登录</title></head>
<body>
  <div class="login-blocks">
    <input id="fm-login-id" name="fm-login-id" type="text" placeholder="账号名/邮箱/手机号" />
    <input id="fm-login-password" name="fm-login-password" type="password" placeholder="请输入登录密码" />
    ${withAgree ? '<div class="fm-agreement"><label><input id="fm-agreement-checkbox" name="fm-agreement-checkbox" type="checkbox" /><span>* 已阅读并同意以下协议淘宝平台服务协议、隐私权政策</span></label></div>' : ''}
    <button class="fm-button fm-submit password-login" type="submit">登录</button>
  </div>
  <script>
    document.querySelector('.fm-submit').addEventListener('click', function (ev) {
      ev.preventDefault();
      var cb = document.querySelector('input[type="checkbox"]');
      document.body.dataset.submitAgree = cb ? String(cb.checked) : 'none';
    });
  </script>
</body></html>`;

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
  const profileDir = path.join(os.tmpdir(), 'dsh-sa-test-v174-' + Math.random().toString(36).slice(2));
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

const STATE = `JSON.stringify({
  hasAgreeBox: !!document.querySelector('input[type="checkbox"]'),
  agree: !!document.querySelector('input[type="checkbox"]') && document.querySelector('input[type="checkbox"]').checked,
  submitAgreeRaw: document.body.dataset.submitAgree === undefined ? '<未提交>' : document.body.dataset.submitAgree,
  user: (document.querySelector('#fm-login-id') || {}).value || ''
})`;

const exe = resolveBrowserPath('');

if (!exe) {
  await test('（跳过）本机没装 Chrome/Edge，跑不了真实浏览器验证', () => {
    assert.ok(true);
  });
} else {
  await test('淘宝流程没有写死协议选择器，但能按文案把「已阅读并同意」勾上', async () => {
    const p1 = await startPage(PAGE(true));
    const browser = await launchHeadless(9740);
    try {
      const ws = await openPage(browser, p1.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe-user', password: 'probe-pass', flow: A.LOGIN_FLOWS.taobao }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.userFilled, true, '应填上账号');
      assert.equal(v.agreeFound, true, '应识别到协议勾选框');
      assert.equal(v.agreeChecked, true, '应把协议勾上');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.agree, true, '页面上勾选框应为已勾选');
      assert.equal(st.submitAgreeRaw, 'true', '提交那一刻勾选框应为已勾选');
    } finally {
      p1.close();
      await browser.close();
    }
  });

  await test('淘宝页没有协议勾选时：不发多余点击', async () => {
    const p2 = await startPage(PAGE(false));
    const browser = await launchHeadless(9750);
    try {
      const ws = await openPage(browser, p2.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe-user', password: 'probe-pass', flow: A.LOGIN_FLOWS.taobao }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.agreeFound, false, '没有协议勾选框时不应勾选');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.hasAgreeBox, false, '这个页面上不应有协议勾选框');
      assert.equal(st.agree, false, '不应有任何勾选状态');
      assert.equal(st.submitAgreeRaw, 'none', '提交时不应出现勾选动作（页面记录为 none）');
    } finally {
      p2.close();
      await browser.close();
    }
  });
}

console.log('\n== C 版本与文档 ==');

await test('版本号与文档已覆盖 0.17.4', () => {
  const pkg = JSON.parse(readText('package.json'));
  const [maj, min, patch] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patch >= 4)), 'version 应 ≥0.17.4，实际 ' + pkg.version);
  assert.match(readText('CHANGELOG.md'), /0\.17\.4/, 'CHANGELOG 缺少 0.17.4');
  assert.match(readText('README.md'), /0\.17\.4/, 'README 缺少 0.17.4');
});

console.log(`\n${failures.length ? 'FAILED' : 'PASS'}  ${passed} 项通过${failures.length ? '，' + failures.length + ' 项失败' : ''}`);
if (failures.length) process.exitCode = 1;
