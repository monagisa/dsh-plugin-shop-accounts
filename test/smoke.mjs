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
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
function fakeReq(method, reqUrl, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = reqUrl;
  req.destroy = () => {};
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
async function call(method, p, body) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body), res);
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
  assert.equal(typeof s.json.updateDir, 'string', '状态里要带自动探测到的更新源目录');
  assert.equal(typeof s.json.config.updateDir, 'string', 'config 里要有 updateDir 字段');
});

await test('检测更新：源码目录不是 git 仓库时如实报错，不联网瞎猜', async () => {
  const notRepo = path.join(TMP, 'not-a-repo');
  fs.mkdirSync(notRepo, { recursive: true });
  const put = await call('PUT', '/shop-accounts/config', { updateDir: notRepo });
  assert.equal(put.status, 200);
  const r = await call('GET', '/shop-accounts/update');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false, '不是 git 仓库就不能假装能更新');
  assert.match(r.json.error, /不是 git 仓库/);
  assert.match(String(r.json.localVersion || ''), /^\d+\.\d+\.\d+$/, '报错也要把本地版本号带上');
  const post = await call('POST', '/shop-accounts/update', {});
  assert.equal(post.status, 500);
  assert.match(post.json.error, /不是 git 仓库/);
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
  const r = await call('POST', '/shop-accounts/accounts', { platform: 'pdd', name: '测试店', note: '备注' });
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
  const r = await call('POST', '/shop-accounts/accounts', { platform: 'amazon', name: 'x' });
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
  // 「管理」详情页要写的那几个字段：店铺 URL / 账号 / 账号类型
  const d = await call('PUT', '/shop-accounts/accounts/' + id, {
    url: 'https://mms.pinduoduo.com/goods/goods_list', loginName: '韩品兰坊;阿荣', accountType: '商家账号',
  });
  assert.equal(d.json.account.url, 'https://mms.pinduoduo.com/goods/goods_list');
  assert.equal(d.json.account.loginName, '韩品兰坊;阿荣');
  assert.equal(d.json.account.accountType, '商家账号');
  const ds = await call('GET', '/shop-accounts/state');
  assert.equal(ds.json.accounts[0].url, 'https://mms.pinduoduo.com/goods/goods_list');
  assert.equal(ds.json.accounts[0].loginName, '韩品兰坊;阿荣');
  assert.equal(ds.json.accounts[0].accountType, '商家账号');
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

await test('未知路由 404；坏 JSON 500（外层兜底不炸进程）', async () => {
  const nf = await call('GET', '/shop-accounts/nope');
  assert.equal(nf.status, 404);
  const bad = await call('POST', '/shop-accounts/accounts', '{ 半截 JSON');
  assert.equal(bad.status, 500);
  assert.match(bad.json.error, /JSON/);
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
  for (const c of ['Toast', 'Field', 'AccountDialog', 'AccountDetail', 'ConfigPanel']) {
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
  const created = await call('POST', '/shop-accounts/accounts', { platform: 'taobao', name: '契约店' });
  const id = created.json.account.id;
  const wrongVerb = await call('GET', '/shop-accounts/accounts/' + id + '/open');
  assert.equal(wrongVerb.status, 405, '动作只收 POST');
  await call('DELETE', '/shop-accounts/accounts/' + id, {});
});

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' / 通过 ' + passed : '\u2713 全部通过（' + passed + ' 项）'));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清不掉就算了 */ }
if (failures.length) process.exitCode = 1;
