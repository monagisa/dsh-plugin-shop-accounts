/**
 * v0.18.11 自检：买家（C 端）账号不做数据采集。
 *
 * 用户反馈（2026-11-05）：买家账号的详情页里也有「数据采集」卡片和采集域
 * （采集域是按平台来的，抖店买家也拿到抖店的 5 个域），看着像买家也能采。
 *
 * 事实：采集读的是商家后台的报表页面（千牛 / 抖店后台 / 京麦 / mms），C 端买家没有这些页面，
 * 给买家账号勾采集域只会让定时任务到点失败。所以这一版：
 *  - 买家账号的采集配置一律清空、collectionReady 恒 false、不显示采集域；
 *  - 采集相关接口拒绝（COLLECTION_UNSUPPORTED_BUYER）；
 *  - 定时任务对买家账号只做静默登录检测；
 *  - 界面不再给买家账号显示「数据采集」整块。
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
const clientSrc = read('lib/client.js');
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

/** 从源码里截一段（起止标记都必须是唯一出现，否则会截错）。 */
function sliceOf(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  assert.ok(s >= 0, '找不到片段起点：' + startMark.slice(0, 40));
  const e = src.indexOf(endMark, s);
  assert.ok(e > s, '找不到片段终点：' + endMark.slice(0, 40));
  return src.slice(s, e);
}
const slice = (startMark, endMark) => sliceOf(indexSrc, startMark, endMark);

// ── A. 服务端：买家账号没有采集 ────────────────────────────────────────────────

test('A1 有「买家账号不采集」的统一判据与文案', () => {
  assert.ok(indexSrc.includes('function isBuyerAccount(a)'), '没有 isBuyerAccount 判据');
  assert.ok(indexSrc.includes("normalizeAccountType(a && a.accountType) === 'buyer'"), 'isBuyerAccount 判据不对');
  const seg = slice('const BUYER_COLLECT_UNSUPPORTED', 'function ');
  assert.ok(seg.includes('买家账号不做数据采集'), '错误文案没写「买家账号不做数据采集」');
  assert.ok(seg.includes('商家后台'), '错误文案没解释为什么（商家后台报表）');
});

test('A2 /state 里买家账号的采集配置被清空、不算「配了采集」、不给采集域', () => {
  assert.ok(indexSrc.includes('collection: isBuyerAccount(a)'), '/state 没区分买家');
  assert.ok(indexSrc.includes('collectionReady: !isBuyerAccount(a) && collectionReady(a)'), '/state 的 collectionReady 没排除买家');
  assert.ok(indexSrc.includes('collectionDomains: isBuyerAccount(a) ? [] :'), '/state 还给买家下发采集域');
  assert.ok(indexSrc.includes('collectionDue: isBuyerAccount(a) ? false :'), '/state 还给买家算采集到期');
});

test('A3 采集相关接口对买家账号一律拒绝', () => {
  assert.ok(indexSrc.includes("code: 'COLLECTION_UNSUPPORTED_BUYER'"), '没有拦截错误码');
  const seg = slice('const kind = mCollect[2];', 'if (kind === \'collection\' && method === \'PUT\') {');
  assert.ok(seg.includes('isBuyerAccount(account)'), '拦截没对准买家账号');
  assert.ok(seg.includes('COLLECTION_UNSUPPORTED_BUYER'), '拦截没返回错误码');
  assert.ok(seg.includes("kind !== 'collect-records'") && seg.includes("kind !== 'collect-jobs'"), '只读接口也被挡了');
});

test('A4 定时任务对买家账号不跑采集（退回静默检测）', () => {
  const seg = slice('const wantsCollect =', 'const backend = backendFor(readConfig());');
  assert.ok(seg.includes('!isBuyerAccount(account)'), '定时任务没排除买家账号');
  assert.ok(seg.includes('collectionReady(account)'), '定时任务不再看采集域了');
});

test('A5 建买家账号时忽略传进来的采集配置', () => {
  const seg = slice('// 采集配置：建号时就可以带上', 'const name = capStr(');
  assert.ok(seg.includes('isBuyerAccount({ accountType })'), '建号时没判断买家');
  assert.ok(seg.includes('normalizeCollection({}, {}, { allow: allowedDomains(platform.id) })'), '买家没建成空采集');
});

test('A6 卖家改成买家时把原来的采集清空', () => {
  const seg = slice('if (body.collection !== undefined) {', 'if (typeof body.profileDir === \'string\'');
  assert.ok(seg.includes("typeNow === 'buyer'"), '改身份时没判断买家');
  assert.ok(seg.includes('else if (normalizeAccountType(patch.accountType || account.accountType) === \'buyer\')'), '没显式传 collection 时没有兜底清空');
  assert.ok(seg.includes('normalizeCollection({}, {}, { allow: allowedDomains(account.platform) })'), '没把采集配置清成空');
});

test('A7 采集清单（action=collections）不列买家账号', () => {
  assert.ok(indexSrc.includes('.filter((a) => !isBuyerAccount(a) && (collectionReady(a) || due.some((d) => d.id === a.id)))'), '采集清单还把买家算进去了');
});

// ── B. 客户端：买家不显示「数据采集」整块 ───────────────────────────────────────

test('B1 买家账号的详情页不渲染数据采集卡片', () => {
  assert.ok(clientSrc.includes("isBuyer ? null : h('div', { className: 'sa-dsec' },"), '客户端没按身份跳过采集卡片');
});

test('B2 跳过那一行带版本注释，且用的就是详情页里的 isBuyer', () => {
  const seg = sliceOf(clientSrc, "// v0.18.11：买家（C 端）账号没有商家后台的报表页面", "h('div', { className: 'sa-dcard' },");
  assert.ok(seg.includes('isBuyer ? null :'), '注释下面那行不是按身份跳过');
  assert.ok(clientSrc.includes('var isBuyer = type === \'buyer\';'), '详情页没有 isBuyer 变量');
});

// ── C. 文档与版本 ─────────────────────────────────────────────────────────────

test('C1 版本号已到 0.18.11', () => {
  assert.ok(versionAtLeast(pkg.version, '0.18.11'), '版本还停在 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次改动', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.18.11'), 'CHANGELOG 没写 v0.18.11');
  assert.ok(changelog.includes('买家账号'), 'CHANGELOG 没提买家账号');
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.version), 'README 没跟上 ' + pkg.version);
  assert.ok(readme.includes('买家账号不做数据采集'), 'README 没说明买家账号不做采集');
});

void host;

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
