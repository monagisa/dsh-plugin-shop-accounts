/**
 * v0.18.2 自检：「干净窗口」与「登录态判定」两处口径。
 *
 * 现场（2026-11-05，用户反馈两条）：
 *  1. 点抖音买家账号的「登录」，打开的是用户自己之前登录过的抖音账号 —— 因为插件把**默认配置**
 *     （用户自己的浏览器档案）分给了店铺，甚至允许共用；默认配置里是用户自己的登录态。
 *  2. 在那个窗口里登录完点「完成」，插件却说「未检测到登录态」 —— 因为抖音买家的
 *     `loginUrlHints` 里混进了 `/jingxuan`（工作台），判据把它当成「停在登录页」，
 *     直接判未登录（cookie 明明全都在）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href);
const host = (mod.default && typeof mod.default.apply === 'function') ? mod.default : mod;
const P = await import(pathToFileURL(path.join(ROOT, 'lib/platforms.mjs')).href);
const pkg = JSON.parse(read('package.json'));
const indexSrc = read('lib/index.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  }
}

const douyinBuyer = P.variantOf(P.platformOf('douyin'), 'buyer');
const SESSION_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_assist_user'].map((name) => ({
  name, value: 'x'.repeat(12), domain: '.douyin.com', path: '/',
}));

// ── A. 登录页判据不再把工作台当登录页 ────────────────────────────────────────

test('A1 抖音买家 loginUrlHints 不含工作台路径 /jingxuan', () => {
  assert.ok(!douyinBuyer.loginUrlHints.includes('/jingxuan'), 'loginUrlHints 仍含 /jingxuan');
  assert.ok(douyinBuyer.loginUrlHints.some((h) => h.includes('/login')), 'loginUrlHints 少了 /login');
  assert.ok(douyinBuyer.loginUrlHints.some((h) => h.includes('sso.douyin.com')), 'loginUrlHints 少了 sso.douyin.com');
});

test('A2 抖音精选（工作台）不算登录页；真登录页仍算', () => {
  assert.equal(P.looksLikeLoginPage('https://www.douyin.com/jingxuan', douyinBuyer), false);
  assert.equal(P.looksLikeLoginPage('https://www.douyin.com/passport/sso/login', douyinBuyer), true);
  assert.equal(P.looksLikeLoginPage('https://sso.douyin.com/', douyinBuyer), true);
});

test('A3 已登录（4 个身份 cookie）+ 停在抖音精选 → 判已登录', () => {
  const r = P.judgeLogin(SESSION_COOKIES, 'https://www.douyin.com/jingxuan', douyinBuyer, { cookieReadOk: true });
  assert.equal(r.loggedIn, true, '仍判未登录：' + r.reason);
  assert.equal(r.evidence, 'cookie');
  assert.ok(r.matched.includes('sessionid'), '没认出 sessionid');
});

test('A4 停在真登录页 → 仍判未登录（别把失效会话当登录）', () => {
  const r = P.judgeLogin(SESSION_COOKIES, 'https://sso.douyin.com/', douyinBuyer, { cookieReadOk: true });
  assert.equal(r.loggedIn, false);
  assert.equal(r.evidence, 'login-page');
});

test('A5 抖音卖家判据没被影响（抖店后台仍是工作台）', () => {
  const seller = P.platformOf('douyin');
  assert.equal(P.looksLikeLoginPage('https://fxg.jinritemai.com/login/common', seller), true);
  assert.equal(P.looksLikeLoginPage('https://fxg.jinritemai.com/ffa/g/list', seller), false);
});

// ── B. ego profile 分配：默认配置留给用户自己 ────────────────────────────────

const PROFILES = [
  { id: 'Profile 3', name: '用户配置 1', isDefault: false },
  { id: 'Profile 1', name: 'nagisa', isDefault: true },
  { id: 'Profile 2', name: '用户配置 2', isDefault: false },
];
const OTHERS_USED = [
  { id: 'acc_pdd', egoProfile: 'Profile 1', cookieDomains: ['mms.pinduoduo.com', 'yangkeduo.com'] },
  { id: 'acc_taobao', egoProfile: 'Profile 2', cookieDomains: ['taobao.com', 'tmall.com'] },
  { id: 'acc_dy_seller', egoProfile: 'Profile 3', cookieDomains: ['jinritemai.com', 'douyin.com', 'bytedance.com'] },
];

test('B1 有空闲的「用户配置」时优先用它，且绝不选默认配置', () => {
  const r = host.allocateEgoProfile({
    profiles: PROFILES,
    others: [{ id: 'x', egoProfile: 'Profile 2', cookieDomains: ['taobao.com'] }],
    cookieDomains: ['douyin.com'],
  });
  assert.equal(r.profileId, 'Profile 3');
  assert.equal(r.shared, false);
  assert.equal(r.reservedDefault, true);
});

test('B2 默认配置即使空着也不给店铺用', () => {
  const r = host.allocateEgoProfile({
    profiles: PROFILES,
    others: [],
    cookieDomains: ['douyin.com'],
  });
  assert.notEqual(r.profileId, 'Profile 1', '把默认配置分给店铺了');
  assert.ok(['Profile 2', 'Profile 3'].includes(r.profileId), '分到的不是用户配置：' + r.profileId);
  assert.equal(r.shared, false);
});

test('B3 只剩默认配置 → 拒绝，并提示去新建「用户配置」', () => {
  assert.throws(
    () => host.allocateEgoProfile({ profiles: [{ id: 'Profile 1', name: 'nagisa', isDefault: true }], others: [], cookieDomains: ['douyin.com'] }),
    /默认配置|用户配置/,
  );
});

test('B4 同平台同身份的两家店 → 不共用；只剩冲突配置时如实报错', () => {
  const others = [
    { id: 'acc_pdd_a', egoProfile: 'Profile 3', platform: 'pdd', accountType: 'seller' },
    { id: 'acc_pdd_b', egoProfile: 'Profile 2', platform: 'pdd', accountType: 'seller' },
  ];
  assert.throws(
    () => host.allocateEgoProfile({ profiles: PROFILES, others, platform: 'pdd', accountType: 'seller' }),
    /用户配置/,
  );
});

test('B5 不同平台的店铺可以共用同一份「用户配置」（空间各自独立）', () => {
  const others = [
    { id: 'acc_pdd', egoProfile: 'Profile 3', platform: 'pdd', accountType: 'seller' },
    { id: 'acc_jd', egoProfile: 'Profile 2', platform: 'jd', accountType: 'seller' },
  ];
  const r = host.allocateEgoProfile({ profiles: PROFILES, others, platform: 'taobao', accountType: 'seller' });
  assert.equal(r.shared, true, '不同平台居然没共用');
  assert.equal(r.profileId, 'Profile 3');
  assert.notEqual(r.profileId, 'Profile 1', '共用了默认配置');
});

test('B6 同一平台的买家与卖家也可以共用（只有同身份才必须分开）', () => {
  const others = [
    { id: 'acc_tb_seller', egoProfile: 'Profile 3', platform: 'taobao', accountType: 'seller' },
    { id: 'acc_tb_seller2', egoProfile: 'Profile 3', platform: 'taobao', accountType: 'seller' },
    { id: 'acc_jd', egoProfile: 'Profile 2', platform: 'jd', accountType: 'seller' },
  ];
  const r = host.allocateEgoProfile({ profiles: PROFILES, others, platform: 'taobao', accountType: 'buyer' });
  assert.equal(r.shared, true, '买家应该能和卖家共用');
  assert.equal(r.profileId, 'Profile 3');
});

test('B7 显式 allowShare:false 时只接受完全空着的配置（不共用）', () => {
  const others = [
    { id: 'acc_pdd', egoProfile: 'Profile 3', platform: 'pdd', accountType: 'seller' },
    { id: 'acc_jd', egoProfile: 'Profile 2', platform: 'jd', accountType: 'seller' },
  ];
  assert.throws(
    () => host.allocateEgoProfile({ profiles: PROFILES, others, platform: 'taobao', accountType: 'seller', allowShare: false }),
    /用户配置/,
  );
});

test('B8 ensureEgoProfile 发现「共用 + 默认配置」的历史记录会清掉重新分配', () => {
  assert.ok(indexSrc.includes('account.egoSharedProfile === true'), '没检查历史共用记录');
  assert.ok(indexSrc.includes('p.isDefault'), '没排除默认配置');
  assert.ok(indexSrc.includes("appendDebug('ego-profile-default-shared'"), '没记录这次自愈');
});

test('B9 分配结果写回账号时区分「独占 / 共用」', () => {
  assert.ok(indexSrc.includes('egoSharedProfile: false'), '没写独占标记');
  assert.ok(indexSrc.includes('egoSharedProfile: true'), '没写共用标记');
});

test('B10 换了 profile 就清掉旧 spaceId（空间属于某个 profile，不清会开回旧档案）', () => {
  assert.ok(indexSrc.includes('if (changed) patch.egoSpaceId = 0;'), 'profile 变了没清 spaceId');
  assert.ok(indexSrc.includes("const changed = String((findAccount(account.id) || {}).egoProfile || '') !== picked.profileId;"), '没比较新旧 profile');
});

test('B11 自愈「共用 + 默认配置」时也清掉 spaceId', () => {
  assert.ok(indexSrc.includes('patchAccount(account.id, { egoProfile: \'\', egoSharedProfile: false, egoSpaceId: 0 })'), '自愈时没清 spaceId');
});

// ── C. 文档 ─────────────────────────────────────────────────────────────────

function versionAtLeast(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

test('C1 版本号已到 0.18.2', () => {
  assert.ok(versionAtLeast(pkg.version, '0.18.2'), '版本还停在 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次修正', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.18.2'), 'CHANGELOG 没写 v0.18.2');
  assert.ok(changelog.includes('默认配置'), 'CHANGELOG 没提默认配置');
  const readme = read('README.md');
  assert.ok(readme.includes('0.18.2'), 'README 没写 0.18.2');
  assert.ok(readme.includes('用户配置'), 'README 没提用户配置');
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
