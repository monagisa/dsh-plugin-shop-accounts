#!/usr/bin/env node
/**
 * smoke.mjs —— 本插件的自检。零依赖、可重复跑：`node test/smoke.mjs`
 *
 * 四块：
 *   1. 平台判据（platforms.mjs）—— 登录态认不认得出、会不会把空档案判成已登录；
 *   2. 持久化（store.mjs）—— 原子写 + 坏文件降级 + 档案目录命名；
 *   3. 宿主 HTTP 面（lib/index.js）—— 直接用假 webServer/假 req/res 打真实路由；
 *   4. 客户端 bundle 契约（lib/client.js）—— 在 node:vm 里用桩 React/桩 slots 跑一遍，
 *      验证 `__ModuleLoader__.load` 的注册形状、exports 三件套、以及 settings.section 的注册参数。
 *
 * **刻意不碰浏览器**：本脚本绝不启动 Chrome（那是用户点「打开」时才该发生的事）。
 * 所有数据都落在临时目录（DSH_SHOP_ACCOUNTS_DIR），不碰用户真实的账号表。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-smoke-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');

const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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

// ── 1. 平台判据 ──────────────────────────────────────────────────────────────

section('1. 平台判据 lib/platforms.mjs');
const P = await import(url('lib/platforms.mjs'));

await test('六个平台都在（都是商家端），且都有登录页/主页/工作页/判据', () => {
  const ids = P.PLATFORMS.map((p) => p.id);
  assert.deepEqual(ids.slice().sort(), ['ali1688', 'douyin', 'jd', 'pdd', 'taobao', 'tmall']);
  for (const p of P.PLATFORMS) {
    assert.match(p.loginUrl, /^https:\/\//, p.id + '.loginUrl 必须是 https');
    assert.match(p.homeUrl, /^https:\/\//, p.id + '.homeUrl 必须是 https');
    assert.ok(p.workUrl, p.id + '.workUrl 缺失');
    assert.ok(p.sessionCookies.length >= 1, p.id + ' 没有身份 cookie 判据');
    assert.ok(p.cookieDomains.length >= 1, p.id + ' 没有 cookie 域');
    // 身份 cookie 必须也在 sessionCookies 里，否则永远凑不够 minCookieHits
    for (const n of p.identityCookies || []) {
      assert.ok(p.sessionCookies.includes(n), p.id + ' 的 identityCookie ' + n + ' 不在 sessionCookies 里');
    }
  }
});

await test('platformOf / platformList', () => {
  assert.equal(P.platformOf('pdd').label, '拼多多');
  assert.equal(P.platformOf('nope'), null);
  assert.equal(P.platformList().length, 6);
});

await test('域名后缀匹配按「.域结尾」算，不认前缀冒充', () => {
  assert.equal(P.domainMatches('.pinduoduo.com', ['pinduoduo.com']), true);
  assert.equal(P.domainMatches('mms.pinduoduo.com', ['pinduoduo.com']), true);
  assert.equal(P.domainMatches('evil-pinduoduo.com', ['pinduoduo.com']), false);
  assert.equal(P.domainMatches('.taobao.com', ['pinduoduo.com']), false);
});

await test('匿名 cookie 兜不住登录态（这是最容易搞错的一步）', () => {
  const p = P.platformOf('pdd');
  const anon = [
    { name: 'cna', domain: '.pinduoduo.com', value: 'x' },
    { name: '_m_h5_tk', domain: '.pinduoduo.com', value: 'x' },
    { name: 'webp', domain: '.pinduoduo.com', value: 'x' },
  ];
  const v = P.judgeLogin(anon, p.homeUrl, p);
  assert.equal(v.loggedIn, false, '只有匿名 cookie 时必须判未登录');
});

await test('身份 cookie + 正确域 + 已登录页面 → 判已登录；占位值不算凭证', () => {
  const p = P.platformOf('pdd');
  const dom = p.cookieDomains[0].startsWith('.') ? p.cookieDomains[0] : '.' + p.cookieDomains[0];
  const cookies = p.sessionCookies.map((n) => ({ name: n, domain: dom, value: 'real-cookie-value' }));
  const v = P.judgeLogin(cookies, p.homeUrl, p);
  assert.equal(v.loggedIn, true, JSON.stringify(v));
  assert.equal(v.evidence, 'cookie');
  // 1 个字符的「身份 cookie」是页面里的哨兵占位，谁都能塞，不能当凭证
  const short = p.sessionCookies.map((n) => ({ name: n, domain: dom, value: 'x' }));
  assert.equal(P.judgeLogin(short, p.homeUrl, p).loggedIn, false, '1 字符的值必须拒收');
});

await test('淘宝：只有 cookie2/_tb_token_（匿名跟踪 + csrf）不算登录，必须命中 unb/sgcookie', () => {
  const p = P.platformOf('taobao');
  const dom = '.taobao.com';
  const anon = [
    { name: 'cookie2', domain: dom, value: 'real-cookie-value' },
    { name: '_tb_token_', domain: dom, value: 'real-cookie-value' },
  ];
  const v = P.judgeLogin(anon, 'https://qn.taobao.com/home.htm', p);
  assert.equal(v.loggedIn, false, '光有 cookie2 + _tb_token_ 不能算登录：' + JSON.stringify(v));
  assert.equal(v.evidence, 'cookie-weak');
  const real = anon.concat([{ name: 'unb', domain: dom, value: 'real-cookie-value' }]);
  assert.equal(P.judgeLogin(real, 'https://qn.taobao.com/home.htm', p).loggedIn, true, '有 unb 就该算登录');
});

await test('京东：未登录的登录页（实测那 18 个 cookie）里没有 pt_key/pt_pin → 未登录', () => {
  const p = P.platformOf('jd');
  const dom = '.jd.com';
  const loginPageCookies = [
    '3AB9D23F7A4B3C9B', 'JSESSIONID', '__jda', '__jdu', '_gia_d', '_t', 'csn', 'cud', 'cvt',
    'dsm-lang', 'sdtoken', 'shshshfpa', 'shshshfpb', 'shshshfpx',
  ].map((n) => ({ name: n, domain: dom, value: 'real-cookie-value' }));
  for (const c of loginPageCookies) assert.ok(!p.sessionCookies.includes(c.name), c.name + ' 不该出现在 jd 的判据里');
  assert.equal(P.judgeLogin(loginPageCookies, p.homeUrl, p).loggedIn, false, '光有设备 cookie 不能算登录');
  const real = loginPageCookies.concat([
    { name: 'pt_key', domain: dom, value: 'AAJXX-real-token' },
    { name: 'pt_pin', domain: dom, value: 'real-pin' },
  ]);
  assert.equal(P.judgeLogin(real, p.homeUrl, p).loggedIn, true, '有 pt_key/pt_pin 就是登录了');
});

await test('1688：__cn_logon__=false 是「没登录」的铁证，换 true 才算（值判据）', () => {
  const p = P.platformOf('ali1688');
  const dom = '.1688.com';
  const notLogged = [
    { name: 'cookie2', domain: dom, value: 'real-cookie-value' },
    { name: '_tb_token_', domain: dom, value: 'real-cookie-value' },
    { name: 't', domain: dom, value: 'real-cookie-value' },
    { name: '__cn_logon__', domain: dom, value: 'false' },
  ];
  const v = P.judgeLogin(notLogged, p.homeUrl, p);
  assert.equal(v.loggedIn, false, '__cn_logon__=false 不能算登录：' + JSON.stringify(v));
  assert.equal(v.evidence, 'cookie-weak');
  const logged = notLogged
    .filter((c) => c.name !== '__cn_logon__')
    .concat([{ name: '__cn_logon__', domain: dom, value: 'true' }]);
  assert.equal(P.judgeLogin(logged, p.homeUrl, p).loggedIn, true, '__cn_logon__=true 就是登录了');
  const nick = notLogged
    .filter((c) => c.name !== '__cn_logon__')
    .concat([{ name: '_nk_', domain: dom, value: 'real%40nick' }]);
  assert.equal(P.judgeLogin(nick, p.homeUrl, p).loggedIn, true, '有 _nk_ 也算登录');
});

await test('天猫：与淘宝同一套账号体系（unb/sgcookie），判据一致', () => {
  const p = P.platformOf('tmall');
  const dom = '.taobao.com';
  const anon = [
    { name: 'cookie2', domain: dom, value: 'real-cookie-value' },
    { name: '_tb_token_', domain: dom, value: 'real-cookie-value' },
  ];
  assert.equal(P.judgeLogin(anon, p.homeUrl, p).loggedIn, false, '天猫同样不能被 cookie2/_tb_token_ 骗过');
  const real = anon.concat([{ name: 'sgcookie', domain: dom, value: 'real-cookie-value' }]);
  assert.equal(P.judgeLogin(real, p.homeUrl, p).loggedIn, true);
});

await test('身份 cookie 挂错域 → 不判已登录（cookie 域串台是头号误判来源）', () => {
  const p = P.platformOf('pdd');
  const cookies = p.sessionCookies.map((n) => ({ name: n, domain: '.example.com', value: 'real-cookie-value' }));
  const v = P.judgeLogin(cookies, p.homeUrl, p);
  assert.equal(v.loggedIn, false, JSON.stringify(v));
});

await test('停在登录页 → 有 cookie 也不判已登录（站点不认这个会话，cookie 只是没被清掉）', () => {
  const p = P.platformOf('pdd');
  const cookies = p.sessionCookies.map((n) => ({ name: n, domain: '.pinduoduo.com', value: 'real-cookie-value' }));
  const v = P.judgeLogin(cookies, p.loginUrl, p);
  assert.equal(v.loggedIn, false, JSON.stringify(v));
  assert.equal(v.evidence, 'login-page', '要如实说明是「被按回登录页」，而不是「没读到 cookie」');
  assert.equal(v.reason, '登录已失效，请重新登录', '登录页 + 罐里有旧 cookie → 一句话说清掉线了，别写猜测');
  assert.equal(P.judgeLogin([], p.loginUrl, p).reason, '未登录，请前往登录页登录', '罐里干干净净 → 就是还没登');
  assert.equal(/多半|也许|似乎|疑似|可能/.test(v.reason), false, '结论已定，原因里不该再留猜测措辞');
  assert.equal(P.looksLikeLoginPage(p.loginUrl, p), true);
  assert.equal(P.looksLikeLoginPage(p.homeUrl, p), false);
});

await test('凭证到期时间：只认平台会话 cookie、取最晚；会话级/匿名/错域都不算', () => {
  const p = P.platformOf('pdd');
  const mk = (name, expires, domain) => ({ name, expires, domain, value: 'real-value' });
  const later = Math.floor(Date.parse('2027-01-27T03:44:17Z') / 1000);
  const earlier = later - 86400;
  const at = (cookies) => P.tokenExpiryOf(cookies, p);
  assert.equal(
    at([mk('PASS_ID', later, '.pinduoduo.com'), mk('SUB_PASS_ID', earlier, '.pinduoduo.com')]),
    new Date(later * 1000).toISOString(),
    '取最晚的那张凭证',
  );
  assert.equal(at([mk('PASS_ID', -1, '.pinduoduo.com')]), null, '会话级 cookie 没有到期时间');
  assert.equal(at([mk('PASS_ID', later, '.example.com')]), null, '域不对不算');
  assert.equal(at([mk('cna', later, '.pinduoduo.com')]), null, '匿名 cookie 不是凭证');
});

await test('cookie 读不到时不冒充：退用网址必须单独标注成 url 弱判据', () => {
  const p = P.platformOf('taobao');
  const weak = P.judgeLogin([], p.homeUrl, p, { cookieReadOk: false });
  assert.equal(weak.evidence, 'url', '网址判据要和 cookie 判据分开，界面才能如实显示「疑似」');
  assert.equal(weak.loggedIn, true);
  assert.ok(weak.reason, '必须给出人话原因');
  assert.equal(P.judgeLogin([], p.loginUrl, p, { cookieReadOk: false }).loggedIn, false, '登录页不算已登录');
  assert.equal(P.judgeLogin([], 'https://example.com/', p, { cookieReadOk: false }).loggedIn, false, '站外不算已登录');
});

// ── 2. 持久化 ────────────────────────────────────────────────────────────────

section('2. 持久化 lib/store.mjs');
const S = await import(url('lib/store.mjs'));

await test('数据目录可被 DSH_SHOP_ACCOUNTS_DIR 搬到临时目录（自检不碰真实账号）', () => {
  assert.equal(S.dataDir(), path.join(TMP, 'data'));
});

await test('config 往返 + 非法 portBase 回落到 9222', () => {
  S.writeConfig({ portBase: 9300, openWorkTab: true });
  const cfg = S.readConfig();
  assert.equal(cfg.portBase, 9300);
  assert.equal(cfg.openWorkTab, true);
  S.writeConfig({ portBase: 999999 });
  assert.equal(S.readConfig().portBase, 9222);
  S.writeConfig({ portBase: 9222, openWorkTab: false });
});

await test('accounts 往返 + 坏条目被丢掉而不是让整表打不开', () => {
  const good = { id: 'acc_pdd_1', platform: 'pdd', name: 'A', port: 9222 };
  S.writeAccounts([good, { id: 42 }, null, { platform: 'pdd' }]);
  const { accounts, error } = S.readAccounts();
  assert.equal(error, null);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'acc_pdd_1');
});

await test('坏 JSON 降级成默认值并带上 __error（不抛）', () => {
  fs.writeFileSync(S.accountsPath(), '{ 这不是 JSON', 'utf8');
  const { accounts, error } = S.readAccounts();
  assert.deepEqual(accounts, []);
  assert.ok(error && error.includes('读取失败'), '应带诊断信息：' + error);
});

await test('档案目录用账号 id 命名（店铺名里的 \\ : 不会变成路径事故）', () => {
  const dir = S.profileDirFor('acc_pdd_1', { profileRoot: path.join(TMP, 'profiles') });
  assert.equal(dir, path.join(TMP, 'profiles', 'acc_pdd_1'));
  const id = S.newAccountId('pdd');
  assert.match(id, /^acc_pdd_[a-z0-9]+$/i);
});

await test('运行期登记表：自己起的浏览器记在哪（「端口是不是这个账号的」靠它）', () => {
  assert.deepEqual(S.readRuntime(), {});
  S.setRuntime('acc_pdd_1', { port: 9222, profileDir: 'C:\\x\\y', pid: 123 });
  const rt = S.readRuntime();
  assert.equal(rt.acc_pdd_1.port, 9222);
  assert.ok(rt.acc_pdd_1.at, '应该带上写入时间');
  S.setRuntime('acc_pdd_1', null);
  assert.deepEqual(S.readRuntime(), {}, '传 null 就是清掉');
  assert.ok(S.runtimePath().endsWith('runtime.json'));
});

// ── 3. 宿主 HTTP 面 ──────────────────────────────────────────────────────────

section('3. 宿主 HTTP 面 lib/index.js');

const host = await import(url('lib/index.js'));

function fakeRes() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = body; settle(); },
  };
  return { res, done };
}
function fakeReq(method, reqUrl, body, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.url = reqUrl;
  req.destroy = () => {};
  // 默认带齐「本插件界面」的请求头：v0.8.3 起路由要求自定义头 + JSON Content-Type
  req.headers = Object.assign({
    'x-dsh-shop-accounts': '1',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    host: '127.0.0.1:43120',
  }, headers || {});
  if (body !== undefined) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    process.nextTick(() => { req.emit('data', Buffer.from(raw, 'utf8')); req.emit('end'); });
  } else {
    process.nextTick(() => req.emit('end'));
  }
  return req;
}

const registered = [];
const dispose = host.apply({
  webServer: { register: (r) => { registered.push(r); return () => {}; } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

await test('apply() 用 webServer 挂了一个 prefix 路由，路径与客户端 BASE 一致', () => {
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, 'prefix');
  assert.equal(registered[0].path, '/shop-accounts');
  assert.equal(typeof registered[0].handler, 'function');
  assert.equal(typeof dispose, 'function');
});

const handler = registered[0].handler;
async function call(method, p, body, headers) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body, headers), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON 就别解析 */ }
  return { status: res.statusCode, headers: res.headers, json, body: res.body };
}

await test('GET /state 返回空表 + 平台表 + 数据目录', async () => {
  const r = await call('GET', '/shop-accounts/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.accounts, []);
  assert.equal(r.json.platforms.length, 6);
  assert.equal(r.json.dataDir, path.join(TMP, 'data'));
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
});

await test('PUT /config 落盘并被 /state 读到', async () => {
  const r = await call('PUT', '/shop-accounts/config', { portBase: 9400, openWorkTab: true });
  assert.equal(r.status, 200);
  const s = await call('GET', '/shop-accounts/state');
  assert.equal(s.json.config.portBase, 9400);
  assert.equal(s.json.config.openWorkTab, true);
  await call('PUT', '/shop-accounts/config', { portBase: 9222, openWorkTab: false });
});

await test('GET /state 带插件版本号；config 里带更新源目录（界面要显示 vX.Y.Z）', async () => {
  const s = await call('GET', '/shop-accounts/state');
  assert.equal(s.status, 200);
  assert.match(String(s.json.version || ''), /^\d+\.\d+\.\d+$/, '状态里要带插件版本号');
  // loadedVersion 是「本次启动真正加载进内存的版本」，界面拿它跟磁盘上的 version 比，
  // 才能识破「文件覆盖了、DSH 没重启」这种假更新（2026-10-19 千牛那种反复）。
  assert.match(String(s.json.loadedVersion || ''), /^\d+\.\d+\.\d+$/, '状态里要带本次启动加载的版本号');
  assert.equal(s.json.loadedVersion, s.json.version, '自检里没有"文件更新了没重启"的情况，两个版本号应相同');
  assert.equal(typeof s.json.updateDir, 'string', '状态里要带自动探测到的更新源目录');
  assert.equal(typeof s.json.config.updateDir, 'string', 'config 里要有 updateDir 字段');
});

await test('检测更新：更新源不是 git 仓库时如实报错（写入时就拦），不联网瞎猜', async () => {
  const notRepo = path.join(TMP, 'not-a-repo');
  fs.mkdirSync(notRepo, { recursive: true });
  const put = await call('PUT', '/shop-accounts/config', { updateDir: notRepo });
  assert.equal(put.status, 400, '不是 git 仓库的目录不该被存进配置');
  assert.match(put.json.error, /不是 git 仓库/);
  // 跳过路由，直接调 checkUpdate：不依赖"自动探测到哪个源码目录"（那取决于本机环境，会 flaky）
  const r = await host.checkUpdate({ updateDir: notRepo });
  assert.equal(r.ok, false, '不是 git 仓库就不能假装能更新');
  assert.match(String(r.error || ''), /不是 git 仓库/);
  assert.match(String(r.localVersion || ''), /^\d+\.\d+\.\d+$/, '报错也要把本地版本号带上');
  const applied = await host.applyUpdate({ updateDir: notRepo });
  assert.equal(applied.ok, false);
  await call('PUT', '/shop-accounts/config', { updateDir: '' });
});

await test('更新覆盖：syncFromSource 只搬运行文件，源码 == 目标时跳过（不自己踩自己）', () => {
  const src = path.join(TMP, 'fake-src');
  const dst = path.join(TMP, 'fake-installed');
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(src, 'lib', 'index.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
  fs.mkdirSync(path.join(dst, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dst, 'lib', 'index.js'), 'export const x = 0;\n');
  const r = host.syncFromSource(src, dst);
  assert.equal(r.sameDir, false);
  assert.ok(r.copied >= 2, '至少要搬 lib 和 package.json');
  assert.match(fs.readFileSync(path.join(dst, 'lib', 'index.js'), 'utf8'), /x = 1/, '拷贝要真的覆盖旧文件');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dst, 'package.json'), 'utf8')).version, '9.9.9');
  const same = host.syncFromSource(src, src);
  assert.equal(same.sameDir, true);
  assert.equal(same.copied, 0);
  assert.equal(host.cmpVersion('0.4.0', '0.3.10'), 1);
  assert.equal(host.cmpVersion('0.3.3', '0.3.3'), 0);
  assert.equal(host.cmpVersion('0.3.2', '0.3.10'), -1);
});

await test('POST /accounts 建号（不传 profileDir → 不启动任何浏览器）', async () => {
  const r = await call('POST', '/shop-accounts/accounts', { loginName: 'u1', password: 'Test-P@ss1', platform: 'pdd', name: '测试店', note: '备注' });
  assert.equal(r.status, 200);
  assert.equal(r.json.account.platform, 'pdd');
  assert.equal(r.json.account.name, '测试店');
  assert.equal(r.json.account.pendingLogin, true);
  assert.ok(r.json.account.profileDir.includes('acc_pdd_'));
  const s = await call('GET', '/shop-accounts/state');
  assert.equal(s.json.accounts.length, 1);
  assert.equal(s.json.accounts[0].running, false);
});

await test('未知平台 → 400 且说明允许值', async () => {
  const r = await call('POST', '/shop-accounts/accounts', { loginName: 'u2', password: 'Test-P@ss1', platform: 'amazon', name: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /pdd/);
});

await test('GET/PUT /accounts/:id 改名换端口', async () => {
  const s = await call('GET', '/shop-accounts/state');
  const id = s.json.accounts[0].id;
  const g = await call('GET', '/shop-accounts/accounts/' + id);
  assert.equal(g.status, 200);
  const p = await call('PUT', '/shop-accounts/accounts/' + id, { name: '改过的名字', note: '新备注', port: 9223 });
  assert.equal(p.json.account.name, '改过的名字');
  assert.equal(p.json.account.port, 9223);
  // 「管理」详情页要写的那几个字段：账号 / 账号类型（v0.9.0 起是 seller/buyer 枚举，
  // 老写法“商家账号”仍接受，但落库/读取时会归一成 'seller'）；url 界面已不显示，接口仍接受。
  const d = await call('PUT', '/shop-accounts/accounts/' + id, {
    url: 'https://mms.pinduoduo.com/goods/goods_list', loginName: '示例店铺;示例账号', accountType: '商家账号',
  });
  assert.equal(d.json.account.url, 'https://mms.pinduoduo.com/goods/goods_list');
  assert.equal(d.json.account.loginName, '示例店铺;示例账号');
  assert.equal(d.json.account.accountType, 'seller');
  const ds = await call('GET', '/shop-accounts/state');
  assert.equal(ds.json.accounts[0].url, 'https://mms.pinduoduo.com/goods/goods_list');
  assert.equal(ds.json.accounts[0].loginName, '示例店铺;示例账号');
  assert.equal(ds.json.accounts[0].accountType, 'seller');
  // 买家身份：拼多多没有买家端（v0.16.6），改成买家要被拒并说明原因
  const b = await call('PUT', '/shop-accounts/accounts/' + id, { accountType: 'buyer' });
  assert.equal(b.status, 400);
  assert.equal(b.json.code, 'ACCOUNT_TYPE_UNSUPPORTED');
  // 能选买家的平台照旧可落库（抖音买家只有扫码/验证码，因此不要求填密码）
  const dy = await call('POST', '/shop-accounts/accounts', { platform: 'douyin', accountType: 'buyer', name: '抖音买家号', loginName: '抖音买家' });
  assert.equal(dy.status, 200, JSON.stringify(dy.json));
  const bs = await call('GET', '/shop-accounts/state');
  const row = bs.json.accounts.find((a) => a.id === dy.json.account.id);
  assert.equal(row.accountType, 'buyer');
  assert.equal(row.capabilities.upload, false);
  assert.equal(row.capabilities.collection, true);
  // 建完就删掉，后面的排期/删账号用例仍按「只有一个店铺」算
  const delDy = await call('DELETE', '/shop-accounts/accounts/' + dy.json.account.id, {});
  assert.equal(delDy.status, 200);
  // 非法类型要 400
  const bad = await call('PUT', '/shop-accounts/accounts/' + id, { accountType: 'vip' });
  assert.equal(bad.status, 400);
  const miss = await call('GET', '/shop-accounts/accounts/acc_nope_1');
  assert.equal(miss.status, 404);
});

await test('DELETE /accounts/:id 只删记录（不带 deleteProfile）', async () => {
  const s = await call('GET', '/shop-accounts/state');
  const id = s.json.accounts[0].id;
  const r = await call('DELETE', '/shop-accounts/accounts/' + id, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.deletedProfile, false);
  const after = await call('GET', '/shop-accounts/state');
  assert.equal(after.json.accounts.length, 0);
});

await test('未知路由 404；坏 JSON 400（外层兜底不炸进程）', async () => {
  const nf = await call('GET', '/shop-accounts/nope');
  assert.equal(nf.status, 404);
  const bad = await call('POST', '/shop-accounts/accounts', '{ 半截 JSON');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /JSON/);
});

// ── 3.5 定时检测（排期算法 + 路由 + tick） ──────────────────────────────────

section('3.5 定时检测 lib/schedule.mjs');

const SCH = await import(pathToFileURL(path.join(ROOT, 'lib/schedule.mjs')).href);

// tick 会跳过"正在等登录"的店铺 —— 自检里用已有的建号接口造出来的都是等登录状态，
// 这里直接把临时账号表里的标记清掉（只动 TMP/data，不碰真实账号表）。
function clearPending() {
  const file = path.join(TMP, 'data', 'accounts.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const a of raw.accounts || []) a.pendingLogin = false;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

await test('排期算法：时间归一 / 越界夹住 / 顺序去重', () => {
  assert.equal(SCH.normalizeStartTime('9:5'), '09:05');
  assert.equal(SCH.normalizeStartTime('25:00'), '10:00', '非法小时回默认');
  assert.equal(SCH.parseHm('10:30'), 630);
  assert.equal(SCH.fmtHm(630), '10:30');
  assert.equal(SCH.fmtHm(1470), '00:30', '超过一天的分钟数要绕回');
  const n = SCH.normalizeSchedule({
    startTime: 'bad', groupIntervalMin: 0, groupSize: 999, order: ['a', 'a', ' '], lastDay: 'x',
  });
  assert.equal(n.startTime, '10:00');
  assert.equal(n.groupIntervalMin, 1, '间隔最小 1 分钟');
  assert.equal(n.groupSize, 50, '每组最多 50 个');
  assert.deepEqual(n.order, ['a'], '顺序去重、去掉空值');
  assert.equal(n.lastDay, '', '坏日期清空（否则"今天跑过"会一直成立）');
  // 保活停留：默认 8 秒；越界夹住（0 = 关闭，最多 120 秒）
  assert.equal(SCH.normalizeSchedule({}).keepaliveSec, 8, '默认保活 8 秒');
  assert.equal(SCH.normalizeSchedule({ keepaliveSec: 0 }).keepaliveSec, 0, '0 = 光检测不保活');
  assert.equal(SCH.normalizeSchedule({ keepaliveSec: 999 }).keepaliveSec, 120, '最多 120 秒');
  assert.equal(SCH.normalizeSchedule({ keepaliveSec: -5 }).keepaliveSec, 0);
});

await test('排期算法：每组 N 个共享一个时间点，暂停的店铺照样占位', () => {
  const accounts = [
    { id: 'a1', name: 'A', platform: 'pdd', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'a2', name: 'B', platform: 'pdd', createdAt: '2026-10-02T00:00:00Z' },
    { id: 'a3', name: 'C', platform: 'pdd', createdAt: '2026-10-03T00:00:00Z', schedEnabled: false },
    { id: 'a4', name: 'D', platform: 'pdd', createdAt: '2026-10-04T00:00:00Z' },
  ];
  const p = SCH.planSchedule({
    schedule: { enabled: true, startTime: '10:00', groupIntervalMin: 30, groupSize: 2 },
    accounts, memGB: 8,
  });
  assert.equal(p.groupSize, 2);
  assert.deepEqual(p.rows.map((r) => r.time), ['10:00', '10:00', '10:30', '10:30']);
  assert.deepEqual(p.rows.map((r) => r.group), [0, 0, 1, 1]);
  assert.equal(p.rows[2].enabled, false, '暂停的店铺到点不跑');
  assert.equal(p.rows[2].active, false);
  assert.equal(p.rows[2].time, '10:30', '但它照样占着 10:30，后面的不提前');
  assert.equal(SCH.groupSizeFor({ groupSize: 0 }, 32), 2, '>16GB 自动每组 2 个');
  assert.equal(SCH.groupSizeFor({ groupSize: 0 }, 8), 1);
  assert.equal(SCH.groupSizeFor({ groupSize: 3 }, 8), 3, '填了就用你填的');
  const ordered = SCH.resolveOrder(['a4'], accounts);
  assert.equal(ordered[0].id, 'a4', '排过序的店铺排在最前');
  assert.equal(ordered.length, 4);
});

await test('排期算法：到点才跑、错过不补跑、同一天同一个点只跑一次', () => {
  const accounts = [
    { id: 'a1', name: 'A', platform: 'pdd', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'a2', name: 'B', platform: 'pdd', createdAt: '2026-10-02T00:00:00Z' },
  ];
  const base = { enabled: true, startTime: '10:00', groupIntervalMin: 60, groupSize: 1 };
  const at = (h, m, sec = 0) => new Date(2026, 9, 19, h, m, sec);
  assert.equal(SCH.dueRows({ schedule: base, accounts, now: at(9, 59) }).length, 0, '还没到点');
  assert.deepEqual(SCH.dueRows({ schedule: base, accounts, now: at(10, 1) }).map((r) => r.id), ['a1']);
  assert.deepEqual(SCH.dueRows({ schedule: base, accounts, now: at(11, 1) }).map((r) => r.id), ['a2']);
  assert.equal(SCH.dueRows({ schedule: base, accounts, now: at(12, 30) }).length, 0, '过了宽限就不补跑');
  const ran = SCH.markRan(base, { accountIds: ['a1'], time: '10:00', now: at(10, 1) });
  assert.equal(SCH.dueRows({ schedule: ran, accounts, now: at(10, 1) }).length, 0, '同一天同一个点跑过就不再跑');
  const next = SCH.nextRun({ schedule: base, accounts, now: at(9, 0) });
  assert.equal(next.time, '10:00');
  assert.equal(SCH.nextRun({ schedule: { ...base, enabled: false }, accounts, now: at(9, 0) }), null, '总开关关着就没有下次');
});

await test('GET /schedule 带排期；PUT /schedule 落盘并在 /state 里给每个店铺算好时间点', async () => {
  const a = await call('POST', '/shop-accounts/accounts', { loginName: 'u3', password: 'Test-P@ss1', platform: 'pdd', name: '排期店A' });
  const b = await call('POST', '/shop-accounts/accounts', { loginName: 'u4', password: 'Test-P@ss1', platform: 'taobao', name: '排期店B' });
  const g = await call('GET', '/shop-accounts/schedule');
  assert.equal(g.status, 200);
  assert.equal(g.json.schedule.enabled, false, '默认不开');
  assert.equal(g.json.schedule.rows.length, 2);
  const put = await call('PUT', '/shop-accounts/schedule', {
    enabled: true, startTime: '9:5', groupIntervalMin: 15, groupSize: 1, keepaliveSec: 0,
    order: [b.json.account.id, a.json.account.id],
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.schedule.startTime, '09:05', '时间会被归一');
  assert.equal(put.json.schedule.groupSizeMode, 'manual');
  assert.equal(put.json.schedule.keepaliveSec, 0, '保活停留要能存下来（0 = 关闭）');
  assert.deepEqual(put.json.schedule.rows.map((r) => r.id), [b.json.account.id, a.json.account.id], '按 order 排队');
  assert.deepEqual(put.json.schedule.rows.map((r) => r.time), ['09:05', '09:20']);
  const s = await call('GET', '/shop-accounts/state');
  const byId = new Map(s.json.accounts.map((x) => [x.id, x]));
  assert.equal(byId.get(b.json.account.id).schedTime, '09:05', '列表每行要能显示自己的时间点');
  assert.equal(byId.get(a.json.account.id).schedTime, '09:20');
  assert.equal(byId.get(a.json.account.id).schedEnabled, true, '店铺默认开启');
  assert.equal(Boolean(s.json.schedule && s.json.schedule.enabled), true, '/state 里也要带排期（横幅用）');
});

await test('POST /schedule/preview 只试算不保存', async () => {
  const before = await call('GET', '/shop-accounts/schedule');
  const r = await call('POST', '/shop-accounts/schedule/preview', { startTime: '07:00', groupIntervalMin: 5, groupSize: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.plan.startTime, '07:00');
  assert.equal(r.json.plan.groupSize, 2);
  assert.deepEqual(r.json.plan.rows.map((x) => x.time), ['07:00', '07:00'], '两个店铺一组 → 同一个时间点');
  assert.equal(typeof r.json.autoGroupSize, 'number');
  assert.equal(typeof r.json.memGB, 'number');
  const after = await call('GET', '/shop-accounts/schedule');
  assert.equal(after.json.schedule.startTime, before.json.schedule.startTime, '预览不能偷偷存盘');
});

await test('POST /accounts/:id/schedule 单店开关：暂停后到点不跑，但时间点不跳', async () => {
  const s = await call('GET', '/shop-accounts/state');
  const first = s.json.schedule.rows[0];
  const r = await call('POST', '/shop-accounts/accounts/' + first.id + '/schedule', { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.account.schedEnabled, false);
  const after = await call('GET', '/shop-accounts/schedule');
  const row = after.json.schedule.rows.find((x) => x.id === first.id);
  assert.equal(row.enabled, false);
  assert.equal(row.time, first.time, '暂停后时间点不变，后面的店铺不提前');
  await call('POST', '/shop-accounts/accounts/' + first.id + '/schedule', { enabled: true });
});

await test('tickSchedule：到点才跑、结果写回 lastCheck、同一时间点不重复跑', async () => {
  clearPending();
  const s = await call('GET', '/shop-accounts/schedule');
  const first = s.json.schedule.rows[0];
  const [hh, mm] = first.time.split(':').map(Number);
  const now = new Date(2026, 9, 19, hh, mm, 30);
  const calls = [];
  const gotOpts = [];
  const checkFn = async (acc, o) => {
    calls.push(acc.id);
    gotOpts.push(o);
    return { ok: true, loggedIn: true, evidence: 'cookie', reason: '假检测' };
  };
  // appRunning 注入：这台机器装了 ego 但可能没开着，不注入的话「到点该跑」会变成「ego 没开→跳过」
  const r1 = await host.tickSchedule({ now, memGB: 8, log: { info() {}, warn() {} }, checkFn, appRunning: async () => true });
  assert.equal(r1.ran.length, 1, '第一组只有一个店铺到点');
  assert.deepEqual(calls, [first.id]);
  assert.equal(gotOpts[0].keepaliveSec, 0, '上一步把保活存成 0，定时检测就该传 0 下去');
  const r2 = await host.tickSchedule({ now, memGB: 8, log: { info() {}, warn() {} }, checkFn, appRunning: async () => true });
  assert.equal(r2.ran.length, 0, '同一个时间点跑过就不再跑（重启也一样）');
  assert.deepEqual(calls, [first.id], '第二次连检测函数都不该调');
  const st = await call('GET', '/shop-accounts/state');
  const hit = st.json.accounts.find((a) => a.id === first.id);
  assert.equal(Boolean(hit.lastCheck && hit.lastCheck.loggedIn), true, '结果要写回 lastCheck');
  assert.ok(hit.lastCheckAt, '要带检测时间');
  assert.ok(hit.lastSchedAt, '要记录定时检测时间');
  assert.equal(hit.lastSchedError, '');
});

await test('tickSchedule：跳过正在等登录的店铺，不打断用户手里的登录', async () => {
  const s = await call('GET', '/shop-accounts/schedule');
  const rows = s.json.schedule.rows;
  const second = rows[rows.length - 1];
  const [hh, mm] = second.time.split(':').map(Number);
  const now = new Date(2026, 9, 19, hh, mm, 10);
  // 把最后这个店铺重新标成"等登录"
  const file = path.join(TMP, 'data', 'accounts.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const a of raw.accounts) if (a.id === second.id) a.pendingLogin = true;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  let called = 0;
  const r = await host.tickSchedule({
    now, memGB: 8, log: { info() {}, warn() {} },
    checkFn: async () => { called += 1; return { ok: true, loggedIn: true }; },
    appRunning: async () => true,
  });
  assert.equal(called, 0, '等登录的店铺不该被静默检测打断');
  assert.ok(r.skipped.some((x) => /等登录/.test(x.reason)), '跳过原因要说得清楚：' + JSON.stringify(r.skipped));
});

await test('tickSchedule：ego 关着也照常检测（后台无窗口读 cookie，不再跳过这个时间点）', async () => {
  // 把后端强制成 egolite（egoliteCli 指到真实存在的文件即可），这样结论不依赖本机装没装 ego。
  const before = S.readConfig();
  S.writeConfig({ browser: 'egolite', egoliteCli: process.execPath });
  try {
    const s = await call('GET', '/shop-accounts/schedule');
    const row = s.json.schedule.rows[0];
    const [hh, mm] = row.time.split(':').map(Number);
    const now = new Date(2026, 9, 20, hh, mm, 20); // 换一天，避免和上面那组时间点撞车
    let called = 0;
    const r = await host.tickSchedule({
      now, memGB: 8, log: { info() {}, warn() {} },
      checkFn: async () => { called += 1; return { ok: true, loggedIn: true }; },
    });
    assert.equal(called, 1, 'ego 关着也要真的去检测（走无窗口实例后台读 cookie）');
    assert.equal(r.ran.length, 1, '到点就该跑，不该因为 ego 没开而跳过');
    assert.ok(!r.skipped.some((x) => /ego lite 没在运行/.test(x.reason)), '不该再有「ego 没在运行」这种跳过理由');
    const st = await call('GET', '/shop-accounts/state');
    const hit = st.json.accounts.find((a) => a.id === row.id);
    assert.equal(Boolean(hit.lastCheck && hit.lastCheck.loggedIn), true, '检测结果要写回 lastCheck');
  } finally {
    S.writeConfig({ browser: before.browser || 'auto', egoliteCli: before.egoliteCli || '' });
  }
});

// ── 3.6 登录态要能活过「关窗再开」（千牛那次：会话级 cookie 关窗即丢） ──────

section('3.6 关窗之后登录态还在不在（会话级 cookie）');

const chromeSrc = fs.readFileSync(path.join(ROOT, 'lib/chrome.mjs'), 'utf8');
const indexSrc = readServerSource(ROOT);

await test('启动参数带 --restore-last-session（否则会话级 cookie 关窗就丢，淘宝 unb 就是这种）', () => {
  // 实测（<本地诊断脚本>）：不加 → 会话 cookie 丢；
  // 只写 Preferences 的 session.restore_on_startup=1 → 也丢；加这个命令行开关 → 留得住。
  assert.match(chromeSrc, /'--restore-last-session'/, '没有这个开关，登录态活不过关窗');
});

await test('静默检测自己开干净标签，并关掉恢复出来的旧标签（否则会挑中上次的登录页）', () => {
  assert.match(indexSrc, /urls: \[\]/, '静默检测不能再让 Chrome 顺带恢复旧标签当"当前页"');
  assert.match(indexSrc, /await newPage\(probePort, platform\.homeUrl\)/, '要自己开一个干净标签');
  assert.match(indexSrc, /await closePage\(probePort, p\.id\)/, '别的页面目标要关掉，只留自己这个');
});

await test('finish：关窗之后再验一次，验不过就不许说「已保存」', () => {
  assert.match(indexSrc, /const verified = await checkAccount\(/, '关窗后必须复核');
  assert.match(indexSrc, /saved: false/, '复核不过时不能回 saved:true');
  assert.match(indexSrc, /登录态没保住/, '要说清楚为什么没保存');
});

await test('cookie 罐本地备份：点 X 关窗会丢一批 cookie（实测 86→42、unb 没了），要能补回来', async () => {
  // 真机证据（2026-10-19 08:24→08:25 UTC 的 debug.log）：用户点窗口红叉后重开，
  // 档案里只剩 42 个 cookie、`unb` 直接消失 → 站点按回登录页。
  const cdpSrc = fs.readFileSync(path.join(ROOT, 'lib/cdp.mjs'), 'utf8');
  assert.match(indexSrc, /dsh-session-cookies\.json/, '罐子要落在档案目录里');
  assert.match(indexSrc, /export function saveSessionCookies\(/, '要能存罐子');
  assert.match(indexSrc, /export async function restoreSessionCookies\(/, '要能补罐子');
  assert.match(indexSrc, /await restoreSessionCookies\(probePort, account\)/, '静默检测启动后要先补罐子再开页面');
  assert.match(indexSrc, /const missing = cookies\.filter\(\(c\) => !have\.has\(/, '只补档案里缺的，别拿旧值覆盖新的同名 cookie');
  assert.match(indexSrc, /await rememberLiveCookies\(account\)/, '关窗之前要把活着的罐子存一份');
  assert.match(cdpSrc, /Network\.setCookies/, '补罐子要走 CDP Network.setCookies');
});

await test('关窗之前先等身份 cookie 到齐（淘宝 unb 比工作台晚几秒下来，等不到就别关窗）', async () => {
  assert.match(indexSrc, /export async function waitForIdentityCookies\(/, '要有一层"等身份 cookie"的门');
  const platform = { identityCookies: ['unb', 'sgcookie'] };
  const craft = (matched) => ({ loggedIn: true, matched });
  // 依次返回：缺 unb 若干次 → 齐了（凑够 5 秒以上，验证中途会催工作台）
  const missingPoll = craft(['sgcookie', 'cookie2']);
  const queue = [missingPoll, missingPoll, missingPoll, missingPoll, missingPoll, missingPoll, missingPoll, craft(['unb', 'sgcookie'])];
  let reads = 0;
  let nudges = 0;
  let waited = 0;
  const r = await host.waitForIdentityCookies(async () => {
    const v = queue[Math.min(reads, queue.length - 1)];
    reads += 1;
    return v;
  }, platform, {
    first: queue[0],
    timeoutMs: 20000,
    pollMs: 1000,
    now: () => waited,
    sleepFn: async (ms) => { waited += ms; },
    nudge: async () => { nudges += 1; },
  });
  assert.equal(r.ok, true, '身份 cookie 到齐后要放行：' + JSON.stringify(r));
  assert.ok(reads >= 3, '中间没齐，必须继续等（实际读了 ' + reads + ' 次）');
  assert.ok(nudges >= 1, '等了 5 秒还没齐要催一次工作台');

  // 一直不齐 → 不许放行，并报出缺哪个
  let waited2 = 0;
  const bad = await host.waitForIdentityCookies(async () => craft(['sgcookie']), platform, {
    first: craft(['sgcookie']),
    timeoutMs: 3000,
    pollMs: 1000,
    now: () => waited2,
    sleepFn: async (ms) => { waited2 += ms; },
  });
  assert.equal(bad.ok, false, '身份 cookie 一直不齐不能放行');
  assert.deepEqual(bad.missing, ['unb'], '要指名道姓说缺哪个 cookie');

  // 平台没有 identityCookies（比如拼多多）→ 不额外等
  const plain = await host.waitForIdentityCookies(async () => craft([]), { identityCookies: [] }, {
    first: craft([]),
    now: () => 0,
    sleepFn: async () => { throw new Error('不该睡'); },
  });
  assert.equal(plain.ok, true, '没有身份 cookie 要求的平台直接放行');
  assert.equal(plain.waitedMs, 0);
});

// ── 3.7 ego lite 后端（纯函数 + 路由契约；绝不起浏览器） ─────────────────────

section('3.7 ego lite 后端 lib/ego.mjs');

const EG = await import(url('lib/ego.mjs'));
const egoSrc = fs.readFileSync(path.join(ROOT, 'lib/ego.mjs'), 'utf8');

await test('ego 空间用完要交还控制权（否则 ego 一直显示「agent 调试中」）', () => {
  // ego 的 ownership：agent = agent 占着（界面显示「agent 调试中」）；task.handOff() 之后 = agentDelegatedToUser（用户控制）。
  // 交还之后浏览器命令会被硬停，所以要 takeOverTaskSpace(id) 才收得回来 —— 顺序必须是「先收回、干活、最后交还」。
  assert.match(egoSrc, /export async function egoHandOff/, '要导出 egoHandOff');
  assert.match(egoSrc, /op === 'handoff'/, '运行时里要有 handoff 这个 op');
  assert.match(egoSrc, /agentDelegatedToUser/, '要认得出「已交还给用户」这个 ownership');
  assert.match(egoSrc, /takeOverTaskSpace/, '交还之后要能收回控制（否则下次读 cookie 会被硬停）');
  // open 的最后一步必须是 handOff
  // 注意：文件里 probe 的定义在 open 之前，所以 open 的切片终点要取后面的 reset（不能取 probe，
  // 那会得到空字符串 —— 曾经因为重排过顺序把这条断言变成空断言）。
  const openBlock = egoSrc.slice(egoSrc.indexOf("if (op === 'open')"), egoSrc.indexOf("if (op === 'reset')"));
  assert.match(openBlock, /await handOff\(\)/, 'open 结尾要交还控制权');
  // probe 不再碰用户那个空间：同 profile 另开一个临时空间读 cookie，读完 finish 掉。
  // （在用户窗口里读就得 takeOver，会把正在用的人打断 —— v0.8.0 改成临时空间）
  const probeBlock = egoSrc.slice(egoSrc.indexOf("if (op === 'probe')"), egoSrc.indexOf("if (op === 'open')"));
  assert.match(probeBlock, /temp = await g\.taskSpace\(tempName/, 'probe 要另开临时空间');
  // 顺序仍然是"读 cookie → finally 里收掉临时空间"（v0.8.1 前面多了一段「收掉上次残留的同名空间」，
  // 所以不能再用第一个 finish 的下标来判断）
  assert.match(probeBlock, /getAllCookies[\s\S]*finally[\s\S]*temp\.finish\(\{ keep: \[\] \}\)/,
    'probe 要「先读 cookie、再收掉临时空间」');
  // 允许用 takeOver 收"上次检测自己留下的、ownership=agent 的同名残留空间"，但不许接管用户的窗口
  const staleGuard = probeBlock.indexOf("String(stale.ownership || '') === 'agent'");
  assert.ok(staleGuard >= 0 && staleGuard < probeBlock.indexOf('takeOverTaskSpace'),
    'takeOver 只能用在"收掉自己残留的临时空间"上，不能去接管用户的窗口');
});

await test('ego 探测只看文件在不在（不启动进程）；配了不存在的路径不会被当成可用', () => {
  const cli = EG.resolveEgoCli('');
  assert.ok(cli === null || typeof cli === 'string', 'resolveEgoCli 只能返回路径或 null');
  if (cli) assert.ok(fs.existsSync(cli), '探测到的 CLI 必须真实存在：' + cli);
  const fake = path.join(TMP, 'no-such-ego-browser.exe');
  assert.notEqual(EG.resolveEgoCli(fake), fake, '配置里写了个不存在的路径，不能当成可用（应回退自动探测）');
  // 真机没装 ego 时 cli 就是 null —— 下面的断言都按「装了没有」分支走，两种机器都能过
});

await test('backendFor：auto 装了 ego 就优先 ego；明确选了哪个就用哪个，用不了自动换另一个', async () => {
  const cli = EG.resolveEgoCli('');
  const CH = await import(url('lib/chrome.mjs'));
  const chromePath = String(CH.resolveBrowserPath('') || '');
  // v0.20.13：设置页去掉了「浏览器后端」下拉，后端由「用户浏览器」里选中的那一行决定：
  //   · 选 Chrome → 写 browser=chrome + browserPath；
  //   · 选 ego lite → 写回 browser=auto（装了 ego lite 就用它）。
  assert.equal(EG.backendFor({ browser: 'chrome', browserPath: chromePath || 'C:/__no_such__/chrome.exe' }), chromePath ? 'chrome' : (cli ? 'egolite' : 'chrome'), 'Chrome 可用时就用 Chrome，不可用自动换另一个');
  // 注意：resolveBrowserPath 会忽略不存在的 browserPath 并自动探测本机 Chrome，所以期望值取决于本机有没有 Chrome。
  const noChrome = CH.resolveBrowserPath('') ? 'chrome' : (cli ? 'egolite' : 'chrome');
  assert.equal(
    EG.backendFor({ browser: 'chrome', browserPath: 'C:/__no_such__/chrome.exe', egoliteCli: cli || '' }),
    noChrome,
    '选了 Chrome 但那份不可用 → 本机有 Chrome 就用另一份 Chrome，没有就换 ego lite'
  );
  assert.equal(EG.backendFor({ browser: 'egolite', egoliteCli: cli || '' }), cli ? 'egolite' : 'chrome', 'egolite 没装要回退，而不是假装能用');
  assert.equal(EG.backendFor({ browser: 'auto', egoliteCli: cli || '' }), cli ? 'egolite' : 'chrome', 'auto = 装了 ego 优先 ego');
  assert.equal(EG.egoStatus({}).backend, EG.backendFor({}), '状态里的 backend 必须和 backendFor 一致');
  assert.equal(typeof EG.egoStatus({}).cli, 'string');
  assert.equal(typeof EG.egoStatus({}).app, 'string');
});

await test('TaskSpace 命名：默认「店铺-<店铺名>」，显式 egoSpace 优先，换行/制表符被洗掉', () => {
  assert.equal(EG.spaceNameFor({ name: '店铺A' }), '店铺-店铺A');
  assert.equal(EG.spaceNameFor({ name: '店铺A', egoSpace: '自定义空间' }), '自定义空间', '显式指定的空间名优先');
  assert.equal(EG.spaceNameFor({ name: '店\n铺\tA' }), '店铺-店 铺 A', '换行/制表符不能带进空间名');
  assert.equal(EG.spaceNameFor({ id: 'acc_pdd_1' }), '店铺-acc_pdd_1', '没名字就用 id 兜底');
});

await test('config：browser 只认 auto/egolite/chrome（大小写归一），其它值退回 auto', () => {
  S.writeConfig({ browser: 'EGOLITE', egoliteCli: 'C:\\x\\ego-browser.exe', egoliteApp: 'C:\\x\\ego.exe' });
  const c = S.readConfig();
  assert.equal(c.browser, 'egolite', '大小写要归一');
  assert.equal(c.egoliteCli, 'C:\\x\\ego-browser.exe');
  assert.equal(c.egoliteApp, 'C:\\x\\ego.exe');
  S.writeConfig({ browser: 'safari', egoliteCli: '', egoliteApp: '' });
  assert.equal(S.readConfig().browser, 'auto', '不认识的浏览器名退回 auto');
  assert.equal(S.readConfig().egoliteCli, '', '没填就是空字符串（界面直接绑 value，不能是 undefined）');
  S.writeConfig({ browser: 'auto' });
});

await test('PUT /config 能切后端；/state 与 /config 都如实报当前后端', async () => {
  const put = await call('PUT', '/shop-accounts/config', { browser: 'chrome' });
  assert.equal(put.status, 200);
  assert.equal(put.json.backend, 'chrome', '切到 chrome 要立刻生效');
  const s = await call('GET', '/shop-accounts/state');
  assert.equal(s.json.backend, 'chrome', '/state 要带当前后端，界面才知道显示哪套（端口 / 空间）');
  assert.equal(typeof s.json.ego, 'object');
  // running 是「ego 主程序在不在跑」的实测结果，界面靠它决定要不要显示「启动 ego」
  assert.equal(typeof s.json.ego.running, 'boolean', '/state 的 ego 必须带 running（否则界面会瞎猜）');
  const cfg = await call('GET', '/shop-accounts/config');
  assert.equal(cfg.json.backend, 'chrome');
  await call('PUT', '/shop-accounts/config', { browser: 'auto' });
  const cli = EG.resolveEgoCli('');
  assert.equal((await call('GET', '/shop-accounts/state')).json.backend, cli ? 'egolite' : 'chrome', 'auto 要按本机实际情况报');
});

await test('GET /ego 路由存在：返回可用性 + profile/space 列表（数组，读不到也是空数组）', async () => {
  const r = await call('GET', '/shop-accounts/ego');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.backend, 'string');
  assert.ok(r.json.ego && typeof r.json.ego.available === 'boolean', '要能告诉界面 ego 装没装');
  assert.ok(Array.isArray(r.json.ego.profiles), 'profiles 必须是数组（界面直接 map）');
  assert.ok(Array.isArray(r.json.ego.spaces), 'spaces 必须是数组');
});

await test('ego 后端的店铺：端口记 0、状态看空间在不在（不再拿端口当判据）', async () => {
  const cli = EG.resolveEgoCli('');
  await call('PUT', '/shop-accounts/config', { browser: cli ? 'egolite' : 'auto' });
  const made = await call('POST', '/shop-accounts/accounts', { loginName: 'u5', password: 'Test-P@ss1', platform: 'pdd', name: 'ego后端店' });
  assert.equal(made.status, 200);
  const s = await call('GET', '/shop-accounts/state');
  const row = s.json.accounts.find((a) => a.id === made.json.account.id);
  if (cli) {
    assert.equal(row.backend, 'egolite');
    assert.equal(row.port, 0, 'ego 后端没有本地调试端口，端口必须是 0 而不是瞎分一个');
    assert.equal(row.cdpUrl, '', 'ego 后端不该给出 CDP 地址（ego 不暴露 CDP 端口）');
    assert.ok(row.egoSpace.startsWith('店铺-'), '要有 TaskSpace 名，界面显示它');
  } else {
    assert.equal(row.backend, 'chrome');
    assert.ok(row.port >= 9222, 'Chrome 后端照旧分端口');
  }
  await call('DELETE', '/shop-accounts/accounts/' + made.json.account.id, {});
  await call('PUT', '/shop-accounts/config', { browser: 'auto' });
});

await test('ego 模式「完成」只存状态、不收掉空间（空间是独立窗口，不挡用户用浏览器）', () => {
  // 需求：到 ego 就不用关窗口了，它单独一个 space，不影响我们使用浏览器。
  const start = indexSrc.indexOf('async function egoFinishAccount');
  assert.ok(start > 0, '找不到 egoFinishAccount');
  const rest = indexSrc.slice(start + 10);
  // 拆成多模块后，聚合源码里函数后面可能紧跟另一个模块的文件头标记：
  // 先看「下一个函数」，再看「下一个模块标记」，谁近就用谁，免得多读进别的模块的同名调用。
  const nextFn = rest.indexOf('\nasync function ');
  const nextModule = rest.indexOf('\n// ===== ');
  const candidates = [nextFn, nextModule].filter((n) => n > 0);
  const end = candidates.length ? Math.min(...candidates) : -1;
  const body = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(!/egoCloseAccount\s*\(/.test(body), '「完成」里不该再调用 egoCloseAccount —— 那会把用户看得见的空间收掉');
  assert.match(body, /keptSpace: true/, '要明确告诉界面「空间留着没关」');
  assert.match(body, /pendingLogin\s*[:=]\s*false/, '登录成功要清掉「等待登录」标记');
  // 界面提示也要按后端分开说，不能对 ego 用户撒谎说「窗口已关闭」
  const cliSrc = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
  assert.match(cliSrc, /r\.keptSpace \?/, '提示语要区分「空间留着」与「窗口已关闭」');
});

// ── 3.8 v0.8.0 ego 后端缺陷修复（全部是源码/路由契约，绝不起浏览器） ────────

section('3.8 v0.8.0 ego 后端修复（不拉起浏览器 / 不抢用户窗口 / 不串号）');

// clientSrc 正片段在 section 4 里才声明，这里单独读一份，避免 TDZ（Cannot access before initialization）。
const clientSrcV8 = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

await test('ego 没在运行时不去起 CLI（否则整个浏览器会被拉起来）', () => {
  assert.match(egoSrc, /export function egoAppRunning/, '要有「ego 主程序在不在跑」的探测');
  assert.match(egoSrc, /ego_not_running/, '不在跑时要返回专门的 code');
  assert.match(egoSrc, /LAUNCH_ALLOWED/, '只有少数 op（打开/重置）允许顺带拉起 ego');
  const runStart = egoSrc.indexOf('export function runEgoOp');
  assert.ok(runStart > 0, '找不到 runEgoOp');
  const body = egoSrc.slice(runStart, runStart + 2500);
  assert.ok(/egoAppRunning/.test(body), 'runEgoOp 开头就要判 ego 主程序在不在跑');
  // 宿主侧：/state 与 /config 都要把 running 报给界面
  assert.match(indexSrc, /running: false/, 'ego 没在跑时状态里要如实写 running:false');
  assert.match(indexSrc, /egoInfoSync[\s\S]{0,600}running/, '同步兜底也要带 running 字段');
});

await test('POST /ego/start 只拉起主程序，界面有「启动 ego」按钮', () => {
  assert.match(indexSrc, /p === '\/ego\/start'/, '要有 /ego/start 路由');
  const seg = indexSrc.slice(indexSrc.indexOf("p === '/ego/start'"), indexSrc.indexOf("p === '/ego/start'") + 900);
  assert.match(indexSrc, /egoLaunchApp/, '要用 egoLaunchApp（detached 拉起主程序），不是用 CLI 读状态顺带拉起');
  assert.match(clientSrcV8, /'启动 ego'/, 'ego 没在跑时界面上要有「启动 ego」按钮');
  assert.match(clientSrcV8, /api\('\/ego\/start'/, '按钮要真的打这个路由');
});

await test('同一个店铺的动作串行化（定时检测撞上手动操作时不能互抢空间）', () => {
  assert.match(indexSrc, /function acquireAccountLock/, '要有可手动取的锁');
  assert.match(indexSrc, /function withAccountLock/, '要有包装 helper');
  const routeSeg = indexSrc.slice(indexSrc.indexOf('const lockable'), indexSrc.indexOf('const lockable') + 700);
  assert.match(routeSeg, /releaseLock/, '路由层要取锁并用 finally 放锁');
  assert.ok(routeSeg.includes("'open'") && routeSeg.includes("'check'") && routeSeg.includes("'finish'"),
    '打开/检测/完成这些会碰 ego 的动作都要在锁的名单里');
  // 定时检测也必须走同一把锁：锁被手动操作占着就跳过，不能两个 CLI 同时对同一空间 takeOver
  const tickSeg = indexSrc.slice(indexSrc.indexOf('async function tickSchedule'), indexSrc.indexOf('async function tickSchedule') + 7000);
  assert.match(tickSeg, /acquireAccountLock\(/, '定时检测要抢同一把锁');
  assert.match(tickSeg, /wait: false/, '抢不到锁就跳过（不能把定时任务排在手动作后面干等）');
  // 抢到锁之后才记账：预检跳过（ego 没开 / 浏览器开着 / 正在手动操作）不能消耗掉这个时间点
  assert.ok(tickSeg.indexOf('acquireAccountLock(') < tickSeg.indexOf('markRan('),
    '记账要在抢到锁之后（否则被跳过的店铺当天就再也不检测了）');
});

await test('ego 关着也能后台检测：无窗口实例读 cookie（不弹窗 / 不留进程 / 串行化）', () => {
  const tickStart = indexSrc.indexOf('async function tickSchedule');
  const tickNextFn = indexSrc.indexOf('\nasync function ', tickStart + 1);
  const tickNextExportFn = indexSrc.indexOf('\nexport async function ', tickStart + 1);
  const tickNextModule = indexSrc.indexOf('\n// ===== ', tickStart);
  const tickCands = [tickNextFn, tickNextExportFn, tickNextModule].filter((i) => i > tickStart);
  const tickEnd = tickCands.length ? Math.min(...tickCands) : tickStart + 7000;
  const tickSeg = indexSrc.slice(tickStart, Math.min(tickEnd, tickStart + 7000));
  assert.ok(!/ego lite 没在运行/.test(tickSeg), '定时检测不该再拿「ego 没在跑」当跳过理由');
  const checkSeg = indexSrc.slice(indexSrc.indexOf('async function egoCheckAccount'), indexSrc.indexOf('async function egoCheckAccount') + 4500);
  assert.match(checkSeg, /egoOfflineCookies/, 'ego 关着时要走无窗口实例后台读 cookie');
  assert.match(egoSrc, /export async function egoOfflineCookies/, 'ego.mjs 要有后台读 cookie 的实现');
  assert.match(egoSrc, /--headless=new/, '必须无窗口（不能弹窗、不能恢复上次的窗口）');
  assert.match(egoSrc, /--profile-directory=/, '要指定店铺自己的 profile（登录态按 profile 隔离）');
  assert.match(egoSrc, /waitPortGone/, '读完要确认实例真的关掉了');
  assert.match(egoSrc, /taskkill|killPidTree/, '端口没消失就按 PID 树强杀，别留后台进程（v0.10.0 起经平台层 killPidTree）');
  assert.match(egoSrc, /offlineChain/, '同一个 User Data 同时只能一个实例（SingletonLock），必须串行化');
  assert.match(egoSrc, /ego-running|ego_running/, 'ego 正开着时不要撞 SingletonLock（交给临时空间探测）');
});

await test('ego 模式下店铺重名要挡掉（重名 = 两个店铺共用一个空间 = 登录态串台）', () => {
  const anchor = indexSrc.indexOf('const dup = loadAccounts().find');
  assert.ok(anchor > 0, '新建账号时没有查重');
  const createSeg = indexSrc.slice(anchor - 400, anchor + 900);
  assert.match(createSeg, /backendFor\(cfg\) === 'egolite'/, '只在 ego 模式拦（Chrome 模式不占空间名）');
  assert.match(indexSrc, /已经有同名店铺「\$\{nextName\}」/, '改名也要查重');
  assert.match(indexSrc, /egoSpace = ''/, '改名后要清掉旧的空间名，让他按新名字重找');
});

await test('显式指定的 ego profile 不存在时要重新分配，而不是永久打不开', () => {
  const seg = indexSrc.slice(indexSrc.indexOf('async function ensureEgoProfile'), indexSrc.indexOf('async function ensureEgoProfile') + 3000);
  assert.match(seg, /ego-profile-gone/, 'profile 被删了要留一条调试记录');
  assert.match(seg, /profiles\.some|profiles\.find/, '要真的去 profile 列表里核对还在不在');
  assert.match(seg, /ego lite 没在运行/, 'ego 没在跑时要把话说清楚，别静默失败');
});

await test('重置登录态按平台域名删 cookie，不再整仓清空（会连坐清掉别的店铺）', () => {
  assert.match(egoSrc, /Network\.deleteCookies/, '要按域名逐个删');
  assert.match(egoSrc, /wholeJar/, '全都删不掉时才回退整仓清空，并把这件事报出来');
  const hostSeg = indexSrc.slice(indexSrc.indexOf('async function egoResetAccount'), indexSrc.indexOf('async function egoResetAccount') + 2000);
  assert.match(hostSeg, /cookieDomains/, '调用方要传平台域名');
});

await test('ego 的 TaskSpace 允许按 id 认（用户自建空间 name 是空串、id 是 0，只能靠 id 兜底）', () => {
  assert.match(egoSrc, /function findEntry/, '要有按名字/id 找空间的函数');
  const seg = egoSrc.slice(egoSrc.indexOf('function findEntry'), egoSrc.indexOf('function findEntry') + 900);
  assert.match(seg, /Number\(spaceId\) > 0/, 'id=0 是用户自建空间的占位，不能拿来匹配');
  assert.match(indexSrc, /egoSpaceExists\(space, a\.egoSpaceId\)|egoSpaceExists\(egoSpace, a\.egoSpaceId\)/, '/state 也要带 id 去认空间');
  assert.match(indexSrc, /egoSpaceId: Number\(a\.egoSpaceId\) \|\| 0/, '账号行要带 egoSpaceId 给界面/工具');
});

await test('ego 模式重名店铺真的会被 400 挡掉（路由级实测，不只是源码断言）', async () => {
  const cli = EG.resolveEgoCli('');
  await call('PUT', '/shop-accounts/config', { browser: cli ? 'egolite' : 'auto' });
  const first = await call('POST', '/shop-accounts/accounts', { loginName: 'u6', password: 'Test-P@ss1', platform: 'pdd', name: '重名测试店' });
  assert.equal(first.status, 200, '第一家应该建得出来');
  const second = await call('POST', '/shop-accounts/accounts', { loginName: 'u7', password: 'Test-P@ss1', platform: 'pdd', name: '重名测试店' });
  if (cli) {
    assert.equal(second.status, 400, 'ego 模式下重名必须被拒绝');
    assert.match(String(second.json.error || ''), /同名店铺/, '错误里要说是重名，而不是含糊的失败');
  } else {
    assert.equal(second.status, 200, 'Chrome 模式不占空间名，允许重名 —— 老行为不能变');
  }
  // /state 里每个账号都要带 egoSpaceId（界面/工具靠它认空间）
  const st = await call('GET', '/shop-accounts/state');
  const rows = st.json.accounts.filter((a) => a.name === '重名测试店');
  assert.ok(rows.length >= 1);
  assert.equal(typeof rows[0].egoSpaceId, 'number', '/state 的账号行要带 egoSpaceId');
  for (const r of rows) await call('DELETE', '/shop-accounts/accounts/' + r.id, {});
  await call('PUT', '/shop-accounts/config', { browser: 'auto' });
});

await test('万一控制权没交还成功，有 /accounts/:id/handoff 可以手动补救', () => {
  assert.match(indexSrc, /open\|close\|reset\|finish\|check\|reveal\|silent-check\|handoff\|schedule/, '动作路由里要有 handoff');
  const seg = indexSrc.slice(indexSrc.indexOf("action === 'handoff'"), indexSrc.indexOf("action === 'handoff'") + 900);
  assert.match(seg, /egoHandOff/, '要真的调 egoHandOff 去交还');
  assert.match(seg, /Chrome 后端没有/, 'Chrome 后端要明确拒绝（没有这个概念）');
  assert.match(seg, /appendDebug\('handoff'/, '要留一条调试记录，方便事后查为什么没交还');
});

await test('账号锁真并发下是互斥的（wait:false 直接让路，排队的逐个拿到，不会卡死）', async () => {
  const seq = [];
  // 1) 先占住
  const release1 = await host.acquireAccountLock('lock-test-shop');
  assert.equal(typeof release1, 'function', '拿锁要返回 release');
  // 2) wait:false 应该立刻拿到 null（定时检测走这条，抢不到就跳过）
  const noWait = await host.acquireAccountLock('lock-test-shop', { wait: false });
  assert.equal(noWait, null, '锁被占时 wait:false 必须返回 null，不能等');
  // 3) 三个排队的：放锁后必须**逐个**拿到，不能同时拿到
  const waiters = [0, 1, 2].map(() => host.acquireAccountLock('lock-test-shop').then((rel) => {
    seq.push('in');
    return new Promise((r) => setTimeout(() => { seq.push('out'); rel(); r(); }, 5));
  }));
  setTimeout(() => { release1(); }, 10);
  await Promise.all(waiters);
  assert.deepEqual(seq, ['in', 'out', 'in', 'out', 'in', 'out'], '排队的必须一次一个，不能并发进临界区');
  // 4) 全部放完后再拿一次仍然拿得到（锁没漏留成死锁）
  const again = await host.acquireAccountLock('lock-test-shop', { wait: false });
  assert.equal(typeof again, 'function', '放完锁之后必须能再拿到（不能留下僵尸锁）');
  again();
});

// ── 3.9 v0.8.1 代码审查修掉的坑（每条都对应一个真实会踩到的场景）────────────────

section('3.9 v0.8.1 审查修复（不建空窗口 / 失败不覆盖登录态 / 锁不泄漏 / 界面不重置）');

// 客户端源码在这一段之后才有变量（第 4 节才定义 clientSrc），这里用一个局部读取
const clientSrcV81 = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
const clientSrcOrLoad = () => clientSrcV81;

await test('ego「关闭 / 交还控制权」不许为了关闭而先建一个空间出来', () => {
  assert.match(egoSrc, /if \(!entry && \(op === 'close' \|\| op === 'handoff'\)\)/,
    '空间不在就直接 alreadyClosed；否则每点一次关闭就多一个 agent 占着的空窗口（还会串到默认 profile）');
  const closeIdx = egoSrc.indexOf("if (op === 'close')");
  const guardIdx = egoSrc.indexOf("if (!entry && (op === 'close' || op === 'handoff'))");
  assert.ok(guardIdx >= 0 && guardIdx < closeIdx, '守卫要在创建句柄（acquire）之前');
});

await test('检测失败（ok:false）不覆盖上一次的登录结论，只记 lastCheckError', () => {
  assert.match(indexSrc, /function checkPatch\(check/, '要有统一的"结果→patch"收敛点');
  assert.match(indexSrc, /check\.ok === false/, '要认出"这次没测成"');
  assert.match(indexSrc, /lastCheckError/, '失败要单独记，不能写成 loggedIn:false');
  // 三处入口（定时检测 / 检测路由 / 完成保存）都得走它
  assert.ok((indexSrc.match(/checkPatch\(/g) || []).length >= 4, '至少要覆盖 定时检测 / 检测 / 完成 三条路径');
  assert.ok(clientSrcOrLoad().includes('lastCheckError'), '界面要能显示"检测失败"，而不是被判成登录失效');
});

await test('ego 没在运行时，「打开 / 重置」能把它拉起来（白名单真的可达）', () => {
  assert.match(indexSrc, /async function ensureEgoApp/, '要有"需要开窗口时才拉起 ego"的入口');
  assert.match(indexSrc, /egoRunInfo\(account, \{ launch: true \}\)/, 'open / reset 要允许拉起');
  const n = (indexSrc.match(/egoRunInfo\(account, \{ launch: true \}\)/g) || []).length;
  assert.ok(n >= 2, 'open 和 reset 两个动作都要（实际 ' + n + ' 处）');
  assert.match(indexSrc, /opts\.launch/, '只读动作（检测/关闭）不许拉起');
});

await test('请求体读一半客户端断开时，账号锁不会永久泄漏', () => {
  assert.match(indexSrc, /req\.on\('aborted'/, '要兜底 aborted');
  assert.match(indexSrc, /req\.on\('close'/, '要兜底 close');
});

await test('改名不会清掉用户手填的 egoSpace（比较对象是派生名）', () => {
  assert.match(indexSrc, /const derived = '店铺-'/, '要拿派生名比较');
  assert.ok(!/=== spaceNameFor\(account\)/.test(indexSrc), '不能拿 spaceNameFor 比（egoSpace 非空时它返回自己，条件恒真）');
});

await test('删账号时要把 ego 空间也收掉（别在 ego 里留孤儿窗口）', () => {
  const delSeg = indexSrc.slice(indexSrc.indexOf("method === 'DELETE'"), indexSrc.indexOf("method === 'DELETE'") + 900);
  assert.match(delSeg, /egoCloseAccount/, 'ego 后端删除账号要先收空间');
});

await test('agent 工具 list 的 index 用全表下标（带 platform 过滤时不指错店铺）', () => {
  assert.match(indexSrc, /fullIndex/, '过滤后的下标会让「店铺B」指到别的店');
});

await test('/state 在 Chrome 模式下并发探测端口（店铺多时不至于比轮询还慢）', () => {
  assert.match(indexSrc, /const portUp = new Map\(\)/, '要先并发探一遍端口');
  assert.match(indexSrc, /Promise\.all\(ports\.map/, '端口探测要并发');
});

await test('Chrome 后端运行中检测：优先用"本平台且不像登录页"的标签页 URL', () => {
  assert.match(indexSrc, /async function pickSiteUrl/, '多标签时要挑页面，不能拿第一个 https 标签');
  assert.match(indexSrc, /readLoginFrom\(port, platform, await pickSiteUrl/, '运行中分支要传 preferUrl');
  assert.match(indexSrc, /looksLikeLoginPage/, '要排除登录页标签');
});

await test('设置面板不能被父级轮询反复卸载重建（输入被回填、高级选项自动收起）', () => {
  assert.ok(clientSrcOrLoad().indexOf('function ConfigPanel') < clientSrcOrLoad().indexOf('function ShopAccountsSection'),
    'ConfigPanel 必须定义在 ShopAccountsSection 之外（否则每次重渲染都换组件身份）');
  assert.match(clientSrcOrLoad(), /h\(ConfigPanel, \{[^}]*cfg: cfg/, '渲染处要用 props 传配置');
});

await test('详情页端口为 0 时不再渲染出字面量 0；排期弹窗不会把"自动每组数"回填成手填值', () => {
  assert.ok(!/a\.port && h\('span'/.test(clientSrcOrLoad()), '0 && … 会被 React 当文本渲染出来');
  assert.match(clientSrcOrLoad(), /groupSizeMode === 'auto'/, '自动模式要显示成空，不能回填解析后的数字');
});

// ── 4. 客户端 bundle 契约 ────────────────────────────────────────────────────

section('4. 客户端 bundle 契约 lib/client.js');

const clientSrc = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

await test('只 require 平台种子模块（这里只允许 react）', () => {
  const names = [...clientSrc.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
  assert.deepEqual([...new Set(names)], ['react'], '实际 require 了：' + JSON.stringify(names));
});

await test('BASE 与宿主路由前缀一致（两边写死，必须靠自检绑住）', () => {
  const m = clientSrc.match(/var BASE = '([^']+)'/);
  assert.ok(m, '客户端里没找到 BASE');
  assert.equal(m[1], registered[0].path);
});

await test('客户端 webServer 面只打自己这个前缀，没有裸 fetch 到别处', () => {
  const hits = [...clientSrc.matchAll(/fetch\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.ok(hits.length >= 1, '居然没有 fetch —— api() 不见了？');
  for (const h of hits) assert.match(h, /^BASE \+/, '这个 fetch 没走 BASE：' + h);
});

await test('组件一律用 h(Component) 渲染，不能当普通函数调用（会算进父组件 hook 表 → 一点开就 Rendered more hooks 白屏）', () => {
  for (const c of ['Toast', 'Field', 'AccountDialog', 'AccountDetail', 'ConfigPanel', 'ScheduleDialog']) {
    const bare = new RegExp('(?<!function )(?<![\\w.])' + c + '\\s*\\(').exec(clientSrc);
    assert.equal(bare, null, c + ' 被当普通函数调用了：' + (bare ? bare[0] : ''));
  }
});

await test('__ModuleLoader__.load 的 id = 包名，factory 返回 exports 三件套', () => {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { captured = entry; } } },
    setTimeout, setInterval, clearInterval, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(clientSrc, sandbox);
  assert.ok(captured, '没有调用 __ModuleLoader__.load');
  assert.equal(captured.id, pkg.name);

  const ReactStub = {
    createElement: (...args) => ({ type: args[0], props: args[1] || {} }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
  };
  const mod = captured.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error('客户端 require 了不该 require 的模块：' + name);
  });
  assert.equal(mod.name, pkg.name);
  assert.deepEqual(Array.from(mod.inject), ['slots']);
  assert.equal(typeof mod.apply, 'function');

  const injections = [];
  const slotRegs = [];
  mod.apply({
    slots: {
      inject: (name, cb) => { injections.push(name); return cb(); },
      register: (opts, Comp) => { slotRegs.push({ opts, Comp }); return () => {}; },
    },
  });
  assert.deepEqual(injections, ['settings.section']);
  assert.equal(slotRegs.length, 1);
  const { opts, Comp } = slotRegs[0];
  assert.equal(opts.name, 'settings.section');
  assert.equal(opts.id, 'shop-accounts');
  assert.equal(typeof opts.order, 'number');
  assert.equal(typeof opts.label, 'string');
  assert.equal(opts.label, '账号管理');
  const rendered = Comp();
  assert.ok(rendered && typeof rendered.type === 'function', '注册的组件工厂没给出页面组件');
});

await test('「更新到最新」按钮只在检测出有新版本时才可点（没检测/检测失败/已最新都灰着）', () => {
  // 把客户端里那句可用性判断原样取出来跑 —— 免得测试自己另写一份逻辑，跟实现一起跑偏。
  const m = clientSrc.match(/var canApply = (Boolean\(updInfo[^;]*\));/);
  assert.ok(m, '客户端里找不到 canApply 的可用性判断');
  const canApply = new Function('updInfo', 'return ' + m[1]);

  assert.equal(canApply(null), false, '还没检测过 → 不能点');
  assert.equal(canApply(undefined), false, '还没检测过 → 不能点');
  assert.equal(canApply({ ok: false, error: '更新源目录不是 git 仓库' }), false, '检测失败 → 不能点');
  assert.equal(canApply({ ok: true, upToDate: true, needsUpdate: false }), false, '已是最新 → 不能点');
  assert.equal(canApply({ ok: true, needsUpdate: true, behind: 2 }), true, '落后 2 个提交 → 才能点');
  assert.equal(canApply({ ok: true, needsUpdate: true, remoteVersion: '0.9.0' }), true, 'GitHub 版本更新 → 才能点');

  assert.ok(/disabled: Boolean\(updBusy\) \|\| !canApply/.test(clientSrc), '更新按钮要同时受 busy 和 canApply 约束');
  assert.ok(
    /function runUpd\(\) \{[\s\S]{0,400}?needsUpdate\)\) return;/.test(clientSrc),
    '更新动作本身也要挡一道 —— 别只靠 disabled，按钮灰着但函数还能被调',
  );
});

await test('列表 6 列对齐 / 弹窗不透明 / 预览列表不被压扁 / 行可拖拽（真机截图里踩过的坑）', () => {
  // 去掉 // 注释再断言：注释里会提到不该用的旧写法（比如 menu-surface-fill），别被它误伤。
  const src = clientSrc.replace(/\/\/[^\n]*/g, '');
  const pick = (re) => {
    const m = src.match(re);
    assert.ok(m, '客户端里找不到：' + re);
    return m[0];
  };
  // ① 行里现在渲染 6 个格子（店铺名/平台/定时检测/登录状态/调试端口/操作），网格也必须是 6 列。
  //    少一列的话第 6 格会换行，整张表错位 —— 上一版就是这个症状。
  pick(/grid-template-columns:minmax\(120px,1\.6fr\) 54px minmax\(96px,1fr\) minmax\(84px,1fr\) 60px 132px/);
  // ② 弹窗底色绝对不能用 --dsw-menu-surface-fill：它是**带 alpha 的菜单底色**
  //    （浅色 #f8f9fa94 / 深色 #43454a73），弹窗会把底下列表透上来，字叠一起看不清。
  const dialog = pick(/\.sa-dialog\{[\s\S]*?\}/);
  assert.ok(!/dsw-menu-surface-fill/.test(dialog), '弹窗底色必须不透明，不能用 menu-surface-fill');
  assert.ok(/dsw-alias-bg-base/.test(dialog), '弹窗底色要用实色的 --dsw-alias-bg-base');
  // ③ 弹窗正文自己滚、按钮固定在底部；预览列表不许被 flex 压成一条线（以前压到 4px，行全看不见）。
  assert.ok(/\.sa-dialog\{[\s\S]*?overflow:hidden/.test(dialog), '弹窗本体不滚，交给正文滚，否则底部按钮会被挤出视野');
  assert.equal((clientSrc.match(/className: 'sa-dialog-body'/g) || []).length, 2, '两个弹窗都要包一层可滚动的正文区');
  assert.ok(/\.sa-plist\{[^}]*flex:0 0 auto/.test(clientSrc), '预览列表不能被 flex-shrink 压扁');
  assert.ok(/\.sa-scroll\{[^}]*flex:0 0 auto/.test(clientSrc), '滚动区不能被 flex-shrink 压扁');
  // ④ 排期预览要能拖拽排序：行上必须挂 drag 事件（HTML5 drag&drop），并且有拖拽手柄。
  assert.ok(/onDragStart/.test(clientSrc), '预览行要挂 onDragStart');
  assert.ok(/onDrop/.test(clientSrc), '预览行要挂 onDrop');
  assert.ok(clientSrc.includes("'⠿'"), '预览行要显示拖拽手柄 ⠿');
  assert.ok(/function reorder\(from, to\)/.test(clientSrc), '拖拽必须走统一的 reorder');
  // ⑤ 只留拖拽：预览行不许再有 ↑↓ 按钮；拖动中的那行不许变透明（用户点名要「不透明」）。
  assert.ok(!/sa-pmove/.test(src), '预览行不该再有 ↑↓ 按钮的结构/样式');
  assert.ok(!/'↑'|'↓'/.test(src), '预览行不该再渲染上下箭头按钮');
  assert.ok(!/data-drag="1"\]\{[^}]*opacity:(?:0(?:\.\d+)?|\.\d+)/.test(src), '拖起来的行不能靠半透明表达（opacity 只能是 1）');
  assert.ok(/data-drag="1"\]\{[^}]*background:/.test(src), '拖起来的行要实底高亮');
  assert.ok(/setDragImage/.test(clientSrc), '要设空拖影（setDragImage），否则浏览器会画半透明浮层');
  // ⑥ 窄面板（用户窗口窄时真机截图里右侧「操作」列直接跑出屏幕）：表格要按自身宽度收列，不能硬撑 660px。
  assert.ok(/\.sa-list\{[^}]*container-type:inline-size/.test(src), '表格容器要能按自身宽度做 container query');
  assert.ok(/@container \(max-width:700px\)/.test(src), '窄的时候要少一列，否则整页横向滚动');
  assert.ok(/\.sa-c-port\{display:none;?\}/.test(src), '窄的时候把「调试端口」列收起来');
  assert.ok(/className: 'sa-c-port'/.test(clientSrc), '端口列的格子要有 sa-c-port 类，隐藏才能命中');
  assert.ok(/sa-port-inline/.test(clientSrc), '收起来的端口要并到店铺名下面那行显示，别丢信息');
  // ⑦ 小字对比度：浅色主题 --dsw-alias-label-caption = #adb2b8（对白底约 2:1，用户说「看不清」），
  //    改用 --dsw-alias-label-secondary（浅色 #61666b ≈5.8:1，深色 #cfd3d6 也够）。别再换回 caption。
  assert.ok(!/--dsw-alias-label-caption/.test(src), '说明性小字要用 label-secondary，不能用 caption（浅色主题下几乎看不见）');
  assert.ok(/--dsw-alias-label-secondary/.test(src), '小字颜色要走 label-secondary');
  // ⑧ 行里「详细配置」要和上面的排期胶囊对齐居中（需求：不居中太奇怪）。
  assert.ok(/\.sa-schedcell\{[^}]*align-items:center/.test(src), '定时检测列的胶囊和链接要居中');
  // ⑨ 顶部排期横幅按参考软件的样子：左边两行（粗标题 + 淡说明）、右边一个描边胶囊按钮、整体一行不折行。
  assert.ok(/\.sa-schedbar\{[^}]*justify-content:space-between/.test(src), '横幅要左右两端对齐（文字在左、按钮在右）');
  assert.equal(/\.sa-schedbar\{[^}]*flex-wrap:wrap/.test(src), false, '横幅不该折行，按钮要跟文字同一行（参考图就是一行）');
  assert.ok(/\.sa-schedmain\{[^}]*flex-direction:column/.test(src), '横幅左侧文字要是上下两行');
  assert.ok(/\.sa-schedsub\{[^}]*label-secondary/.test(src), '第二行说明要用淡一点的颜色');
  assert.ok(/\.sa-schedpill\{[^}]*border-radius:999px/.test(src), '「调整排期」要是胶囊按钮');
  assert.ok(/'sa-schedpill', onClick: function \(\) \{ setSchedOpen\(true\); \}/.test(clientSrc), '横幅上的「调整排期」要用胶囊样式');
  // 第二行文案是用户照参考软件给的原文，不许再改回长句；「下次 …」也不许再塞进来（那样就三行了）。
  assert.ok(clientSrc.includes("'适用于全部店铺，含已暂停任务；错过时间不补跑。'"), '横幅第二行要用参考原文');
  assert.equal(/\.sa-schedsub'[^)]*[^)]*下次 /.test(clientSrc), false, '「下次 …」不该在第二行里，应放悬停提示');
  // ⑩ 数字输入：用 type=number（浏览器自带上下箭头 + 过滤），但**不要再加自定义 −/+ 按钮**
  //    （v0.6.3 加过，用户嫌「又有上下又有加减」，v0.6.4 去掉了）。
  assert.ok(/function NumberField\(props\)/.test(clientSrc), '数字输入要有个统一的 NumberField');
  assert.ok(/type: 'number'/.test(clientSrc), '数字框用 type=number 交给浏览器过滤（自己 replace 会吞掉全角数字）');
  assert.equal(/sa-numbtn/.test(clientSrc), false, '数字框旁边不该再有自定义 − / + 按钮');
  assert.equal(/'−'/.test(clientSrc), false, 'NumberField 里不该再渲染加减号按钮');
  assert.ok(/h\(NumberField, \{\s*value: size/.test(src), '「每组店铺数」必须走 NumberField');
  // ⑪ 行内「开启·12:00」胶囊不许带 title 悬停提示（用户嫌浮一层说明文字挡视线；说明留在弹窗里）。
  assert.equal(clientSrc.includes('到点自动做一次静默检测'), false, '行内定时胶囊不该再有悬停提示文案');
});

await test('账号管理页在「有排期数据」时也能渲染出来：横幅 / 定时检测列 / 调整排期弹窗', () => {
  // 用桩 React 把整页"渲"一遍（不碰浏览器、不碰 DOM）：只验证组件树不炸、关键文案在。
  // 第一个 useState 喂进假的 /state 数据，第八个（schedOpen）喂 true 让弹窗也渲一次。
  function renderPage({ withDialog }) {
    let captured = null;
    const sandbox = {
      window: { __ModuleLoader__: { load: (entry) => { captured = entry; } } },
      setTimeout, setInterval, clearInterval, console,
    };
    vm.createContext(sandbox);
    vm.runInContext(clientSrc, sandbox);
    let usCalls = 0;
    const fakeState = {
      loading: false,
      error: null,
      data: {
        version: '0.5.0', updateDir: '', dataDir: 'C:\\tmp', platforms: [],
        schedule: {
          enabled: true, startTime: '09:05', groupIntervalMin: 30, groupSize: 1,
          groupSizeMode: 'manual', autoGroupSize: 1, memGB: 16, nextRunAt: '2026-10-19T01:05:00.000Z',
          nextTime: '09:05', lastDay: '', canRun: true,
          rows: [
            { id: 'a1', name: '排期店A', platform: 'pdd', time: '09:05', group: 0, slotMinutes: 545, enabled: true, active: true },
            { id: 'a2', name: '排期店B', platform: 'taobao', time: '09:35', group: 1, slotMinutes: 575, enabled: false, active: false },
          ],
        },
        accounts: [
          {
            id: 'a1', name: '排期店A', platform: 'pdd', port: 9222, running: false, schedEnabled: true,
            schedTime: '09:05', lastSchedAt: null, lastSchedError: '', lastLoginAt: null, lastCheckAt: null, lastCheck: null,
          },
          {
            id: 'a2', name: '排期店B', platform: 'taobao', port: 9223, running: false, schedEnabled: false,
            schedTime: '09:35', lastSchedAt: null, lastSchedError: '无头检测失败：超时', lastLoginAt: '2026-10-18T01:00:00.000Z',
            lastCheckAt: '2026-10-19T01:00:00.000Z', lastCheck: { loggedIn: false, evidence: 'login-page', reason: '登录已失效，请重新登录' },
          },
        ],
      },
    };
    const ReactStub = {
      createElement: (type, props, ...kids) => ({
        type,
        props: Object.assign({}, props || {}, { children: kids.length === 1 ? kids[0] : kids }),
      }),
      useState: (init) => {
        usCalls += 1;
        if (usCalls === 1) return [fakeState, () => {}];
        if (usCalls === 8 && withDialog) return [true, () => {}];
        return [typeof init === 'function' ? init() : init, () => {}];
      },
      useEffect: () => {},
      useRef: (init) => ({ current: init }),
      useCallback: (fn) => fn,
    };
    const mod = captured.factory((name) => {
      if (name === 'react') return ReactStub;
      throw new Error('客户端 require 了不该 require 的模块：' + name);
    });
    let Comp = null;
    mod.apply({
      slots: {
        inject: (name, cb) => cb(),
        register: (opts, C) => { Comp = C; return () => {}; },
      },
    });
    const tree = Comp();
    const texts = [];
    (function walk(node, depth) {
      if (node == null || node === false || node === true || depth > 40) return;
      if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
      if (Array.isArray(node)) { for (const n of node) walk(n, depth); return; }
      if (typeof node !== 'object') return;
      if (typeof node.type === 'function') { walk(node.type(node.props || {}), depth + 1); return; }
      walk(node.props ? node.props.children : null, depth + 1);
    })(tree, 0);
    return { tree, text: texts.join(' | ') };
  }

  const page = renderPage({ withDialog: false });
  assert.ok(!/render-error/.test(page.text), '页面渲染抛错了：' + page.text.slice(0, 400));
  for (const want of ['定时采集', '调整排期', '每天 09:05 起 · 每组 1 个店铺，组间隔 30 分钟', '开启·09:05', '暂停·09:35', '上次失败']) {
    assert.ok(page.text.includes(want), '列表页少了「' + want + '」：' + page.text.slice(0, 500));
  }

  const dlg = renderPage({ withDialog: true });
  assert.ok(!/render-error/.test(dlg.text), '弹窗渲染抛错了：' + dlg.text.slice(0, 400));
  for (const want of ['调整排期', '每日起始时间', '组间隔（分钟）', '每组店铺数', '开启定时采集', '保存排期', '取消']) {
    assert.ok(dlg.text.includes(want), '弹窗少了「' + want + '」');
  }
});

await test('Chrome 模式下设置页不出现 ego 专属 UI，ego 模式下才出现（用户问：用谷歌也会显示 ego lite 吗）', () => {
  // 真把设置卡渲一遍（桩 React + 一个迷你 hook 运行时，不碰 DOM），再按后端看渲染出来的文案。
  // 为什么要迷你 hook：ConfigPanel 的表单是 useEffect 里填的，`if (!form) return null` ——
  // 只把 useState 打桩、不跑 effect，渲出来是空的，测了个寂寞。
  function renderSettings({ backend, egoAvailable }) {
    const patched = clientSrc.replace(
      'var [showConfig, setShowConfig] = React.useState(false);',
      'var [showConfig, setShowConfig] = React.useState(true);');
    assert.notEqual(patched, clientSrc, '没找到 showConfig 的 useState —— 改过就同步改这个测试，否则它测的是没展开的设置页');
    let captured = null;
    const sandbox = {
      window: { __ModuleLoader__: { load: (entry) => { captured = entry; } } },
      setTimeout, setInterval, clearInterval, clearTimeout, console,
      // 页面里的 effect 会去 api('/state') 拉数据；给它一个空的成功响应，别让测试等网络。
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } }),
      document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, createElement: () => ({ style: {}, appendChild() {} }) },
      navigator: { userAgent: 'smoke' },
      location: { href: 'http://127.0.0.1/', search: '' },
    };
    vm.createContext(sandbox);
    vm.runInContext(patched, sandbox);
    const fakeState = {
      loading: false, error: null,
      data: {
        version: '0.7.6', loadedVersion: '0.7.6', updateDir: '', dataDir: 'C:\\tmp',
        platforms: [], accounts: [], backend,
        config: {},
        ego: {
          available: egoAvailable, cli: 'C:\\tmp\\ego-browser.exe',
          profiles: [{ id: 'Profile 3', name: '用户配置 1', isDefault: false }],
        },
        browser: { found: true, path: 'C:\\tmp\\chrome.exe' },
      },
    };
    // ── 迷你 hook 运行时：每个组件按路径存槽位，渲染后跑 effect，状态变了就再渲一遍 ──
    const hookStore = new Map();
    let HOOK = null;
    let dirtyAny = false;
    const ReactStub = {
      createElement: (type, props, ...kids) => ({
        type, props: Object.assign({}, props || {}, { children: kids.length === 1 ? kids[0] : kids }),
      }),
      useState: (init) => {
        const ctx = HOOK;
        const key = 'us' + (ctx.us = (ctx.us || 0) + 1);
        if (!(key in ctx.slots)) ctx.slots[key] = typeof init === 'function' ? init() : init;
        return [ctx.slots[key], (v) => {
          if (ctx.slots[key] !== v) { ctx.slots[key] = v; dirtyAny = true; }
        }];
      },
      useEffect: (fn) => { HOOK.effects.push(fn); },
      useRef: (init) => {
        const ctx = HOOK;
        const key = 'ref' + (ctx.ref = (ctx.ref || 0) + 1);
        if (!(key in ctx.slots)) ctx.slots[key] = { current: init };
        return ctx.slots[key];
      },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    };
    const mod = captured.factory((name) => {
      if (name === 'react') return ReactStub;
      throw new Error('客户端 require 了不该 require 的模块：' + name);
    });
    let Comp = null;
    mod.apply({
      slots: {
        inject: (name, cb) => cb(),
        register: (opts, C) => { Comp = C; return () => {}; },
      },
    });
    const texts = [];
    function runPass() {
      texts.length = 0;
      dirtyAny = false;
      const effects = [];
      function walk(node, depth, path) {
        if (node == null || node === false || node === true || depth > 60) return;
        if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
        if (Array.isArray(node)) { node.forEach((n, i) => walk(n, depth, path + '.' + i)); return; }
        if (typeof node !== 'object') return;
        if (typeof node.type === 'function') {
          const ctx = { us: 0, ref: 0, slots: hookStore.get(path) || {}, effects: [] };
          hookStore.set(path, ctx.slots);
          const prev = HOOK;
          HOOK = ctx;
          let out;
          try { out = node.type(node.props || {}); } finally { HOOK = prev; }
          effects.push(...ctx.effects);
          walk(out, depth + 1, path);
          return;
        }
        walk(node.props ? node.props.children : null, depth + 1, path);
      }
      // 根组件本身也走一遍 hook 上下文；第一个 useState 喂假的 /state（Prom 组件里 state 是第一个）
      const rootCtx = { us: 0, ref: 0, slots: hookStore.get('root') || {}, effects: [] };
      rootCtx.slots.us1 = fakeState;
      hookStore.set('root', rootCtx.slots);
      HOOK = rootCtx;
      let tree;
      try { tree = Comp(); } finally { HOOK = null; }
      effects.push(...rootCtx.effects);
      walk(tree, 0, 'root');
      for (const fn of effects) { try { fn(); } catch { /* effect 里的 api 失败不影响文案 */ } }
    }
    for (let pass = 0; pass < 6; pass++) { runPass(); if (!dirtyAny) break; }
    return texts.join(' | ');
  }

  // ① Chrome + 装了 ego：只用 Chrome，ego 的字段/按钮/profile 列表都不该出现
  const chrome = renderSettings({ backend: 'chrome', egoAvailable: true });
  assert.ok(chrome.includes('用户浏览器'), '设置页没渲出来：' + chrome.slice(0, 300));
  assert.ok(chrome.includes('Chrome'), '胶囊要显示 Chrome');
  assert.ok(!chrome.includes('ego-browser'), 'Chrome 模式不该出现 ego-browser 路径字段');
  assert.ok(!chrome.includes('ego profile'), 'Chrome 模式不该列 ego profile（那是 ego 模式的隐私信息）');
  assert.ok(!chrome.includes('刷新 ego'), 'Chrome 模式不该有「刷新 ego」按钮');
  // v0.17.8 精简：不再写「当前用 Chrome」这类说明句，只靠胶囊 + 选项本身表达
  assert.ok(!chrome.includes('当前用 Chrome'), '不该再出现「当前用 Chrome」这类说明句');

  // ② Chrome + 没装 ego：下拉已删（v0.20.13），ego lite 那一行走扫描结果
  const noEgo = renderSettings({ backend: 'chrome', egoAvailable: false });
  assert.ok(!noEgo.includes('浏览器后端'), '不该再有「浏览器后端」下拉');
  assert.ok(!noEgo.includes('没检测到 ego lite'), '不该再出现「没检测到 ego lite」这类说明句');
  assert.ok(!noEgo.includes('ego profile'), '没装 ego 时不该有 profile 列表');

  // ③ ego 模式：该有的都要有
  const egoMode = renderSettings({ backend: 'egolite', egoAvailable: true });
  assert.ok(egoMode.includes('ego-browser'), 'ego 模式要有 ego-browser 路径字段');
  assert.ok(egoMode.includes('ego profile'), 'ego 模式要列 profile');
  assert.ok(egoMode.includes('刷新 ego'), 'ego 模式要有「刷新 ego」按钮');
  assert.ok(egoMode.includes('1 个 profile'), 'ego 模式胶囊要带 profile 数量');
  assert.ok(egoMode.includes('用户配置 1'), 'ego 模式要能看见 profile 名字（才知道分配哪个）');
});

await test('客户端打出的每个动作，宿主都真的接了（两边写歪会当场露馅）', async () => {
  // 动作名不写死在测试里，而是从客户端源码里扫出来 —— 否则「客户端加了新动作、宿主忘了加路由」
  // 这种错，测试和实现会一起错下去。
  const names = new Set();
  for (const m of clientSrc.matchAll(/act\([^,]+,\s*'([a-z][a-z-]*)'/g)) names.add(m[1]);
  for (const m of clientSrc.matchAll(/\+\s*'\/([a-z][a-z-]*)'/g)) names.add(m[1]);
  assert.ok(names.size >= 4, '至少该扫出 open/finish/close/silent-check，实际：' + [...names].join(','));

  for (const action of names) {
    // 不存在的账号却回了「账号不存在」= 路由匹配上了，只是号没了 —— 这就是路由存在的证据
    const r = await call('POST', '/shop-accounts/accounts/acc_nope_1/' + action, {});
    assert.equal(r.status, 404, action + ' 应该有对应路由');
    assert.equal(r.json.error, '账号不存在', action + ' 应该走账号级 404，而不是「未知路由」：' + r.json.error);
  }

  // 反向：宿主白名单里没有的动作必须掉进「未知路由」，不能悄悄命中别的分支
  const bogus = await call('POST', '/shop-accounts/accounts/acc_nope_1/bogus-action', {});
  assert.equal(bogus.status, 404);
  assert.match(bogus.json.error, /未知路由/);

  // 动作只收 POST（拿真账号试，才走得到方法校验那一层）
  const created = await call('POST', '/shop-accounts/accounts', { loginName: 'u8', password: 'Test-P@ss1', platform: 'taobao', name: '契约店' });
  const id = created.json.account.id;
  const wrongVerb = await call('GET', '/shop-accounts/accounts/' + id + '/open');
  assert.equal(wrongVerb.status, 405, '动作只收 POST');
  await call('DELETE', '/shop-accounts/accounts/' + id, {});
});

await test('设置页不再有「浏览器后端」下拉：用「用户浏览器」里那一行切换，保存时兜底带 browser；店铺行显示 ego 空间', () => {
  // v0.20.13：后端不再手选 —— 点 Chrome 那行写 browser=chrome + 路径。
  // v0.20.27：点 ego lite 那行改成明确写 browser=egolite（写 auto 会留着上一次的 browserPath，标记会继续显示 Chrome/Edge）。
  assert.ok(!clientSrc.includes("label: '浏览器后端'"), '不该再有「浏览器后端」下拉');
  assert.ok(!clientSrc.includes("value: 'egolite'"), '不该再有后端选项');
  assert.ok(clientSrc.includes("b.id === 'egolite'"), '行内要按类型分流（ego lite / Chrome）');
  assert.ok(clientSrc.includes("{ browser: 'egolite' }"), '点 ego lite 那行要明确切到 egolite 后端');
  assert.ok(/browser: form\.browser/.test(clientSrc), '保存设置仍然要兜底把 browser 一起发上去');
  assert.ok(/api\('\/ego'/.test(clientSrc), '「刷新 ego」按钮要走 GET /ego（否则读不到新 profile）');
  assert.ok(/egoSpace/.test(clientSrc), '店铺行/详情要显示 ego 空间名，用户才知道开的是哪个窗口');
  assert.ok(/egoliteCli/.test(clientSrc), '设置页要能填 ego-browser CLI 路径（自动探测不到时兜底）');
  // v0.17.8：用户要求「简化选项、去掉那些介绍」→ 胶囊不再挂长解释
  assert.ok(!/title: '自动 = 有 ego 就用 ego/.test(clientSrc), '后端选择的解释不该再挂在悬停提示里');
  assert.ok(!clientSrc.includes("sa-chip', title: egoText"), '胶囊不该再挂长悬停说明');
  // 用户反馈：Chrome 模式下也不该到处是 ego 字样 → ego 专属 UI 必须挂在 egoOn 上
  assert.match(clientSrc, /var egoOn = backend === 'egolite'/, '要有「当前是否真的在用 ego」这个开关');
  assert.ok(/egoOn && h\(Field, \{ label: 'ego-browser' \}/.test(clientSrc), 'ego-browser 路径只在 ego 模式下显示');
  assert.ok(/egoOn && h\(Field, \{ label: 'ego profile' \}/.test(clientSrc), 'ego profile 列表只在 ego 模式下显示');
  assert.ok(/egoOn && h\('button'/.test(clientSrc), '「刷新 ego」按钮只在 ego 模式下显示');
  assert.ok(/chipText/.test(clientSrc) && /: 'Chrome'/.test(clientSrc), '胶囊在 Chrome 模式下只能显示 Chrome，不能显示 ego lite');
  // v0.7.4：路径/端口这类少数人才改的字段收进折叠块，设置页默认只留「后端 + 生效状态」
  assert.match(clientSrc, /h\('details', \{ className: 'sa-adv'/, '要有一个折叠的高级选项块');
  assert.match(clientSrc, /h\('summary', \{ className: 'sa-advsum' \}, '路径与高级选项'\)/, '折叠块要有可点的标题');
  // 间距不能只靠 class：内联 style 兜底（样式表没跟上时也不会挤成一坨）
  assert.match(clientSrc, /className: 'sa-adv', style: advStyle/, '折叠块的内边距/间距要用内联样式兜底');
  const advGap = /var advStyle = \{[\s\S]{0,300}?gap: '(\d+)px'/.exec(clientSrc);
  assert.ok(advGap && Number(advGap[1]) >= 14, '折叠块里至少要有 14px 的行间距（现在 ' + (advGap && advGap[1]) + 'px）');
  const groupGap = /var groupStyle = \{ display: 'flex', flexDirection: 'column', gap: '(\d+)px' \}/.exec(clientSrc);
  assert.ok(groupGap && Number(groupGap[1]) >= 12, '分组内字段行距至少 12px（现在 ' + (groupGap && groupGap[1]) + 'px）');
  assert.match(clientSrc, /groupDividerStyle/, '分组之间要有发丝分隔线，别糊成一片');
  assert.match(clientSrc, /sa-group/, '路径/端口/信息要分组，别平铺成一片');
  assert.match(clientSrc, /sa-grouplabel|groupLabelStyle/, '每个分组要有小标题');
  const advAt = clientSrc.indexOf("className: 'sa-adv'");
  for (const field of ['档案根目录', '起始端口', 'Chrome / Edge', 'ego-browser']) {
    assert.ok(clientSrc.indexOf(field) > advAt, field + ' 应该收在折叠块里，不要摊在设置页外面');
  }
  assert.ok(clientSrc.indexOf('用户浏览器') < advAt, '「用户浏览器」要留在折叠块外面（最常用的那项）');
});

// ── 3.10 v0.8.3 安全加固（2026-10-31 审查） ─────────────────────────────────

section('3.10 v0.8.3 安全加固');

const chromeMod = await import(url('lib/chrome.mjs'));
const cdpMod = await import(url('lib/cdp.mjs'));
const egoMod = await import(url('lib/ego.mjs'));

await test('不再把调试端口交给任意 Origin（源码里不许再出现 remote-allow-origins 参数）', () => {
  // 注释里提到这个开关（解释为什么不用它）没关系；这里查的是"作为参数传出去"
  const asArg = /['"]--remote-allow-origins/;
  assert.ok(!asArg.test(chromeSrc), 'chrome.mjs 还在把 remote-allow-origins 传给 Chrome');
  assert.ok(!asArg.test(egoSrc), 'ego.mjs 还在把 remote-allow-origins 传给 ego');
});

await test('导航地址只收 http(s)：命令开关/其它协议一律拒绝', () => {
  assert.equal(chromeMod.safeNavUrl('https://mms.pinduoduo.com/home/'), 'https://mms.pinduoduo.com/home/');
  assert.throws(() => chromeMod.safeNavUrl('--proxy-server=http://evil:8080'), /命令行开关/);
  assert.throws(() => chromeMod.safeNavUrl('file:///C:/Windows/System32'), /http\/https/);
  assert.throws(() => chromeMod.safeNavUrl('javascript:alert(1)'), /http\/https/);
});

await test('CDP 端口/WS 地址校验：不接受 host 注入与非本机地址', () => {
  assert.equal(cdpMod.exactPort(9222), 9222);
  assert.throws(() => cdpMod.exactPort('9222@evil.com'), /不是合法端口/);
  assert.throws(() => cdpMod.exactPort(0), /不是合法端口/);
  assert.equal(cdpMod.assertLocalWs('ws://127.0.0.1:9222/devtools/page/x', 9222), 'ws://127.0.0.1:9222/devtools/page/x');
  assert.throws(() => cdpMod.assertLocalWs('ws://evil.com:9222/devtools/page/x', 9222), /不是本机地址/);
  assert.throws(() => cdpMod.assertLocalWs('ws://127.0.0.1:9333/devtools/page/x', 9222), /端口/);
});

await test('档案目录边界：只有档案根目录内的目录才允许被递归删除/打开', () => {
  const cfg = { profileRoot: path.join(TMP, 'profiles') };
  assert.equal(S.isInsideProfileRoot(path.join(TMP, 'profiles', 'acc_x'), cfg), true);
  assert.equal(S.isInsideProfileRoot(path.join(TMP, 'profiles'), cfg), false, '根目录本身不算');
  assert.equal(S.isInsideProfileRoot(path.join(TMP, 'outside'), cfg), false);
  assert.equal(S.isInsideProfileRoot(path.join(TMP, 'profiles', '..', 'outside'), cfg), false);
  assert.equal(S.isInsideProfileRoot('', cfg), false);
  // 用户改过 profileRoot 之后，默认根（<数据目录>/profiles）下的老档案也要认，
  // 否则自己的档案反而不能重置/删除
  const moved = { profileRoot: path.join(TMP, 'moved-root') };
  assert.equal(S.isInsideProfileRoot(path.join(TMP, 'data', 'profiles', 'acc_old'), moved), true);
});

await test('导入的档案目录必须是存在的绝对路径', () => {
  assert.equal(S.normalizeImportedProfileDir(TMP), path.resolve(TMP));
  assert.throws(() => S.normalizeImportedProfileDir('relative/dir'), /绝对路径/);
  assert.throws(() => S.normalizeImportedProfileDir(path.join(TMP, 'no-such-dir-xyz')), /不存在/);
  const file = path.join(TMP, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => S.normalizeImportedProfileDir(file), /不是文件夹/);
});

await test('ego profile 名称形状校验（不许路径分隔符 / .. / 换行）', () => {
  assert.equal(egoMod.normalizeEgoProfileId('Profile 1'), 'Profile 1');
  assert.throws(() => egoMod.normalizeEgoProfileId('..'), /不合法/);
  assert.throws(() => egoMod.normalizeEgoProfileId('a/b'), /不合法/);
  assert.throws(() => egoMod.normalizeEgoProfileId('a\nb'), /不合法/);
});

await test('HTTP 面：没有插件自定义头 / 跨站 / 非 JSON 写请求都被挡', async () => {
  const noHeader = await call('GET', '/shop-accounts/state', undefined, { 'x-dsh-shop-accounts': '' });
  assert.equal(noHeader.status, 403, '没有自定义头必须 403');
  assert.equal(noHeader.json.ok, false);
  const crossSite = await call('GET', '/shop-accounts/state', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403, '跨站请求必须 403');
  const plain = await call('PUT', '/shop-accounts/config', { browser: 'chrome' }, { 'content-type': 'text/plain' });
  assert.equal(plain.status, 415, '非 JSON Content-Type 必须 415（挡跨站简单请求）');
});

await test('reset / 删账号都不会递归删除档案根目录之外的目录', async () => {
  const cfgPut = await call('PUT', '/shop-accounts/config', { browser: 'chrome' });
  assert.equal(cfgPut.status, 200);
  const created = await call('POST', '/shop-accounts/accounts', { loginName: 'u9', password: 'Test-P@ss1', platform: 'pdd', name: '安全测试店-1' });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.account.id;
  const outside = fs.mkdtempSync(path.join(TMP, 'outside-'));
  const keep = path.join(outside, 'keep.txt');
  fs.writeFileSync(keep, 'keep');
  const put = await call('PUT', '/shop-accounts/accounts/' + id, { profileDir: outside });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const reset = await call('POST', '/shop-accounts/accounts/' + id + '/reset', {});
  assert.equal(reset.status, 500, '根目录外的档案目录要拒绝重置');
  assert.equal(reset.json.ok, false);
  assert.ok(fs.existsSync(keep), '根目录外的目录不能被删');
  const del = await call('DELETE', '/shop-accounts/accounts/' + id, { deleteProfile: true });
  assert.equal(del.status, 200);
  assert.equal(del.json.deletedProfile, false, '删除账号也不能删根目录外的目录');
  assert.ok(fs.existsSync(keep), '文件还在');
});

await test('新增账号：URL 只收 http(s)、profileDir 必须是存在的绝对路径', async () => {
  const badUrl = await call('POST', '/shop-accounts/accounts', { loginName: 'u10', password: 'Test-P@ss1', platform: 'pdd', name: '安全测试店-2', url: '--proxy-server=http://evil:8080' });
  assert.equal(badUrl.status, 400);
  const badDir = await call('POST', '/shop-accounts/accounts', { loginName: 'u11', password: 'Test-P@ss1', platform: 'pdd', name: '安全测试店-3', profileDir: 'relative/dir' });
  assert.equal(badDir.status, 400);
  const ok = await call('POST', '/shop-accounts/accounts', { loginName: 'u12', password: 'Test-P@ss1', platform: 'pdd', name: '安全测试店-4', url: 'https://mms.pinduoduo.com/home/' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.account.url, 'https://mms.pinduoduo.com/home/');
  await call('DELETE', '/shop-accounts/accounts/' + ok.json.account.id, {});
});

await test('自更新按「已校验 commit」落地：版本不符中止、工作区脏文件不会被部署', async () => {
  const repo = path.join(TMP, 'sync-repo');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lib', 'x.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'sync-fixture', version: '0.1.0' }) + '\n');
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  const init = git('init', '-q');
  if (init.status !== 0) return; // 机器上没有 git 就跳过这项
  git('add', '-A');
  const commit = git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  if (commit.status !== 0) return;

  const t1 = path.join(TMP, 'sync-target-1');
  const bad = host.syncFromSource(repo, t1, { ref: 'HEAD', expectVersion: '9.9.9' });
  assert.ok(bad.error, '版本不一致必须中止：' + JSON.stringify(bad));
  assert.ok(!fs.existsSync(path.join(t1, 'lib')), '中止时不能落任何文件');

  const t2 = path.join(TMP, 'sync-target-2');
  const good = host.syncFromSource(repo, t2, { ref: 'HEAD', expectVersion: '0.1.0' });
  assert.ok(good.copied >= 2, '应该拷到 lib + package.json');
  assert.match(fs.readFileSync(path.join(t2, 'lib', 'x.js'), 'utf8'), /x = 1/);

  // 工作区被改脏：仍然只部署 commit 里的内容
  fs.writeFileSync(path.join(repo, 'lib', 'x.js'), 'export const x = 2;\n');
  const t3 = path.join(TMP, 'sync-target-3');
  const dirty = host.syncFromSource(repo, t3, { ref: 'HEAD', expectVersion: '0.1.0' });
  assert.ok(dirty.copied >= 2, JSON.stringify(dirty));
  assert.match(fs.readFileSync(path.join(t3, 'lib', 'x.js'), 'utf8'), /x = 1/, '不能用工作区的脏文件覆盖');

  const badRef = host.syncFromSource(repo, path.join(TMP, 'sync-target-4'), { ref: 'deadbeefdeadbeef' });
  assert.ok(badRef.error, '不存在的 commit 必须失败而不是退化成拷工作区');

  const notRepo = await host.checkUpdate({ updateDir: TMP });
  assert.equal(notRepo.ok, false);
  assert.match(notRepo.error, /不是 git 仓库/);
});

await test('git 报错里的凭据会被打码', () => {
  const masked = host.maskSecrets('fatal: https://user:ghp_abcdefghijklmnopqrstuvwx@github.com/x.git failed');
  assert.ok(!masked.includes('ghp_abcdefghijklmnopqrstuvwx'), 'token 必须被打码：' + masked);
  assert.ok(masked.includes('github.com/x.git'), '主机与路径应保留');
});

await test('登录判据：pdd 单 cookie 不再算登录；URL 兜底按 host 后缀匹配', () => {
  const pdd = P.platformOf('pdd');
  const dom = '.pinduoduo.com';
  const one = [{ name: 'mms_b84d1838', domain: dom, value: 'real-cookie-value' }];
  assert.equal(P.judgeLogin(one, pdd.homeUrl, pdd).loggedIn, false, '只 1 个 cookie 不能算登录');
  const two = one.concat([{ name: 'PASS_ID', domain: dom, value: 'real-cookie-value' }]);
  assert.equal(P.judgeLogin(two, pdd.homeUrl, pdd).loggedIn, true, 'PASS_ID + mms 应该算登录');
  // URL 兜底（cookieReadOk=false）不能被子串骗
  assert.equal(P.judgeLogin([], 'https://pinduoduo.com.evil.com/', pdd, { cookieReadOk: false }).loggedIn, false);
  assert.equal(P.judgeLogin([], 'https://mms.pinduoduo.com/home/', pdd, { cookieReadOk: false }).loggedIn, true);
});

await test('客户端请求都带插件自定义头（服务端才认）', () => {
  assert.ok(clientSrc.includes("'X-DSH-Shop-Accounts': '1'"), 'client 必须带 X-DSH-Shop-Accounts 头');
  assert.ok(indexSrc.includes("const REQ_HEADER = 'x-dsh-shop-accounts'"), 'index 必须校验这个头');
});

// ── 3.11 v0.8.4 二次审查加固 ─────────────────────────────────────────────────

section('3.11 v0.8.4 二次审查加固');
const secretMod = await import(url('lib/secret.mjs'));

await test('反 DNS rebinding：Host 是域名一律拒绝，IP/localhost 放行', async () => {
  const evil = await call('GET', '/shop-accounts/state', undefined, { host: 'evil.example.com' });
  assert.equal(evil.status, 403, '域名 Host 必须 403');
  assert.match(evil.json.error, /DNS rebinding/);
  const loop = await call('GET', '/shop-accounts/state', undefined, { host: '127.0.0.1:43120' });
  assert.equal(loop.status, 200);
  const lan = await call('GET', '/shop-accounts/state', undefined, { host: '192.168.1.5:43120' });
  assert.equal(lan.status, 200, '局域网用 IP Host 访问要放行');
  const v6 = await call('GET', '/shop-accounts/state', undefined, { host: '[::1]:43120' });
  assert.equal(v6.status, 200);
});

await test('配置路径写入要校验：系统目录/盘根/非浏览器 exe 一律 400', async () => {
  const win = await call('PUT', '/shop-accounts/config', { profileRoot: path.parse(TMP).root });
  assert.equal(win.status, 400, '盘根不能当档案根目录');
  const sys = await call('PUT', '/shop-accounts/config', { profileRoot: process.env.SystemRoot || 'C:\\Windows' });
  assert.equal(sys.status, 400, '系统目录不能当档案根目录');
  const exe = await call('PUT', '/shop-accounts/config', { browserPath: 'C:\\Windows\\System32\\cmd.exe' });
  assert.equal(exe.status, 400, '非 Chromium 程序不能当浏览器路径');
  const skip = await call('PUT', '/shop-accounts/config', { browserPath: 'C:\\nope\\chrome.exe' });
  assert.equal(skip.status, 400, '不存在的路径要拒绝');
  const okRoot = path.join(TMP, 'cfg-root');
  fs.mkdirSync(okRoot, { recursive: true });
  const ok = await call('PUT', '/shop-accounts/config', { profileRoot: okRoot });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.config.profileRoot, okRoot);
  const reset = await call('PUT', '/shop-accounts/config', { profileRoot: '' });
  assert.equal(reset.status, 200);
});

await test('删除只认「根目录下 + 目录名 = 账号 id」：把 profileRoot 改成别处也删不到', async () => {
  const root = path.join(TMP, 'poison-root');
  fs.mkdirSync(root, { recursive: true });
  await call('PUT', '/shop-accounts/config', { profileRoot: root });
  const created = await call('POST', '/shop-accounts/accounts', { loginName: 'u13', password: 'Test-P@ss1', platform: 'pdd', name: '投毒测试店' });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.account.id;
  // 把账号的档案目录指向"根目录下但名字不是 id"的目录（模拟"把根指向家目录后删同级目录"）
  const victim = path.join(root, 'victim-dir');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
  const put = await call('PUT', '/shop-accounts/accounts/' + id, { profileDir: victim });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const del = await call('DELETE', '/shop-accounts/accounts/' + id, { deleteProfile: true });
  assert.equal(del.status, 200);
  assert.equal(del.json.deletedProfile, false, '名字不是 id 的目录不能被删');
  assert.ok(fs.existsSync(path.join(victim, 'keep.txt')), '文件还在');
  await call('PUT', '/shop-accounts/config', { profileRoot: '' });
});

await test('junction/符号链接不能骗过档案根目录判定（按真实路径判）', () => {
  const jroot = path.join(TMP, 'jroot');
  const jtarget = path.join(TMP, 'jtarget');
  fs.mkdirSync(jroot, { recursive: true });
  fs.mkdirSync(path.join(jtarget, 'System32'), { recursive: true });
  const link = path.join(jroot, 'j');
  const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, jtarget], { encoding: 'utf8', windowsHide: true });
  if (made.status !== 0) return; // 建不了 junction（权限/文件系统）就跳过
  assert.equal(S.isInsideProfileRoot(path.join(link, 'System32'), { profileRoot: jroot }), false,
    'junction 必须按真实路径判，不能在词法上"看起来在根目录下"');
});

await test('导入目录不能是系统/用户/程序目录本身', () => {
  assert.throws(() => S.normalizeImportedProfileDir(process.env.SystemRoot || 'C:\\Windows'), /不能当店铺档案目录/);
  assert.throws(() => S.normalizeImportedProfileDir(os.homedir()), /不能当店铺档案目录/);
  assert.throws(() => S.normalizeImportedProfileDir(path.parse(TMP).root), /不能当店铺档案目录/);
  const sub = path.join(os.homedir(), 'AppData');
  if (fs.existsSync(sub)) assert.equal(S.normalizeImportedProfileDir(sub), path.resolve(sub), '子目录仍然可以导入');
});

await test('账号 id 形状校验：坏 id 当"不存在"处理', async () => {
  const bad = await call('GET', '/shop-accounts/accounts/' + encodeURIComponent('..'));
  assert.equal(bad.status, 404);
  const bad2 = await call('DELETE', '/shop-accounts/accounts/' + encodeURIComponent('acc_ok_1'), {});
  assert.equal(bad2.status, 404, '库里没有这个 id 就是 404（形状合法但不存在）');
});

await test('自更新：上游没有 version 时拒绝更新（不能跳过校验照拷）', async () => {
  const repo = path.join(TMP, 'sync-repo-noversion');
  fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'lib', 'x.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture' }) + '\n');
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (git('init', '-q').status !== 0) return;
  git('add', '-A');
  if (git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init').status !== 0) return;
  const target = path.join(TMP, 'sync-target-noversion');
  const noExpect = host.syncFromSource(repo, target, { ref: 'HEAD' });
  assert.ok(noExpect.error, '没有 expectVersion 必须拒绝：' + JSON.stringify(noExpect));
  assert.ok(!fs.existsSync(path.join(target, 'lib')), '拒绝时不能落文件');
});

await test('会话 cookie 文件默认加密（DPAPI 信封）；篡改后解不开；旧格式仍能读', () => {
  const dataDir2 = path.join(TMP, 'secret-data');
  fs.mkdirSync(dataDir2, { recursive: true });
  const key = secretMod.sessionKey(dataDir2);
  const payload = { savedAt: 'x', platform: 'pdd', total: 1, cookies: [{ name: 'PASS_ID', domain: '.pinduoduo.com', value: 'v1' }] };
  const { sealed, encrypted } = secretMod.sealCookieJar(payload, key);
  assert.deepEqual(secretMod.openCookieJar(JSON.parse(JSON.stringify(sealed)), key), payload, '加解密要能往返');
  assert.equal(encrypted, secretMod.dpapiAvailable() && Boolean(key), 'Windows + DPAPI 可用时应当加密');
  if (encrypted) {
    assert.equal(sealed.enc, 'aes-gcm-dpapi');
    assert.ok(!JSON.stringify(sealed).includes('PASS_ID'), '密文里不能出现明文 cookie 名/值');
    const tampered = { ...sealed, data: Buffer.from('tampered-tampered').toString('base64') };
    assert.equal(secretMod.openCookieJar(tampered, key), null, '篡改过的密文必须解不开（GCM 校验）');
  }
  // 旧版明文（v0.8.3 及更早）必须还能读
  const legacy = { savedAt: 'x', platform: 'pdd', total: 1, cookies: [{ name: 'PASS_ID', domain: '.pinduoduo.com', value: 'v1' }] };
  assert.deepEqual(secretMod.openCookieJar(legacy, key), legacy);
});

await test('落盘实测：saveSessionCookies 写出的文件里没有明文 cookie 值', () => {
  const acc = { id: 'acc_pdd_enc0001', platform: 'pdd', profileDir: path.join(TMP, 'data', 'profiles', 'acc_pdd_enc0001') };
  fs.mkdirSync(acc.profileDir, { recursive: true });
  const ok = host.saveSessionCookies(acc, [{ name: 'PASS_ID', domain: '.pinduoduo.com', value: 'super-secret-value' }]);
  assert.equal(ok, true);
  const raw = fs.readFileSync(path.join(acc.profileDir, 'dsh-session-cookies.json'), 'utf8');
  if (secretMod.dpapiAvailable() && secretMod.sessionKey(path.join(TMP, 'data'))) {
    assert.ok(!raw.includes('super-secret-value'), '文件里不能出现明文 cookie 值：' + raw.slice(0, 120));
  }
  // 档案根目录之外的"导入目录"不做 cookie 备份（免得把带值 cookie 写到公共位置）
  const outside = { id: 'acc_pdd_out0001', platform: 'pdd', profileDir: path.join(TMP, 'outside-dir') };
  fs.mkdirSync(outside.profileDir, { recursive: true });
  assert.equal(host.saveSessionCookies(outside, [{ name: 'PASS_ID', domain: '.pinduoduo.com', value: 'v' }]), false);
});

await test('egoSpace 形状校验（控制字符/超长）；凭据打码覆盖 Bearer 与 query token', () => {
  assert.equal(egoMod.normalizeEgoSpace('  店铺 窗口  '), '店铺 窗口');
  assert.throws(() => egoMod.normalizeEgoSpace('a\nb'), /控制字符/);
  assert.throws(() => egoMod.normalizeEgoSpace('x'.repeat(61)), /太长/);
  const masked = host.maskSecrets('Authorization: Bearer abcdefghijklmnop 与 https://x.test/cb?access_token=SECRET123&a=1');
  assert.ok(!masked.includes('abcdefghijklmnop'), masked);
  assert.ok(!masked.includes('SECRET123'), masked);
  assert.ok(masked.includes('a=1'), '不相关的参数要保留');
});

await test('真实 HTTP 链路：门禁/状态码与假 req 一致（Host、头、Content-Type、非对象体）', async () => {
  const server = http.createServer((rq, rs) => handler(rq, rs));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const send = (opts, body) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: opts.path, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (body !== undefined) r.write(body);
    r.end();
  });
  const H = { 'x-dsh-shop-accounts': '1', 'content-type': 'application/json' };
  try {
    assert.equal((await send({ path: '/shop-accounts/state', headers: H })).status, 200);
    assert.equal((await send({ path: '/shop-accounts/state', headers: { ...H, host: 'evil.example.com' } })).status, 403, '域名 Host');
    assert.equal((await send({ path: '/shop-accounts/state', headers: { 'content-type': 'application/json' } })).status, 403, '缺自定义头');
    assert.equal((await send({ path: '/shop-accounts/config', method: 'PUT', headers: { 'x-dsh-shop-accounts': '1', 'content-type': 'text/plain' } }, '{"browser":"chrome"}')).status, 415, 'text/plain 写请求');
    assert.equal((await send({ path: '/shop-accounts/config', method: 'PUT', headers: H }, '{"browser":"chrome"}')).status, 200);
    const bad = await send({ path: '/shop-accounts/config', method: 'PUT', headers: H }, '"just-a-string"');
    assert.equal(bad.status, 400, '非对象 JSON 体必须 400（不能 500）');
    assert.equal((await send({ path: '/shop-accountsX/state', headers: H })).status, 404, '前缀边界');
    assert.equal((await send({ path: '/shop-accounts/state', headers: { ...H, 'sec-fetch-site': 'cross-site' } })).status, 403, '跨站');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── 3.12 v0.8.4 复审后的收尾 ─────────────────────────────────────────────────

section('3.12 v0.8.4 复审收尾');

await test('Host 白名单：IP / localhost. / 本机主机名放行，缺 Host 与域名拒绝', async () => {
  const me = os.hostname();
  assert.equal((await call('GET', '/shop-accounts/state', undefined, { host: me + ':43120' })).status, 200, '本机主机名应放行');
  assert.equal((await call('GET', '/shop-accounts/state', undefined, { host: '127.1:43120' })).status, 200, '127.x 简写应放行');
  assert.equal((await call('GET', '/shop-accounts/state', undefined, { host: 'localhost.' })).status, 200, 'localhost. 应放行');
  assert.equal((await call('GET', '/shop-accounts/state', undefined, { host: '[::1]:43120' })).status, 200, 'IPv6 回环应放行');
  assert.equal((await call('GET', '/shop-accounts/state', undefined, { host: '' })).status, 403, '缺 Host 必须拒绝');
  assert.equal((await call('GET', '/shop-accounts/state', undefined, { host: 'my-pc.evil.example' })).status, 403);
});

await test('更新源目录必须「存在 + git 仓库 + package.json name 是本插件」', async () => {
  const notRepo = await call('PUT', '/shop-accounts/config', { updateDir: TMP });
  assert.equal(notRepo.status, 400);
  assert.match(notRepo.json.error, /不是 git 仓库/);
  // 造一个"是 git 仓库但不是本插件"的目录
  const other = path.join(TMP, 'other-repo');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'some-other-plugin', version: '9.9.9' }) + '\n');
  const git = (...args) => spawnSync('git', args, { cwd: other, encoding: 'utf8', windowsHide: true });
  if (git('init', '-q').status === 0) {
    git('add', '-A');
    if (git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init').status === 0) {
      const wrongName = await call('PUT', '/shop-accounts/config', { updateDir: other });
      assert.equal(wrongName.status, 400, '不是本插件的仓库要拒绝');
      assert.match(wrongName.json.error, /name=/);
    }
  }
  await call('PUT', '/shop-accounts/config', { updateDir: '' });
});

await test('cookie 罐格式：未知版本/未知 enc 一律不认；解不开的密钥不被覆盖', () => {
  const key = secretMod.sessionKey(path.join(TMP, 'secret-data'));
  assert.equal(secretMod.openCookieJar({ v: 99, cookies: [] }, key), null, '未知版本必须拒收');
  assert.equal(secretMod.openCookieJar({ enc: 'rot13', cookies: [] }, key), null, '未知 enc 必须拒收');
  assert.equal(secretMod.openCookieJar({ v: 2, enc: 'aes-gcm-dpapi', cookies: [] }, key), null, '加密格式必须走解密，不能当明文收');
  if (!secretMod.dpapiAvailable()) return;
  const badDir = path.join(TMP, 'bad-key-data');
  fs.mkdirSync(badDir, { recursive: true });
  const keyFile = path.join(badDir, 'session-cookie.key');
  const garbage = 'this-is-not-a-dpapi-blob';
  fs.writeFileSync(keyFile, garbage);
  secretMod.__resetKeyCache();
  assert.equal(secretMod.sessionKey(badDir), null, '密钥解不开时应当退回明文而不是换一把新钥');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), garbage, '解不开的密钥文件绝不能被覆盖');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' / 通过 ' + passed : '\u2713 全部通过（' + passed + ' 项）'));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清不掉就算了 */ }
if (failures.length) process.exitCode = 1;
