#!/usr/bin/env node
/**
 * 真机链路探针（不进 smoke，因为它会真的拉起一个浏览器）：
 *   在**临时档案**里用无头 Chrome 跑一遍「启动 → 调试端口起来 → 读 cookie → Browser.close 关掉」，
 *   证明 lib/chrome.mjs + lib/cdp.mjs 在这台机器上真的能跑通。不碰任何店铺档案，不弹窗口。
 *
 *   node test/live-probe.mjs            只验证链路（不联网）
 *   node test/live-probe.mjs taobao     额外打开淘宝登录页，验证判据不会把空档案误判成"已登录"
 *   node test/live-probe.mjs all        三个平台都过一遍
 *
 * 注意：只有「读 cookie」这一条路能看到 HttpOnly（document.cookie 看不到），
 * 所以探针里断言的是 Network.getAllCookies 返回数组，而不是页面里的 document.cookie。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveBrowserPath,
  pickPort,
  launchBrowser,
  waitForCdp,
  killChromeForProfile,
  waitPortGone,
} from '../lib/chrome.mjs';
import { browserUp, browserInfo, listPages, newPage, getAllCookies, closeBrowser } from '../lib/cdp.mjs';
import { settlePage } from '../lib/index.js';
import { PLATFORMS, platformOf, judgeLogin } from '../lib/platforms.mjs';

const arg = (process.argv[2] || '').trim();
const wanted = arg === 'all' ? PLATFORMS.map((p) => p.id) : arg ? [arg] : [];

const fails = [];
function check(ok, label, detail) {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails.push(label);
}

const exe = resolveBrowserPath('');
check(Boolean(exe), '找到浏览器 exe', exe || '没找到 chrome.exe / msedge.exe');
if (!exe) process.exit(1);

const port = await pickPort(9222, []);
check(Boolean(port), '选到空闲调试端口', String(port));

const dir = mkdtempSync(join(tmpdir(), 'shop-accounts-probe-'));
let launched = false;
try {
  launchBrowser({ exe, profileDir: dir, port, urls: ['about:blank'], headless: true });
  launched = true;

  const up = await waitForCdp(port, 20000);
  check(up, '调试端口起来了', `127.0.0.1:${port}`);

  if (up) {
    const info = await browserInfo(port);
    check(Boolean(info && info.ok), 'CDP /json/version 有响应', info && info.browser ? info.browser : '无响应');

    const pages = await listPages(port);
    check(pages.length > 0, '能看到页面目标', pages.map((p) => `${p.type}:${p.url}`).join(', '));

    const ck = await getAllCookies(port);
    check(
      Boolean(ck && Array.isArray(ck.cookies)),
      'Network.getAllCookies 可读（HttpOnly 的唯一正路）',
      ck ? `${ck.cookies.length} 个 cookie` : '返回 null',
    );

    for (const id of wanted) {
      const platform = platformOf(id);
      check(Boolean(platform), `认识的平台 id：${id}`, PLATFORMS.map((p) => p.id).join(' / '));
      if (!platform) continue;

      const created = await newPage(port, platform.loginUrl);
      check(Boolean(created), `新开登录页标签：${platform.label}`, platform.loginUrl);
      await new Promise((r) => setTimeout(r, 8000));

      const after = await getAllCookies(port);
      const verdict = judgeLogin(after ? after.cookies : null, (after && after.url) || platform.loginUrl, platform);
      // 空档案 + 停在登录页 ⇒ 必须是「未登录」，否则上架流程会以为能直接用而扑空
      check(verdict.loggedIn === false, `空档案登录页不误判成"已登录"：${platform.label}`, JSON.stringify(verdict));
    }

    // ── 回归：迟到一跳不能被当成"已稳" ──────────────────────────────────────
    // v0.3.0 的「不打开窗口就检测不出登录掉了」就是栽在这：无头检测一看到平台域名就判稳，
    // 而工作台页往往在 readyState=complete 之后才把用户甩到登录页（实测 PDD 隔了 255ms）。
    // 这里用本地页复现同一时序：先 200 一个"工作台"，400ms 后 JS 跳到 /login。
    const server = createServer((req, res) => {
      if (String(req.url || '/').startsWith('/login')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>login</title>登录页');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>workbench</title><script>setTimeout(function () { location.replace("/login"); }, 400);</script>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const tab = await newPage(port, origin + '/');
      check(Boolean(tab), '慢跳转：开标签页', origin + '/');
      const settled = await settlePage(port, { cookieDomains: ['127.0.0.1'] }, 12000);
      check(
        /\/login\/?$/.test(settled.url),
        '慢跳转：settlePage 等到最终登录页，而不是一看到域名就返回',
        `${settled.url}（等了 ${settled.waitedMs}ms，readyState=${settled.readyState}）`,
      );
      check(settled.waitedMs >= 1000, '慢跳转：确实等过了 quiet 期', `${settled.waitedMs}ms`);
    } finally {
      try { server.closeAllConnections?.(); } catch { /* 老版本 node 没有 */ }
      await new Promise((r) => server.close(() => r()));
    }
  }
} finally {
  if (launched) {
    if (await browserUp(port, 800)) await closeBrowser(port);
    if (!(await waitPortGone(port, 6000))) killChromeForProfile(dir);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 档案还被占用就算了，反正它在 temp 里 */
  }
}

console.log(fails.length ? `\n✗ 失败 ${fails.length} 项：${fails.join('、')}` : '\n✓ 真机链路探针通过');
process.exitCode = fails.length ? 1 : 0;
