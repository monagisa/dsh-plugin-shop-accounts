#!/usr/bin/env node
/**
 * features-v0175.mjs —— v0.17.5：代填的「点登录」不再只有一招
 *
 * 背景：用户反馈「有时候不会自己点登录」。实测/代码复核后确认有四种情况：
 *   ① 提交按钮当时是 disabled（等输入校验、等防抖、等协议），click 打上去不生效；
 *   ② 提交按钮不是 button，是 div/a；
 *   ③ 站点只在表单的 submit 事件里做提交，点按钮不触发；
 *   ④ 按钮选择器与站点改版后的类名不再匹配。
 * 旧逻辑只做「按选择器找按钮 → 点一下」（找不到才退回车），所以上面四种都会表现为「没点登录」。
 *
 * 本套验证新逻辑按顺序尝试：选择器按钮 → 按文字找可点元素 → form.requestSubmit → 回车，
 * 并把最终用的是哪一种记在 submittedBy 里（同时记 submitDisabled，便于失败时说清原因）。
 *
 * 跑法：node test/features-v0175.mjs （B 段启动无头 Chrome，纯本地页面，不联网）
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

const FLOW = {
  user: ['#u'],
  pass: ['#p'],
  submit: ['.no-such-button'],   // 故意写一个页面上不存在的选择器，逼它走兜底
};

console.log('\n== A 提交逻辑的兜底顺序 ==');

await test('填充脚本记录了「用什么方式点的」和「按钮当时是否禁用」', () => {
  const expr = A.buildFillExpression({ username: 'u', password: 'p', flow: FLOW });
  assert.match(expr, /submittedBy: ''/, '应初始化 submittedBy');
  assert.match(expr, /submitDisabled: false/, '应初始化 submitDisabled');
  assert.match(expr, /clickIt\(pick\(S\.flow\.submit, null\), 'button'\)/, '选择器命中时记为 button');
  assert.match(expr, /clickIt\(hit, 'text'\)/, '按文字点时记为 text');
  assert.match(expr, /out\.submittedBy = 'requestSubmit'/, '表单提交时记为 requestSubmit');
  assert.match(expr, /out\.submittedBy = 'enter'/, '回车时记为 enter');
});

await test('点按钮前会先让密码框失焦，逼站点的校验先跑完', () => {
  const expr = A.buildFillExpression({ username: 'u', password: 'p', flow: FLOW });
  assert.match(expr, /new Event\('blur'/, '应先派发 blur');
});

await test('两个后端都把 submittedBy / submitDisabled 透出', () => {
  const src = readText('lib/autologin.mjs');
  const hits = (src.match(/submittedBy: String\(filled\.submittedBy \|\| ''\)/g) || []).length;
  assert.ok(hits >= 2, 'chrome 与 ego 两条链路都要透出 submittedBy，实际出现 ' + hits + ' 次');
  assert.ok((src.match(/submitDisabled: Boolean\(filled\.submitDisabled\)/g) || []).length >= 2, '两条链路都要透出 submitDisabled');
});

console.log('\n== B 真实浏览器：三种「点不动」的页面都能提交 ==');

const page = (extra) => `<!doctype html><html><head><meta charset="utf-8"><title>登录</title>
<style>input,button,div.btn{display:block;width:200px;height:30px;margin:6px}</style></head>
<body>
  <form id="f">
    <input id="u" type="text" placeholder="账号" />
    <input id="p" type="password" placeholder="密码" />
    ${extra}
  </form>
  <script>
    var f = document.querySelector('#f');
    var p = document.querySelector('#p');
    var btn = document.querySelector('#b');
    // 站点常见做法：表单真正提交时才记录
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      document.body.dataset.submitted = '1';
    });
    // 场景一：密码框失焦后才把按钮变成可点
    if (btn && btn.dataset.enableOnBlur === '1') {
      p.addEventListener('blur', function () { btn.disabled = false; });
    }
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
  const profileDir = path.join(os.tmpdir(), 'dsh-sa-test-v175-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(profileDir, { recursive: true });
  const exe = resolveBrowserPath('');
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
  const hit = pages.find((p) => String(p.url || '').includes('/login')) || pages[0];
  return hit.webSocketDebuggerUrl;
}

const STATE = `JSON.stringify({
  submitted: document.body.dataset.submitted === '1',
  user: (document.querySelector('#u') || {}).value || '',
  pass: (document.querySelector('#p') || {}).value || ''
})`;

const exe = resolveBrowserPath('');

if (!exe) {
  await test('（跳过）本机没装 Chrome/Edge，跑不了真实浏览器验证', () => {
    assert.ok(true);
  });
} else {
  await test('按钮一开始是 disabled：先失焦让它变可点，再点（submittedBy=button）', async () => {
    const p1 = await startPage(page('<button id="b" type="submit" data-enable-on-blur="1" disabled>登录</button>'));
    const browser = await launchHeadless(9770);
    try {
      const ws = await openPage(browser, p1.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe-user', password: 'probe-pass', flow: FLOW }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.userFilled, true, '应填上账号');
      assert.equal(v.passFilled, true, '应填上密码');
      assert.equal(v.submitted, true, '应完成提交');
      assert.notEqual(String(v.submittedBy || ''), '', '应记录提交方式');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.submitted, true, '页面的 form submit 应真的被触发（不是假点）');
    } finally {
      p1.close();
      await browser.close();
    }
  });

  await test('提交控件是 div 文字「立即登录」：按文字点到它（submittedBy=text）', async () => {
    const p2 = await startPage(page('<div class="btn" id="t">立即登录</div>\n  <script>document.querySelector("#t").addEventListener("click", function(){ document.body.dataset.submitted = "1"; });</script>'));
    const browser = await launchHeadless(9776);
    try {
      const ws = await openPage(browser, p2.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe-user', password: 'probe-pass', flow: FLOW }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.submitted, true, '应有提交动作');
      assert.equal(v.submittedBy, 'text', '应走「按文字点」这条路');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.submitted, true, 'div 的点击处理应真的被触发');
    } finally {
      p2.close();
      await browser.close();
    }
  });

  await test('页面完全没有提交控件：走表单 requestSubmit（submittedBy=requestSubmit）', async () => {
    const p3 = await startPage(page(''));
    const browser = await launchHeadless(9782);
    try {
      const ws = await openPage(browser, p3.pageUrl);
      const fill = await evaluateInFrames(ws, {
        expression: A.buildFillExpression({ username: 'probe-user', password: 'probe-pass', flow: FLOW }),
        expectedPort: browser.port, satisfy: (v) => Boolean(v && v.submitted),
      });
      const v = fill.value || {};
      assert.equal(v.submitted, true, '应有提交动作');
      assert.equal(v.submittedBy, 'requestSubmit', '没有按钮时应走表单 requestSubmit');
      const st = JSON.parse((await evaluateInFrames(ws, { expression: STATE, expectedPort: browser.port, satisfy: () => true })).value);
      assert.equal(st.submitted, true, 'form 的 submit 事件应真的被触发');
    } finally {
      p3.close();
      await browser.close();
    }
  });
}

console.log('\n== C 版本与文档 ==');

await test('版本号与文档已覆盖 0.17.5', () => {
  const pkg = JSON.parse(readText('package.json'));
  const [maj, min, patch] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patch >= 5)), 'version 应 ≥0.17.5，实际 ' + pkg.version);
  assert.match(readText('CHANGELOG.md'), /0\.17\.5/, 'CHANGELOG 缺少 0.17.5');
  assert.match(readText('README.md'), /0\.17\.5/, 'README 缺少 0.17.5');
});

console.log(`\n${failures.length ? 'FAILED' : 'PASS'}  ${passed} 项通过${failures.length ? '，' + failures.length + ' 项失败' : ''}`);
if (failures.length) process.exitCode = 1;
