/**
 * v0.17.7 自检：定时采集也要包含「下载型」配方。
 *
 * 背景（真机发现的缺陷）：抖音、京东的采集配方产物是浏览器下载的文件（download_ref），
 * v0.14.0 起插件已能落盘这些文件，但定时采集走的默认参数里**没有 includeDownload**，
 * 于是这些平台在定时任务里被当成「没有可跑的配方」，永远只会做登录态检测。
 *
 * 断言分三类：
 *   A 源码接线：runScheduledCollection 的默认 prepareFn 必须带上 includeDownload: true；
 *   B 真实接口行为：同一条抖音配方，includeDownload=false → 一条都不选（no_dsl_selected），
 *     includeDownload=true → 至少选中 1 条（这就是定时路径现在的行为）；
 *   C 版本与文档。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');

// ── 用临时数据目录启动插件，避免碰本机真实数据 ────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sa-0177-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = tmp;

const mod = await import(pathToFileURL(path.join(ROOT, 'lib/index.js')).href);
const store = await import(pathToFileURL(path.join(ROOT, 'lib/store.mjs')).href);

const logs = [];
const log = { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m), error: (m) => logs.push('error ' + m), debug: () => {} };

const registered = [];
mod.apply({ webServer: { register: (r) => { registered.push(r); return () => {}; } }, logger: log });
await new Promise((r) => setTimeout(r, 60));

const handler = registered[0] && registered[0].handler;
if (!handler) throw new Error('没有挂上路由');

function fakeRes() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; settle(); } };
  return { res, done };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.destroy = () => {};
  req.headers = { 'x-dsh-shop-accounts': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:43120' };
  const raw = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  process.nextTick(() => { if (raw) req.emit('data', Buffer.from(raw, 'utf8')); req.emit('end'); });
  return req;
}
async function call(method, p, body) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.statusCode, json, raw: res.body };
}

const BASE = '/shop-accounts';
const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, ok: true }); })
    .catch((err) => { results.push({ name, ok: false, error: String((err && err.message) || err) }); });
}

// ── A 源码接线 ────────────────────────────────────────────────────────────────
const indexSrc = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8');
const runnerSrc = fs.readFileSync(path.join(ROOT, 'lib/collect-runner.mjs'), 'utf8');

await check('A1 定时采集的默认 prepareFn 带上 includeDownload: true', () => {
  const line = indexSrc
    .split(/\r?\n/)
    .filter((l) => l.includes('prepareJobForAccount(account') && l.includes('drive: true'))
    .join('\n');
  assert.ok(line.length, '没找到定时采集的默认 prepareFn');
  assert.ok(/includeDownload:\s*true/.test(line), `默认 prepareFn 缺 includeDownload: true：${line.trim()}`);
  assert.ok(/skipCovered:\s*true/.test(line), '默认 prepareFn 缺 skipCovered: true');
});

await check('A2 runScheduledCollection 仍然只挑「这个平台」的配方', () => {
  assert.ok(runnerSrc.includes('no_dsl_selected'), 'collect-runner 里应有 no_dsl_selected');
  const seg = indexSrc.slice(indexSrc.indexOf('export async function runScheduledCollection'));
  assert.ok(/filter\(\(d\) => d\.platform === account\.platform\)/.test(seg), 'runScheduledCollection 没按平台挑配方');
  assert.ok(seg.includes('NO_DSL_FOR_PLATFORM'), '没有可跑配方时应明确报 NO_DSL_FOR_PLATFORM');
});

// ── B 真实接口行为：同一条配方，开关决定选不选 ────────────────────────────────
let douyinId = '';

await check('B0 建一个抖音卖家账号（扫码登录，不需要密码库）', async () => {
  const r = await call('POST', BASE + '/accounts', {
    platform: 'douyin',
    accountType: 'seller',
    loginMode: 'qrcode',
    name: '抖音自检店',
    loginName: 'dy@example.com',
  });
  assert.equal(r.status, 200, r.raw);
  douyinId = r.json.account.id;
  assert.ok(douyinId, '没拿到账号 id');
});

await check('B1 includeDownload=false：抖音的下载型配方一条都选不上（复现缺陷）', async () => {
  const r = await call('POST', BASE + '/accounts/' + douyinId + '/collect-job', {
    includeDownload: false,
    skipCovered: false,
  });
  assert.equal(r.status, 400, `应当是无法准备（现在：${r.raw}）`);
  const codes = (r.json.errors || []).map((e) => e.code);
  assert.ok(codes.includes('no_dsl_selected'), `错误码应为 no_dsl_selected，实际 ${JSON.stringify(codes)}`);
});

await check('B2 includeDownload=true：抖音的下载型配方被选中（定时路径现在的行为）', async () => {
  const r = await call('POST', BASE + '/accounts/' + douyinId + '/collect-job', {
    includeDownload: true,
    skipCovered: false,
  });
  assert.equal(r.status, 200, r.raw);
  const tasks = (r.json && r.json.tasks) || [];
  assert.ok(tasks.length >= 1, `应至少选中 1 条配方，实际 ${tasks.length}`);
  const ids = tasks.map((t) => t.dslId);
  assert.ok(ids.includes('douyin_shop_transaction') || ids.includes('douyin_shop_income_expense'), `选中了别的配方：${ids.join(',')}`);
});

await check('B3 选中后作业进入「等执行」状态（next_action=native_calls）', async () => {
  const r = await call('POST', BASE + '/accounts/' + douyinId + '/collect-job', {
    includeDownload: true,
    skipCovered: false,
  });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.json.next_action, 'native_calls', `实际 next_action=${r.json.next_action}`);
  assert.equal(r.json.plan.failedToPrepare.length, 0, '不该有「准备失败」的配方');
});

await check('B4 其它平台的下载型配方也被包含（京东）', async () => {
  const r = await call('POST', BASE + '/accounts', {
    platform: 'jd',
    accountType: 'seller',
    loginMode: 'qrcode',
    name: '京东自检店',
    loginName: 'jd@example.com',
  });
  assert.equal(r.status, 200, r.raw);
  const jdId = r.json.account.id;
  const job = await call('POST', BASE + '/accounts/' + jdId + '/collect-job', {
    includeDownload: true,
    skipCovered: false,
  });
  assert.equal(job.status, 200, job.raw);
  const ids = ((job.json && job.json.tasks) || []).map((t) => t.dslId);
  assert.ok(ids.includes('jd_traffic_overview'), `京东下载型配方没被选中：${ids.join(',')}`);
});

// ── C 版本与文档 ──────────────────────────────────────────────────────────────
await check('C1 版本号 ≥ 0.17.7', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const parts = String(pkg.version).split('.').map((n) => Number(n));
  const [maj, min, pat] = parts;
  assert.ok(maj === 0 && (min > 17 || (min === 17 && pat >= 7)), `版本号还是 ${pkg.version}`);
});

await check('C2 变更记录与说明里写了这一条', () => {
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes('0.17.7'), 'CHANGELOG 里没有 0.17.7');
  assert.ok(changelog.includes('下载'), 'CHANGELOG 里没说明下载型配方');
});

// ── 收尾 ──────────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' — ' + r.error}`).join('\n'));
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log('\n失败明细：\n' + failed.map((f) => `- ${f.name}: ${f.error}`).join('\n'));
  process.exit(1);
}
