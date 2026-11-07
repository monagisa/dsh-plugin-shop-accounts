/**
 * v0.18.4 自检：ego 配置的共用规则。
 *
 * 用户给的口径（2026-11-05）：
 *  - 抖音（抖店）/ 千牛（淘宝）/ 拼多多这些**不同平台**的店铺可以共用一份「用户配置」，
 *    各自开自己的空间就行；
 *  - 同一平台的两家店（比如两个拼多多店铺）必须用**分开**的用户配置；
 *  - 同一平台的**买家与卖家**也可以共用。
 *
 * 所以「必须分开」的判据收窄成：**同一平台 + 同一身份**。默认配置永远留给用户自己。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href);
const host = (mod.default && typeof mod.default.apply === 'function') ? mod.default : mod;
const indexSrc = readServerSource(ROOT);
const pkg = JSON.parse(read('package.json'));

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

function versionAtLeast(actual, floor) {
  const a = String(actual).split('.').map(Number);
  const b = String(floor).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

const PROFILES = [
  { id: 'Profile 3', name: '用户配置 1', isDefault: false },
  { id: 'Profile 1', name: 'nagisa', isDefault: true },
  { id: 'Profile 2', name: '用户配置 2', isDefault: false },
];
const twoUsers = [
  { id: 'acc_pdd', egoProfile: 'Profile 3', platform: 'pdd', accountType: 'seller' },
  { id: 'acc_jd', egoProfile: 'Profile 2', platform: 'jd', accountType: 'seller' },
];

// ── A. 共用规则 ─────────────────────────────────────────────────────────────────

test('A1 有空着的用户配置时优先用空配置（不与人共登录态）', () => {
  const r = host.allocateEgoProfile({ profiles: PROFILES, others: [], platform: 'taobao', accountType: 'seller' });
  assert.equal(r.shared, false, '有空配置还去共用');
  assert.notEqual(r.profileId, 'Profile 1', '分到了默认配置');
});

test('A2 用户配置都被占着时，不同平台可以共用', () => {
  const r = host.allocateEgoProfile({ profiles: PROFILES, others: twoUsers, platform: 'taobao', accountType: 'seller' });
  assert.equal(r.shared, true, '不同平台居然不能共用');
  assert.ok(['Profile 2', 'Profile 3'].includes(r.profileId), '分到了默认配置：' + r.profileId);
});

test('A3 同平台同身份的两家店 → 不能共用，挤不下就报错', () => {
  const others = [
    { id: 'acc_pdd_a', egoProfile: 'Profile 3', platform: 'pdd', accountType: 'seller' },
    { id: 'acc_pdd_b', egoProfile: 'Profile 2', platform: 'pdd', accountType: 'seller' },
  ];
  assert.throws(
    () => host.allocateEgoProfile({ profiles: PROFILES, others, platform: 'pdd', accountType: 'seller' }),
    /用户配置/,
  );
});

test('A4 两个拼多多店铺在有第三份用户配置时各自分开', () => {
  const profiles = PROFILES.concat([{ id: 'Profile 4', name: '用户配置 3', isDefault: false }]);
  const others = [{ id: 'acc_pdd_a', egoProfile: 'Profile 3', platform: 'pdd', accountType: 'seller' }];
  const r = host.allocateEgoProfile({ profiles, others, platform: 'pdd', accountType: 'seller' });
  assert.equal(r.shared, false, '同平台同身份居然共用了');
  assert.notEqual(r.profileId, 'Profile 3', '挤进了另一家拼多多店铺的配置');
  assert.notEqual(r.profileId, 'Profile 1', '分到了默认配置');
});

test('A5 同一平台的买家与卖家可以共用', () => {
  const others = [
    { id: 'acc_tb_seller', egoProfile: 'Profile 3', platform: 'taobao', accountType: 'seller' },
    { id: 'acc_jd', egoProfile: 'Profile 2', platform: 'jd', accountType: 'seller' },
  ];
  const r = host.allocateEgoProfile({ profiles: PROFILES, others, platform: 'taobao', accountType: 'buyer' });
  assert.equal(r.shared, true, '买家应该能和卖家共用一份配置');
  assert.equal(r.profileId, 'Profile 3', '没挑到卖家那份配置');
});

test('A6 默认配置永远不参与（即使只剩它空着）', () => {
  const profiles = [{ id: 'Profile 1', name: 'nagisa', isDefault: true }];
  assert.throws(
    () => host.allocateEgoProfile({ profiles, others: [], platform: 'taobao', accountType: 'seller' }),
    /用户配置/,
  );
});

test('A7 allowShare:false 时只接受完全空着的配置', () => {
  assert.throws(
    () => host.allocateEgoProfile({ profiles: PROFILES, others: twoUsers, platform: 'taobao', accountType: 'seller', allowShare: false }),
    /用户配置/,
  );
});

test('A8 空配置优先（哪怕有人可以共用）', () => {
  const r = host.allocateEgoProfile({ profiles: PROFILES, others: [], platform: 'pdd', accountType: 'seller' });
  assert.equal(r.shared, false);
  assert.ok(['Profile 2', 'Profile 3'].includes(r.profileId));
});

// ── B. 接线到真实分配流程 ─────────────────────────────────────────────────────

test('B1 ensureEgoProfile 传给分配函数的 others 带「平台 + 身份」', () => {
  assert.ok(indexSrc.includes('platform: String(a.platform || \'\'),'), 'others 没带 platform');
  assert.ok(indexSrc.includes("accountType: String(normalizeAccountType(a.accountType) || 'seller'),"), 'others 没带 accountType');
});

test('B2 调用分配函数时把当前店铺的平台与身份一起传进去', () => {
  assert.ok(indexSrc.includes("platform: String(account.platform || ''),"), '调用时没传 platform');
  assert.ok(/accountType: String\(normalizeAccountType\(account\.accountType\)/ .test(indexSrc), '调用时没传 accountType');
});

// ── C. 文档 ───────────────────────────────────────────────────────────────────

test('C1 版本号已到 0.18.4', () => {
  assert.ok(versionAtLeast(pkg.version, '0.18.4'), '版本还停在 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次的共用规则', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.18.4'), 'CHANGELOG 没写 v0.18.4');
  assert.ok(changelog.includes('共用'), 'CHANGELOG 没提共用规则');
  const readme = read('CHANGELOG.md');
  assert.ok(readme.includes('0.18.4'), 'CHANGELOG 没写 0.18.4');
  assert.ok(readme.includes('共用'), 'README 没说明共用规则');
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
