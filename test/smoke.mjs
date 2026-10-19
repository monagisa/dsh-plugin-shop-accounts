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
  const a = await call('POST', '/shop-accounts/accounts', { platform: 'pdd', name: '排期店A' });
  const b = await call('POST', '/shop-accounts/accounts', { platform: 'taobao', name: '排期店B' });
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
  const r1 = await host.tickSchedule({ now, memGB: 8, log: { info() {}, warn() {} }, checkFn });
  assert.equal(r1.ran.length, 1, '第一组只有一个店铺到点');
  assert.deepEqual(calls, [first.id]);
  assert.equal(gotOpts[0].keepaliveSec, 0, '上一步把保活存成 0，定时检测就该传 0 下去');
  const r2 = await host.tickSchedule({ now, memGB: 8, log: { info() {}, warn() {} }, checkFn });
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
  });
  assert.equal(called, 0, '等登录的店铺不该被静默检测打断');
  assert.ok(r.skipped.some((x) => /等登录/.test(x.reason)), '跳过原因要说得清楚：' + JSON.stringify(r.skipped));
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
  // ⑧ 行里「详细配置」要和上面的排期胶囊对齐居中（用户原话「不居中，太奇怪」）。
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
  for (const want of ['定时检测', '调整排期', '每天 09:05 起 · 每组 1 个店铺，组间隔 30 分钟', '开启·09:05', '暂停·09:35', '上次失败']) {
    assert.ok(page.text.includes(want), '列表页少了「' + want + '」：' + page.text.slice(0, 500));
  }

  const dlg = renderPage({ withDialog: true });
  assert.ok(!/render-error/.test(dlg.text), '弹窗渲染抛错了：' + dlg.text.slice(0, 400));
  for (const want of ['调整排期', '每日起始时间', '组间隔（分钟）', '每组店铺数', '开启定时检测', '保存排期', '取消']) {
    assert.ok(dlg.text.includes(want), '弹窗少了「' + want + '」');
  }
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
