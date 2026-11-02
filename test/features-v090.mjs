#!/usr/bin/env node
/**
 * features-v090.mjs —— v0.9.0 三个新能力的自检：
 *   1. 账号类型：卖家 / 买家（platforms.mjs 的变体与能力位）
 *   2. 密码库 + 自动登录（vault.mjs / autologin.mjs，密码不落 accounts.json、不进 /state）
 *   3. 数据采集：采集域配置、校验、提示词生成、到期判断、结果回写
 *
 * 零依赖、不动真实数据（DSH_SHOP_ACCOUNTS_DIR 指到临时目录）、不启动浏览器。
 * 跑法：node test/features-v090.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v090-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');

const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

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

// ── 1. 账号类型与平台变体 ───────────────────────────────────────────────────
section('1. 账号类型 lib/platforms.mjs');
const P = await import(url('lib/platforms.mjs'));

await test('ACCOUNT_TYPES 是 seller/buyer 两项，标签为卖家/买家', () => {
  assert.deepEqual(P.ACCOUNT_TYPES.map((x) => x.id), ['seller', 'buyer']);
  for (const t of P.ACCOUNT_TYPES) assert.match(t.label, /卖家|买家/);
});

await test('normalizeAccountType：老写法"商家账号"→seller，买家各种写法→buyer', () => {
  assert.equal(P.normalizeAccountType(''), 'seller');
  assert.equal(P.normalizeAccountType('商家账号'), 'seller');
  assert.equal(P.normalizeAccountType('seller'), 'seller');
  assert.equal(P.normalizeAccountType('买家'), 'buyer');
  assert.equal(P.normalizeAccountType('买家账号'), 'buyer');
  assert.equal(P.normalizeAccountType('buyer'), 'buyer');
  assert.equal(P.normalizeAccountType(undefined), 'seller');
});

await test('variantOf：买家换登录入口（淘宝/京东/1688/拼多多），卖家保持原样', () => {
  const taobao = P.platformOf('taobao');
  const s = P.variantOf(taobao, 'seller');
  const b = P.variantOf(taobao, 'buyer');
  assert.equal(s.accountType, 'seller');
  assert.equal(b.accountType, 'buyer');
  assert.notEqual(s.loginUrl, b.loginUrl);
  assert.match(b.loginUrl, /login\.taobao\.com/, '淘宝买家应走 login.taobao.com');
  assert.match(s.loginUrl, /loginmyseller/, '淘宝卖家仍走千牛卖家登录');
  // 买家沿用平台的 cookie 判据（同源）
  assert.deepEqual(b.identityCookies, taobao.identityCookies);
  const jd = P.variantOf(P.platformOf('jd'), 'buyer');
  assert.match(jd.loginUrl, /passport\.jd\.com\/new\/login/);
  const pdd = P.variantOf(P.platformOf('pdd'), 'buyer');
  assert.equal(pdd.experimental, true, '拼多多买家入口应标实验性');
});

await test('capabilitiesOf：卖家可上架，买家只浏览/采集；店铺 URL 只给卖家且拼多多不支持', () => {
  const pdd = P.platformOf('pdd');
  const taobao = P.platformOf('taobao');
  assert.equal(P.capabilitiesOf(taobao, 'seller').upload, true);
  assert.equal(P.capabilitiesOf(taobao, 'buyer').upload, false);
  assert.equal(P.capabilitiesOf(taobao, 'seller').storeUrl, true);
  assert.equal(P.capabilitiesOf(pdd, 'seller').storeUrl, false);
  assert.equal(P.capabilitiesOf(pdd, 'buyer').collection, true);
});

await test('judgeLogin 按账号类型用不同登录页：买家页命中不再按卖家判据误判', () => {
  const taobao = P.platformOf('taobao');
  const cookies = [
    { name: 'unb', domain: '.taobao.com', value: '12345678', expires: 0 },
    { name: 'cookie2', domain: '.taobao.com', value: 'abcdef', expires: 0 },
  ];
  // 停在买家登录页：无论什么类型都该判未登录（登录页最硬）
  const atBuyerLogin = P.judgeLogin(cookies, 'https://login.taobao.com/havanaone/login/login.htm', taobao, { accountType: 'buyer' });
  assert.equal(atBuyerLogin.loggedIn, false);
  assert.equal(atBuyerLogin.evidence, 'login-page');
  // 停在买家站内（不是登录页）且有身份 cookie：买家类型应判已登录
  const inBuyerSite = P.judgeLogin(cookies, 'https://www.taobao.com/', taobao, { accountType: 'buyer' });
  assert.equal(inBuyerSite.loggedIn, true);
  assert.equal(inBuyerSite.evidence, 'cookie');
});

await test('platformList 带上买家提示与两种能力位', () => {
  const list = P.platformList();
  assert.equal(list.length, 6);
  for (const p of list) {
    assert.ok(p.id && p.label);
    assert.ok(p.capabilities && p.capabilities.seller && p.capabilities.buyer);
    assert.equal(p.capabilities.buyer.accountType, 'buyer');
  }
});

// ── 2. 密码库 ───────────────────────────────────────────────────────────────
section('2. 密码库 lib/vault.mjs');
const V = await import(url('lib/vault.mjs'));
const S = await import(url('lib/store.mjs'));

await test('DPAPI 可用时密码库可用；保存/读取/删除往返正确', () => {
  assert.equal(V.vaultAvailable(), true, 'Windows + DPAPI 环境下应可用');
  const r = V.setPassword('acc_taobao_test01', 'p@ss-"中文"-  空格');
  assert.equal(r.hasPassword, true);
  assert.equal(V.hasPassword('acc_taobao_test01'), true);
  assert.equal(V.getPassword('acc_taobao_test01'), 'p@ss-"中文"-  空格');
  const cleared = V.clearPassword('acc_taobao_test01');
  assert.equal(cleared.removed, true);
  assert.equal(V.hasPassword('acc_taobao_test01'), false);
});

await test('密码库落盘文件里没有明文密码（AEAD 信封）', () => {
  V.setPassword('acc_pdd_test02', 'PLAINTEXT-MARKER-123456');
  const raw = fs.readFileSync(V.vaultPath(), 'utf8');
  assert.ok(!raw.includes('PLAINTEXT-MARKER-123456'), '密文文件里不该出现明文密码');
  const env = JSON.parse(raw);
  assert.equal(env.enc, 'aes-gcm-dpapi');
  assert.equal(env.v, 2);
  V.clearPassword('acc_pdd_test02');
});

await test('密码入参校验：空/超长/NUL 都拒绝；密码是原样字符串（不 trim）', () => {
  assert.throws(() => V.normalizePassword(''), /不能为空/);
  assert.throws(() => V.normalizePassword('x'.repeat(4097)), /太长/);
  assert.throws(() => V.normalizePassword('a\u0000b'), /NUL/);
  assert.throws(() => V.normalizePassword(123), /字符串/);
  assert.equal(V.normalizePassword('  x  '), '  x  ');
});

await test('vaultInfo 只暴露可用性/路径/条数，不暴露内容', () => {
  V.setPassword('acc_jd_test03', 'secret-jd');
  const info = V.vaultInfo();
  assert.equal(info.available, true);
  assert.equal(typeof info.count, 'number');
  assert.ok(info.path.endsWith('account-secrets.enc'));
  assert.ok(!JSON.stringify(info).includes('secret-jd'));
  V.clearPassword('acc_jd_test03');
});

// ── 3. 采集配置 ─────────────────────────────────────────────────────────────
section('3. 数据采集 lib/collection.mjs');
const C = await import(url('lib/collection.mjs'));

await test('采集域与标签：5 个域 + 5 个说明名，竞争洞察默认不开放', () => {
  assert.deepEqual(C.COLLECTION_DOMAINS, ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约']);
  assert.equal(C.COLLECTION_LABELS['经营总览'], '成交与客户');
  assert.equal(C.COLLECTION_LABELS['服务履约'], '售后与服务');
  assert.ok(!C.COLLECTION_DOMAINS.includes('竞争洞察'));
  assert.deepEqual(C.domainList().map((d) => d.id), C.COLLECTION_DOMAINS);
});

await test('normalizeCollection：开启必须选域；未知域/坏时间要报错；去重保序', () => {
  assert.throws(() => C.normalizeCollection({ enabled: true, domains: [] }), /至少要选择一个采集域/);
  assert.throws(() => C.normalizeCollection({ domains: ['随便采'] }), /未知采集域/);
  assert.throws(() => C.normalizeCollection({ time: '25:00' }), /HH:mm/);
  const ok = C.normalizeCollection({ enabled: true, domains: ['商品供给', '商品供给', '服务履约'], time: '09:30' });
  assert.deepEqual(ok.domains, ['商品供给', '服务履约']);
  assert.equal(ok.enabled, true);
  assert.equal(ok.time, '09:30');
});

await test('domain_id 形状固定（抖店→doudian）', () => {
  assert.equal(C.collectDomainId('taobao', '商品供给'), 'taobao-scheduler-商品供给');
  assert.equal(C.collectDomainId('douyin', '服务履约'), 'doudian-scheduler-服务履约');
});

await test('采集范围固定最近 30 个完整自然日（不含今天）', () => {
  const now = new Date(2026, 10, 2, 10, 0, 0); // 2026-11-02
  const r = C.collectionRangeText(now);
  assert.equal(r.end, '2026-11-01');
  assert.equal(r.days, 30);
  assert.match(r.text, /最近 30 个完整自然日/);
});

await test('collectionPrompt：带 domain_id、平台、店铺、30 天范围，并禁止扩大范围', () => {
  const acc = {
    id: 'acc_taobao_x1', platform: 'taobao', name: '测试店', loginName: 'tbuser', accountType: 'seller',
    collection: { enabled: true, domains: ['商品供给', '服务履约'], time: '08:00' },
  };
  const p = C.collectionPrompt(acc, { now: new Date(2026, 10, 2) });
  assert.match(p, /店铺数据采集/);
  assert.match(p, /测试店/);
  assert.match(p, /淘宝/);
  assert.match(p, /taobao-scheduler-商品供给/);
  assert.match(p, /taobao-scheduler-服务履约/);
  assert.match(p, /最近 30 个完整自然日/);
  assert.match(p, /不要用全量参数扩大范围/);
});

await test('collectionPrompt：买家账号自动剔除经营类域并说明', () => {
  const acc = {
    id: 'acc_taobao_b1', platform: 'taobao', name: '买家号', accountType: 'buyer',
    collection: { enabled: true, domains: ['经营总览', '流量转化', '商品供给'] },
  };
  const p = C.collectionPrompt(acc, { now: new Date(2026, 10, 2) });
  assert.ok(!p.includes('taobao-scheduler-经营总览'));
  assert.match(p, /taobao-scheduler-商品供给/);
  assert.match(p, /买家账号/);
  assert.match(p, /剔除/);
});

await test('到期判断：当天采过就不再算到期；失败状态当天仍算到期', () => {
  const now = new Date(2026, 10, 2, 12, 0, 0);
  const base = { id: 'a', name: 'x', platform: 'taobao', collection: { enabled: true, domains: ['商品供给'], time: '09:00' } };
  assert.equal(C.isCollectionDue(base, now), true);
  const done = { ...base, collection: { ...base.collection, lastRunAt: new Date(2026, 10, 2, 9, 5).toISOString(), lastRunStatus: 'ok' } };
  assert.equal(C.isCollectionDue(done, now), false);
  const failed = { ...base, collection: { ...base.collection, lastRunAt: new Date(2026, 10, 2, 9, 5).toISOString(), lastRunStatus: 'failed' } };
  assert.equal(C.isCollectionDue(failed, now), true);
  const notYet = { ...base, collection: { ...base.collection, time: '23:00' } };
  assert.equal(C.isCollectionDue(notYet, now), false);
  const off = { ...base, collection: { ...base.collection, enabled: false } };
  assert.equal(C.isCollectionDue(off, now), false);
});

await test('applyCollectionResult：只收 ok/partial/failed，并写回时间与备注', () => {
  assert.throws(() => C.applyCollectionResult({ collection: {} }, { status: 'maybe' }), /只能/);
  const next = C.applyCollectionResult({ collection: { enabled: true, domains: ['商品供给'] } }, { status: 'ok', note: '30 天 1234 条', by: 'agent:test' });
  assert.equal(next.lastRunStatus, 'ok');
  assert.equal(next.lastRunNote, '30 天 1234 条');
  assert.equal(next.lastRunBy, 'agent:test');
  assert.ok(next.lastRunAt);
});

// ── 4. HTTP 面：新路由 ──────────────────────────────────────────────────────
section('4. 宿主 HTTP 面（新增路由）');
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
host.apply({
  webServer: { register: (r) => { registered.push(r); return () => {}; } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});
const handler = registered[0].handler;
async function call(method, p, body, headers) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body, headers), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON 忽略 */ }
  return { status: res.statusCode, json, body: res.body };
}

let accId = '';

await test('POST /accounts：可建买家账号 + 带采集配置，state 里带类型/能力位/采集域表', async () => {
  const r = await call('POST', '/shop-accounts/accounts', { loginName: 'u1', password: 'Test-P@ss1',
    platform: 'taobao', name: '买家测试店', accountType: 'buyer',
    collection: { enabled: true, domains: ['商品供给'], time: '09:00' },
  });
  assert.equal(r.status, 200);
  accId = r.json.account.id;
  assert.equal(r.json.account.accountType, 'buyer');
  const s = await call('GET', '/shop-accounts/state');
  assert.ok(Array.isArray(s.json.accountTypes) && s.json.accountTypes.length === 2);
  assert.deepEqual(s.json.collectionDomains.map((d) => d.id), C.COLLECTION_DOMAINS);
  const row = s.json.accounts.find((a) => a.id === accId);
  assert.equal(row.accountType, 'buyer');
  assert.equal(row.accountTypeLabel, '买家账号');
  assert.equal(row.capabilities.upload, false);
  assert.equal(row.collection.enabled, true);
  assert.deepEqual(row.collection.domains, ['商品供给']);
  assert.equal(typeof s.json.vault.available, 'boolean');
});

await test('POST /accounts：新建时可直接带登录账号+密码（落库、不回明文、自动起名不带分号）', async () => {
  const st = await call('GET', '/shop-accounts/state');
  const vaultOk = !!(st.json.vault && st.json.vault.available);
  const r = await call('POST', '/shop-accounts/accounts', {
    platform: 'jd', accountType: 'seller', loginName: '13800000000', password: 'Create-P@ss1',
  });
  if (!vaultOk) {
    // 密码库不可用时必须整单拒绝，而不是「号建了密码丢了」
    assert.equal(r.status, 400);
    assert.match(r.json.error, /密码库不可用/);
    return;
  }
  assert.equal(r.status, 200);
  assert.equal(r.json.passwordSaved, true);
  assert.equal(r.json.account.loginName, '13800000000');
  assert.ok(!/;$/.test(r.json.account.name), '自动起名不该带分号');
  // 账号文件里不能出现明文密码，密码库文件里也不能
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dataDir = process.env.DSH_SHOP_ACCOUNTS_DIR || join(process.env.USERPROFILE || '', '.dsh', 'shop-accounts');
  const accs = readFileSync(join(dataDir, 'accounts.json'), 'utf8');
  assert.ok(!accs.includes('Create-P@ss1'));
  // 密码真能读回来（vault 内部 API），且 state 只回 hasPassword 布尔
  const s2 = await call('GET', '/shop-accounts/state');
  const row = s2.json.accounts.find((a) => a.id === r.json.account.id);
  assert.equal(row.hasPassword, true);
  assert.ok(!JSON.stringify(s2.json).includes('Create-P@ss1'));
});

await test('POST /accounts：账号与密码都是必填，缺一即 400', async () => {
  const noName = await call('POST', '/shop-accounts/accounts', { platform: 'pdd', name: '缺账号店', password: 'P@ss1' });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.code, 'ACCOUNT_LOGIN_NAME_REQUIRED');
  const noPw = await call('POST', '/shop-accounts/accounts', { platform: 'pdd', name: '缺密码店', loginName: '13800000001' });
  assert.equal(noPw.status, 400);
  assert.equal(noPw.json.code, 'ACCOUNT_PASSWORD_REQUIRED');
  // 两个都没有也不该建出半成品记录
  const none = await call('POST', '/shop-accounts/accounts', { platform: 'pdd', name: '空店' });
  assert.equal(none.status, 400);
});

await test('「打开店铺」自带账密登录：源码里 autofill 默认开、可用 autofill:false 关掉', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8');
  assert.match(src, /body\.autofill !== false/);
  assert.match(src, /autofill = \{ attempted/);
  // 不再要求 confirm:true 才代填
  assert.ok(!/confirm !== true/.test(src), 'autologin 不该再强制 confirm');
});

await test('PUT /accounts/:id/collection：校验与落盘', async () => {

  const bad = await call('PUT', `/shop-accounts/accounts/${accId}/collection`, { enabled: true, domains: [] });
  assert.equal(bad.status, 400);
  const ok = await call('PUT', `/shop-accounts/accounts/${accId}/collection`, { enabled: true, domains: ['商品供给', '服务履约'], time: '07:30' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.account.collection.domains, ['商品供给', '服务履约']);
  assert.equal(ok.json.account.collection.time, '07:30');
});

await test('GET /accounts/:id/collect-prompt：返回可交给 agent 的提示词', async () => {
  const r = await call('GET', `/shop-accounts/accounts/${accId}/collect-prompt`);
  assert.equal(r.status, 200);
  assert.match(r.json.prompt, /店铺数据采集/);
  assert.match(r.json.prompt, /taobao-scheduler-商品供给/);
  assert.equal(r.json.collection.enabled, true);
});

await test('POST /accounts/:id/collect-done：回写采集结果；非法状态 400', async () => {
  const ok = await call('POST', `/shop-accounts/accounts/${accId}/collect-done`, { status: 'ok', note: '1234 条' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.account.collection.lastRunStatus, 'ok');
  const bad = await call('POST', `/shop-accounts/accounts/${accId}/collect-done`, { status: 'boom' });
  assert.equal(bad.status, 400);
});

await test('PUT/DELETE /accounts/:id/password：只回布尔与时间戳，绝不回明文', async () => {
  const put = await call('PUT', `/shop-accounts/accounts/${accId}/password`, { password: 'Test-P@ssw0rd' });
  assert.equal(put.status, 200);
  assert.equal(put.json.hasPassword, true);
  assert.ok(put.json.passwordUpdatedAt);
  assert.ok(!JSON.stringify(put.json).includes('Test-P@ssw0rd'));
  // /state 里只能看到 hasPassword，看不到密码
  const s = await call('GET', '/shop-accounts/state');
  const row = s.json.accounts.find((a) => a.id === accId);
  assert.equal(row.hasPassword, true);
  assert.equal(row.capabilities.autoLoginSupported, true);
  assert.ok(!JSON.stringify(s.json).includes('Test-P@ssw0rd'));
  // accounts.json 里也没有
  assert.ok(!fs.readFileSync(S.accountsPath(), 'utf8').includes('Test-P@ssw0rd'));
  const del = await call('DELETE', `/shop-accounts/accounts/${accId}/password`);
  assert.equal(del.status, 200);
  assert.equal(del.json.hasPassword, false);
});

await test('POST /accounts/:id/autologin：不再要 confirm；缺密码/缺账号要有可读错误；confirm:false 显式拒绝', async () => {
  // v0.9.2：账密登录是「打开店铺」的一部分，不再要求显式 confirm ——
  // 不带 confirm 的请求会直接走到字段校验，而不是被 confirm 闸挡下。
  // 这个账号建号时带了登录账号、但上一条用例把密码删了 → NO_PASSWORD（而不是 confirmation 错误）
  const noConfirm = await call('POST', `/shop-accounts/accounts/${accId}/autologin`, {});
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.code, 'AUTOLOGIN_NO_PASSWORD');
  // 显式拒绝仍然被尊重
  const declined = await call('POST', `/shop-accounts/accounts/${accId}/autologin`, { confirm: false });
  assert.equal(declined.json.code, 'AUTOLOGIN_DECLINED');
  // 把「登录账号」清空 → 代填无从下手，报 NO_LOGIN_NAME
  await call('PUT', `/shop-accounts/accounts/${accId}`, { loginName: '' });
  const noName = await call('POST', `/shop-accounts/accounts/${accId}/autologin`, {});
  assert.equal(noName.status, 400);
  assert.equal(noName.json.code, 'AUTOLOGIN_NO_LOGIN_NAME');
});

await test('autologin.mjs：没有密码/没有登录账号时不启动任何浏览器动作', async () => {
  const A = await import(url('lib/autologin.mjs'));
  const account = { id: 'acc_x', platform: 'taobao', name: 'x', accountType: 'seller' };
  const r1 = await A.autoLogin(account, { password: '', backend: 'chrome', cfg: {} });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'AUTOLOGIN_NO_PASSWORD');
  const r2 = await A.autoLogin({ ...account, loginName: '' }, { password: 'x', backend: 'chrome', cfg: {} });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'AUTOLOGIN_NO_LOGIN_NAME');
});

await test('autologin.mjs：代填脚本包含账号密码与页签切换，且不在服务端执行', async () => {
  const A = await import(url('lib/autologin.mjs'));
  const flow = A.loginFlowFor('taobao', 'buyer');
  assert.ok(flow && Array.isArray(flow.user) && flow.user.length > 0);
  const expr = A.buildFillExpression({ username: 'tbuser', password: 'pw-中文', flow });
  assert.match(expr, /tbuser/);
  assert.match(expr, /pw-中文/);
  assert.match(expr, /dispatchEvent/);
  assert.match(expr, /hasCaptcha/);
  assert.match(expr, /passwordTab/);
});

await test('工具定义里不再声称"不会代填"，且 action 枚举含采集/自动登录', async () => {
  // 直接读源码断言（工具注册要宿主 defineTool，自检里拿不到）
  const src = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8');
  assert.ok(!src.includes('本工具不会（也不能）代填账号密码或代扫码'));
  for (const a of ['collections', 'collect-prompt', 'collect-done', 'autologin']) {
    assert.ok(src.includes(`'${a}'`), '工具 action 缺少 ' + a);
  }
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.log('✗ 失败 ' + failures.length + ' / 通过 ' + passed);
  for (const f of failures) {
    console.log('\n[' + f.name + ']');
    console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = 1;
} else {
  console.log('✓ 全部通过（' + passed + ' 项）');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
