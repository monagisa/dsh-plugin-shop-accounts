#!/usr/bin/env node
/**
 * features-v0165.mjs —— v0.16.5：淘宝系登录页的跨域 iframe 代填
 *
 * 问题：淘宝（含天猫、1688）卖家登录页是**壳页面**，主 frame 只有一张欢迎图，
 * 真正的账号/密码输入框在跨域 iframe 里（`#alibaba-login-box` →
 * havanalogin.taobao.com/mini_login.htm）。原来的代填脚本只在主 frame 里
 * `document.querySelectorAll`，一定找不到输入框 —— 表现就是
 * 「点了自动登录，密码没填进去」，也不报错。
 *
 * 修法：填充/错误扫描都按 frame 优先级逐个试（`lib/frames.mjs` + `lib/cdp.mjs` 的
 * `evaluateInFrames`），ego 后端同样注入跨 frame 求值器。
 *
 * 本套三层验证：
 *   A. 纯函数：拍平 frame 树、候选顺序（有提示→子 frame 优先；无提示→主 frame 优先，老平台行为不变）
 *   B. 接线：登录流程带 frameHints（只有阿里系有）、chrome/ego 两条链路都走跨 frame
 *   C. 真实浏览器：headless Chrome 里起两个源（主页面 + 真跨域 iframe），
 *      验证「只查主 frame → 填不上」与「跨 frame → 填得上」的差别，以及红字在 iframe 里也能扫到
 *
 * 跑法：node test/features-v0165.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { flattenFrameTree, frameOrder, FRAME_EVAL_SOURCE } from '../lib/frames.mjs';
import { evaluateInFrames, evaluateOn, cdpCall, listPages, newPage, closePage } from '../lib/cdp.mjs';
import { LOGIN_FLOWS, loginFlowFor, buildFillExpression, buildErrorScanExpression } from '../lib/autologin.mjs';
import { resolveBrowserPath, pickPort, waitForCdp, waitPortGone } from '../lib/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  \u2713 ' + name); }
  catch (err) { failures.push({ name, err }); console.log('  \u2717 ' + name + '\n      ' + (err && err.message ? err.message : String(err))); }
}
const section = (t) => console.log('\n' + t);

// ── A. 纯函数：frame 树拍平与候选顺序 ───────────────────────────────────────
section('A. frame 树与候选顺序（纯函数）');

await test('flattenFrameTree 把嵌套结构拍平并记住深度', () => {
  const tree = {
    frame: { id: 'root', url: 'https://loginmyseller.taobao.com/?from=x', name: '' },
    childFrames: [
      {
        frame: { id: 'login', url: 'https://havanalogin.taobao.com/mini_login.htm?appEntrance=qianniu', name: 'alibaba-login-box' },
        childFrames: [{ frame: { id: 'deep', url: 'https://x.example/a', name: '' } }],
      },
    ],
  };
  const flat = flattenFrameTree(tree, [], 0);
  assert.equal(flat.length, 3);
  assert.deepEqual(flat.map((f) => f.id), ['root', 'login', 'deep']);
  assert.deepEqual(flat.map((f) => f.depth), [0, 1, 2]);
  assert.equal(flat[1].name, 'alibaba-login-box');
});

await test('有 frameHints 时：命中提示的子 frame 排在最前（不是壳页面本身）', () => {
  const frames = [
    { id: 'shell', url: 'https://loginmyseller.taobao.com/?from=taobaoindex', name: '', depth: 0 },
    { id: 'form', url: 'https://havanalogin.taobao.com/mini_login.htm?appEntrance=qianniu_pc_web', name: 'alibaba-login-box', depth: 1 },
  ];
  const order = frameOrder(frames, ['havanalogin.taobao.com', 'mini_login.htm']);
  assert.equal(order[0].id, 'form', '登录表单所在的 iframe 必须第一个试');
  assert.equal(order[1].id, 'shell');
});

await test('没有 frameHints 时：主 frame 排第一（拼多多/京东/抖店行为不变）', () => {
  const frames = [
    { id: 'main', url: 'https://mms.pinduoduo.com/login', name: '', depth: 0 },
    { id: 'ads', url: 'https://other.example/ad', name: '', depth: 1 },
  ];
  const order = frameOrder(frames, []);
  assert.equal(order[0].id, 'main');
});

await test('非 http(s) 的子 frame（about:blank/data:）不进兜底候选，避免白跑', () => {
  const frames = [
    { id: 'main', url: 'https://mms.pinduoduo.com/login', name: '', depth: 0 },
    { id: 'blank', url: 'about:blank', name: '', depth: 1 },
    { id: 'data', url: 'data:text/html,<p>x', name: '', depth: 1 },
  ];
  const order = frameOrder(frames, []);
  assert.equal(order.length, 1);
  assert.equal(order[0].id, 'main');
});

await test('重复 frame 不会出现两次；没有 id 的 frame 被丢掉', () => {
  const frames = [
    { id: 'a', url: 'https://havanalogin.taobao.com/x', name: '', depth: 1 },
    { id: 'a', url: 'https://havanalogin.taobao.com/x', name: '', depth: 1 },
    { id: '', url: 'https://havanalogin.taobao.com/y', name: '', depth: 1 },
    { id: 'main', url: 'https://loginmyseller.taobao.com/', name: '', depth: 0 },
  ];
  const order = frameOrder(frames, ['havanalogin.taobao.com']);
  assert.equal(order.length, 2);
  assert.deepEqual(order.map((f) => f.id), ['a', 'main']);
});

// ── B. 接线：只有阿里系带 frameHints，两条后端都走跨 frame ───────────────────
section('B. 登录流程与两条后端链路的接线');

await test('阿里系（淘宝/天猫/1688）三个平台都带 iframe 地址特征', () => {
  for (const p of ['taobao', 'tmall', 'ali1688']) {
    const flow = loginFlowFor(p, 'seller');
    assert.ok(flow, p + ' 应该有登录流程');
    assert.ok(Array.isArray(flow.frameHints) && flow.frameHints.length > 0, p + ' 缺 frameHints');
    assert.ok(flow.frameHints.includes('havanalogin.taobao.com'), p + ' 的 frameHints 要含登录 iframe 的域名');
    assert.ok(flow.frameHints.includes('mini_login.htm'), p + ' 的 frameHints 要含登录 iframe 的路径特征');
  }
});

await test('表单在主 frame 的平台不带 frameHints（不会被 iframe 候选带偏）', () => {
  for (const p of ['pdd', 'jd', 'douyin']) {
    const flow = loginFlowFor(p, 'seller');
    assert.ok(flow, p + ' 应该有登录流程');
    assert.equal(flow.frameHints, undefined, p + ' 不该有 frameHints');
  }
});

await test('chrome 后端用 evaluateInFrames 填表，并把所在 frame 返回出去', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/autologin.mjs'), 'utf8');
  assert.match(src, /evaluateInFrames\(/);
  assert.match(src, /frameHints/, 'chrome 链路要把 frameHints 传下去');
  assert.match(src, /filledFrame/, '返回值要带 filledFrame，便于排查"填到哪个 frame"');
  assert.equal(/evaluateOn\(target\.webSocketDebuggerUrl, expr/.test(src), false, '填表不该再用只查主 frame 的 evaluateOn');
});

await test('ego 后端把 frameHints 传进运行时脚本', () => {
  const auto = fs.readFileSync(path.join(ROOT, 'lib/autologin.mjs'), 'utf8');
  assert.match(auto, /egoAutofill\(account, \{[^}]*frameHints/s);
  const ego = fs.readFileSync(path.join(ROOT, 'lib/ego.mjs'), 'utf8');
  assert.match(ego, /frameHints: Array\.isArray\(frameHints\)/);
  assert.match(ego, /\$\{FRAME_EVAL_SOURCE\}/, 'ego 运行时脚本要注入跨 frame 求值器');
  assert.match(ego, /__dshEvalInFrames\(page, String\(P\.fillExpr/, 'ego 侧填表要走跨 frame');
});

await test('ego 侧跨 frame 求值器与 Node 侧同源（同一段源码）', () => {
  assert.match(FRAME_EVAL_SOURCE, /Page\.getFrameTree/);
  assert.match(FRAME_EVAL_SOURCE, /Page\.createIsolatedWorld/);
  assert.match(FRAME_EVAL_SOURCE, /Runtime\.evaluate/);
  assert.match(FRAME_EVAL_SOURCE, /contextId/);
  const ego = fs.readFileSync(path.join(ROOT, 'lib/ego.mjs'), 'utf8');
  assert.ok(ego.includes('FRAME_EVAL_SOURCE'), 'ego.mjs 必须引用同一份源码，不能在两边各写一份');
});

await test('填不上时必须明确报「没找到输入框」，不能悄悄变成"要人工登录"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/autologin.mjs'), 'utf8');
  assert.match(src, /页面里没找到「登录账号\/密码」输入框/);
  assert.equal((src.match(/AUTOLOGIN_FILL_FAILED/g) || []).length >= 3, true, 'chrome/ego 两条链路都要能返回 FILL_FAILED');
});

// ── C. 真实浏览器：跨域 iframe 里到底能不能填上 ──────────────────────────────
section('C. 真实浏览器：壳页面 + 跨域 iframe 里的代填');

const exe = resolveBrowserPath('');

const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>login</title></head>
<body>
  <input id="fm-login-id" name="fm-login-id" placeholder="账号" />
  <input id="fm-login-password" name="fm-login-password" type="password" placeholder="密码" />
  <div class="login-error" style="display:none">账号或密码不正确</div>
  <button class="fm-button" type="button">登录</button>
  <script>
    // 站点用受控输入（React 风格）：记录 input/change 事件是否真的到过
    window.__events = 0;
    document.getElementById('fm-login-id').addEventListener('input', function () { window.__events += 1; });
  </script>
</body></html>`;

const SHELL_HTML = (frameUrl) => `<!doctype html><html><head><meta charset="utf-8"><title>千牛工作台 - 商家一站式经营阵地</title></head>
<body style="margin:0">
  <div>欢迎来到千牛</div>
  <iframe id="alibaba-login-box" name="alibaba-login-box" src="${frameUrl}" width="456" height="603" style="border:0"></iframe>
</body></html>`;

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

async function startServers() {
  const formServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FORM_HTML);
  });
  const formPort = await listen(formServer);
  // 真淘宝是「同站不同子域」（loginmyseller.taobao.com 套 havanalogin.taobao.com），
  // 同站 = 同进程，所以子 frame 会出现在 Page.getFrameTree 里。
  // 这里用「同站不同端口」（都是 127.0.0.1）复刻同样的事实：不同源、但同进程。
  const shellServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SHELL_HTML(`http://127.0.0.1:${formPort}/mini_login.htm?appEntrance=qianniu_pc_web`));
  });
  const shellPort = await listen(shellServer);
  return {
    shellUrl: `http://127.0.0.1:${shellPort}/`,
    formUrl: `http://127.0.0.1:${formPort}/mini_login.htm?appEntrance=qianniu_pc_web`,
    shellPort,
    close() { formServer.close(); shellServer.close(); },
  };
}

async function launchHeadless() {
  const port = await pickPort(9500, []);
  const profileDir = path.join(os.tmpdir(), 'dsh-sa-test-iframe-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
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

if (!exe) {
  await test('（跳过）本机没装 Chrome/Edge，跑不了真实浏览器验证', () => {
    assert.ok(true);
  });
} else {
  const servers = await startServers();
  const browser = await launchHeadless();
  try {
    // 打开壳页面（带跨域 iframe），等 iframe 里的表单加载完
    const pages0 = await listPages(browser.port);
    const blank = pages0[0];
    assert.ok(blank && blank.webSocketDebuggerUrl, '拿不到 about:blank 的调试地址');
    await evaluateOn(blank.webSocketDebuggerUrl, `location.href = ${JSON.stringify(servers.shellUrl)}; 'go'`, 5000, browser.port);
    await new Promise((r) => setTimeout(r, 1200));
    const pages = await listPages(browser.port);
    const page = pages.find((p) => String(p.url || '').startsWith('http://127.0.0.1:')) || pages[0];
    const ws = page.webSocketDebuggerUrl;

    await test('前置：主 frame 里确实找不到账号/密码输入框（这就是原来填不上的原因）', async () => {
      const mainOnly = await evaluateOn(ws, `(() => ({
        inputs: document.querySelectorAll('input').length,
        frames: document.querySelectorAll('iframe').length,
        title: document.title,
      }))()`, 5000, browser.port);
      assert.equal(mainOnly.inputs, 0, '壳页面主 frame 不该有输入框');
      assert.equal(mainOnly.frames, 1, '壳页面应该有一个登录 iframe');
      assert.match(mainOnly.title, /千牛/, '主页面标题应是千牛工作台');
      const oldWay = await evaluateOn(ws, buildFillExpression({ username: 'u1', password: 'p1', flow: LOGIN_FLOWS.taobao }), 8000, browser.port);
      assert.equal(oldWay.userFilled, false, '只查主 frame 必然填不上（旧实现的问题）');
      assert.equal(oldWay.passFilled, false);
    });

    await test('跨 frame 求值：账号密码填进了登录 iframe，并报回所在 frame', async () => {
      const res = await evaluateInFrames(ws, {
        expression: buildFillExpression({ username: 'demo-user', password: 'demo-pass', flow: LOGIN_FLOWS.taobao }),
        frameHints: LOGIN_FLOWS.taobao.frameHints,
        expectedPort: browser.port,
        timeoutMs: 8000,
      });
      assert.equal(res.ok, true, '应该在某个 frame 里填成功：' + JSON.stringify(res.tried));
      assert.equal(res.value.userFilled, true);
      assert.equal(res.value.passFilled, true);
      assert.match(String(res.frameUrl), /127\.0\.0\.1/, '填进去的 frame 应该是登录 iframe');
      assert.ok(res.depth >= 1, '应该是子 frame（depth>=1）');
      assert.match(String(res.frameUrl), /mini_login\.htm/, '应该是登录表单所在的 iframe');
    });

    await test('填进去的值是真的落在 iframe 的 DOM 上（隔离世界只共享 DOM，值是页面真值）', async () => {
      // 在隔离世界里填的值，从**页面主世界**再读一遍：DOM 是两个世界共享的，
      // 所以站点自己的脚本（受控输入、表单校验）能看到这些值。
      const read = await evaluateInFrames(ws, {
        expression: `(() => {
          const u = document.getElementById('fm-login-id');
          const p = document.getElementById('fm-login-password');
          return { user: u ? u.value : null, pass: p ? p.value : null };
        })()`,
        frameHints: LOGIN_FLOWS.taobao.frameHints,
        expectedPort: browser.port,
        satisfy: (v) => Boolean(v && v.user),
      });
      assert.equal(read.ok, true);
      assert.equal(read.value.user, 'demo-user');
      assert.equal(read.value.pass, 'demo-pass');

      const mainWorld = await cdpCall(ws, 'Page.getFrameTree', {}, 5000, browser.port).catch(() => null);
      const child = frameOrder(flattenFrameTree(mainWorld && mainWorld.frameTree, [], 0), LOGIN_FLOWS.taobao.frameHints)[0];
      assert.ok(child && child.depth === 1, '应该已经定位到登录 iframe');
      const w = await cdpCall(ws, 'Page.createIsolatedWorld', { frameId: child.id, worldName: 'dsh-sa-verify', grantUniversalAccess: false }, 5000, browser.port);
      const inWorld = await cdpCall(ws, 'Runtime.evaluate', {
        expression: `[document.getElementById('fm-login-id').value, document.getElementById('fm-login-password').value].join('|')`,
        returnByValue: true,
        contextId: w && w.executionContextId,
      }, 5000, browser.port);
      assert.equal(inWorld && inWorld.result && inWorld.result.value, 'demo-user|demo-pass', 'iframe 里的 DOM 真的被写上了');
    });

    await test('登录失败的红字在 iframe 里也能扫到（密码错才不会误报成"要验证码"）', async () => {
      const scan = await evaluateInFrames(ws, {
        expression: `(() => {
          const el = document.querySelector('.login-error');
          if (el) el.style.display = 'block';
          return { ok: true, hints: [String((el && el.textContent) || '')], body: String((document.body && document.body.innerText) || '') };
        })()`,
        frameHints: LOGIN_FLOWS.taobao.frameHints,
        expectedPort: browser.port,
        satisfy: () => true,
      });
      assert.equal(scan.ok, true);
      assert.match(String(scan.value.hints.join(' ')), /账号或密码不正确/, '红字必须从登录 iframe 里扫出来');
    });

    await test('没有 frameHints 时仍先查主 frame（老平台不受影响）', async () => {
      const res = await evaluateInFrames(ws, {
        expression: buildErrorScanExpression(),
        frameHints: [],
        expectedPort: browser.port,
        satisfy: () => true,
      });
      assert.equal(res.ok, true);
      assert.equal(res.depth, 0, '无提示时应先查主 frame');
      assert.match(String(res.frameUrl), /127\.0\.0\.1/, '没提示就查主 frame');
    });

    await test('跨站 iframe（被站点隔离成 OOPIF）不在 frame 树里时：明确失败并列出试过的 frame', async () => {
      // localhost 与 127.0.0.1 是不同**站点** → Chrome 会把 iframe 拆成独立进程（OOPIF），
      // 它不出现在父页面的 Page.getFrameTree 里。这种页面上填不进去，但必须如实报错
      // （列出试过哪些 frame），不能假装成功、也不能悄悄变成"要人工登录"。
      const other = await newPage(browser.port, `http://localhost:${servers.shellPort}/`);
      assert.ok(other && other.webSocketDebuggerUrl, '没能打开跨站壳页面');
      await new Promise((r) => setTimeout(r, 1200));
      const res = await evaluateInFrames(other.webSocketDebuggerUrl, {
        expression: buildFillExpression({ username: 'u', password: 'p', flow: LOGIN_FLOWS.taobao }),
        frameHints: LOGIN_FLOWS.taobao.frameHints,
        expectedPort: browser.port,
        timeoutMs: 8000,
      });
      assert.equal(res.ok, false, '跨站 iframe 摸不到，必须如实返回失败');
      assert.ok(Array.isArray(res.tried) && res.tried.length >= 1, '要把试过的 frame 列出来');
      assert.equal(res.value.userFilled, false);
      await closePage(browser.port, other.id).catch(() => {});
    });
  } finally {
    servers.close();
    await browser.close();
  }
}

// ── D. 文档/版本 ────────────────────────────────────────────────────────────
section('D. 版本与文档');

await test('package.json 已是 0.16.5 起，README/CHANGELOG 记了这一版', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const parts = String(pkg.version).split('.').map(Number);
  assert.equal(parts[0], 0);
  assert.ok(parts[2] >= 5 || parts[1] > 16, '版本应 >= 0.16.5，实际 ' + pkg.version);
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /0\.16\.5/);
  assert.match(changelog, /iframe/);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /0\.16\.5/);
  assert.match(readme, /iframe/, 'README 要说明淘宝系登录在 iframe 里');
});

console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' 项' : '\u2713 全部通过') + '：' + passed + ' 项');
if (failures.length) {
  for (const f of failures) console.log('  · ' + f.name + ' → ' + (f.err && f.err.message ? f.err.message : String(f.err)));
  process.exit(1);
}
