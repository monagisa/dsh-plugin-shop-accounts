#!/usr/bin/env node
/**
 * features-v0140.mjs —— v0.14.0：下载落盘 + 采集作业编排（prepare/advance/status）
 *
 *   A. downloadFile：编译成 download op → driver 设下载目录 → 点按钮 → 轮询落盘 → download_ref 产物
 *   B. 编排层：job 目录 + revision + 每批 5 项 + 覆盖台账跳过 + 失败只重试一次 + 空结果不重试 + 交付清单
 *   C. HTTP：collect-job 的 prepare/status/advance 与 revision 校验
 *
 * 全离线：下载用 mock driver 真的写文件到临时目录；编排层不碰浏览器（执行由调用方回执）。
 * 跑法：node test/features-v0140.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { readServerSource } from './_src.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0140-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
process.env.SHOP_ACCOUNTS_DSL_DIR = '';

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

const R = await import(url('lib/rpa.mjs'));
const J = await import(url('lib/collect-runner.mjs'));

const ACC = 'acc_taobao_v140test';
const ACCOUNT = { id: ACC, platform: 'taobao', name: 'v140 淘宝店' };
const WINDOW = { start: '2026-10-03', end: '2026-11-01' };

/** 造一份最小的可执行配方。 */
function fakeDsl(id, { platform = 'taobao', withDownload = false } = {}) {
  const steps = [
    { action: 'goto', url: `https://sycm.taobao.com/${id}`, id: `${id}:entry` },
    { action: 'waitFor', target: [{ by: 'css', value: 'pre' }], state: 'visible', timeoutMs: 1000, id: `${id}:wait` },
    { action: 'readText', target: [{ by: 'css', value: 'pre' }], outputKey: 'body', id: `${id}:read` },
  ];
  const artifacts = [{ role: 'business', kind: 'json_string', output_key: 'body' }];
  if (withDownload) {
    steps.push({ action: 'downloadFile', target: [{ by: 'css', value: '#dl' }], outputKey: 'file', timeoutMs: 3000, id: `${id}:dl` });
    artifacts.push({ role: 'business', kind: 'download_ref', output_key: 'file' });
  }
  return { id, platform, raw: { id, platform, template: { steps }, collection: { artifacts } }, meta: { id, platform, hasDownload: withDownload } };
}

// ── A. 下载落盘 ─────────────────────────────────────────────────────────────
section('A. downloadFile：设下载目录 → 点按钮 → 轮询落盘 → download_ref 产物');

await test('编译：downloadFile → download op（带 outputKey/timeout）', () => {
  const compiled = R.compileExecution(fakeDsl('dl1', { withDownload: true }).raw, WINDOW);
  const dl = compiled.ops.find((o) => o.op === 'download');
  assert.ok(dl, '没有 download op');
  assert.equal(dl.outputKey, 'file');
  assert.ok(dl.timeoutMs >= 1000);
});

await test('执行：mock 浏览器落盘 → outputs 是文件路径 → download_ref 产物 present + bytes', async () => {
  const dlDir = path.join(TMP, 'dl-a');
  const compiled = R.compileExecution(fakeDsl('dl2', { withDownload: true }).raw, WINDOW);
  const driver = R.makeMockDriver({
    pages: { '*': { elements: { pre: { visible: true, text: '{"ok":1}' }, '#dl': { visible: true } } } },
    downloadName: 'report.xlsx',
    downloadBody: 'x'.repeat(1234),
  });
  const r = await R.runOps(compiled, driver, { downloadDir: dlDir });
  assert.equal(r.ok, true, r.error);
  const file = r.outputs.file;
  assert.ok(file && fs.existsSync(file), '下载文件不存在');
  const art = r.artifacts.find((a) => a.kind === 'download_ref');
  assert.equal(art.present, true);
  assert.equal(art.bytes, 1234);
  assert.ok(driver.calls.some((c) => c.op === 'setDownloadDir'));
});

await test('产物：download_ref 指向的文件不存在时 present=false（不留假成功）', () => {
  const arts = R.collectArtifacts(
    { collection: { artifacts: [{ role: 'business', kind: 'download_ref', output_key: 'f' }] } },
    { f: path.join(TMP, '根本没有这个文件.xlsx') },
  );
  assert.equal(arts[0].present, false);
  assert.equal(arts[0].bytes, 0);
});

await test('外部配方库：SHOP_ACCOUNTS_DSL_DIR 指到临时目录后能被发现', async () => {
  const D = await import(url('lib/dsls.mjs'));
  const ext = path.join(TMP, 'ext-dsl');
  fs.mkdirSync(path.join(ext, 'taobao'), { recursive: true });
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'rpa', 'dsls', 'taobao', 'tb_shop_overview.json'), 'utf8'));
  seed.id = 'ext_overview_demo';
  fs.writeFileSync(path.join(ext, 'taobao', 'ext_overview.json'), JSON.stringify(seed), 'utf8');
  const prev = process.env.SHOP_ACCOUNTS_DSL_DIR;
  process.env.SHOP_ACCOUNTS_DSL_DIR = ext;
  try {
    const { items, externalDir } = D.listDsls();
    assert.equal(externalDir, ext);
    assert.ok(items.some((d) => d.origin === 'external'), '外部配方库里那份没被发现');
  } finally {
    if (prev === undefined) delete process.env.SHOP_ACCOUNTS_DSL_DIR; else process.env.SHOP_ACCOUNTS_DSL_DIR = prev;
  }
});

// ── B. 编排层 ───────────────────────────────────────────────────────────────
section('B. 编排层：job / 分批 / 覆盖跳过 / 一次重试 / 交付');

const MATCH = (raw, opts) => R.compileExecution(raw, opts);
const fakeAccount = () => ({ id: 'acc_taobao_v140a', platform: 'taobao', name: 'v140a' });

await test('prepare：7 份配方 → 分 2 批（每批 ≤5），首批发 5 项', () => {
  const dsls = Array.from({ length: 7 }, (_, i) => fakeDsl(`p${i}`));
  const out = J.prepareJob({ account: fakeAccount(), dsls, skipCovered: false }, MATCH);
  assert.equal(out.success, true);
  assert.equal(out.data.next_action, 'native_calls');
  assert.equal(out.data.tasks.length, 5, '首批应为 5 项');
  assert.equal(out.data.batch.total, 2, '7 项应分 2 批');
  assert.ok(out.data.advance_call && out.data.advance_call.batchId);
  assert.ok(fs.existsSync(path.join(out.data.job_dir, 'job.json')), 'job.json 没落盘');
});

await test('prepare：平台不匹配 / 缺业务参数 → failedToPrepare 里点名原因', () => {
  const bad = fakeDsl('jd_only', { platform: 'jd' });
  const needParam = { id: 'need_param', platform: 'taobao', raw: { id: 'need_param', platform: 'taobao', template: { steps: [{ action: 'goto', url: 'https://x/?p={productId}' }] } }, meta: { id: 'need_param', platform: 'taobao' } };
  const out = J.prepareJob({ account: fakeAccount(), dsls: [bad, needParam], skipCovered: false }, MATCH);
  // v0.16.7 起：一条都没准备好、且不是「已采过」→ 明确失败并带错误码（否则上层会误报「今天已采过」）
  assert.equal(out.success, false);
  assert.ok(Array.isArray(out.errors) && out.errors.length === 2, '要带 errors');
  assert.equal(out.data.next_action, 'done');
  const reasons = out.data.plan.failedToPrepare.map((f) => f.reason).join(',');
  assert.match(reasons, /platform_mismatch/);
  assert.match(reasons, /INVALID_DSL/);
});

await test('advance：成功 → 记覆盖台账 → 下一批 → 末批交付', () => {
  const account = { id: 'acc_taobao_v140b', platform: 'taobao', name: 'b' };
  const dsls = Array.from({ length: 6 }, (_, i) => fakeDsl(`q${i}`));
  const p1 = J.prepareJob({ account, dsls, skipCovered: false }, MATCH).data;
  const results1 = p1.tasks.map((t) => ({
    taskId: t.taskId, ok: true, outputs: { body: '{"n":1}' },
    artifacts: [{ role: 'business', kind: 'json_string', outputKey: 'body', present: true, bytes: 7 }],
  }));
  const a1 = J.advanceJob({ accountId: account.id, jobId: p1.job_id, revision: p1.revision, batchId: p1.batch.batchId, results: results1 }, R.artifactStatus);
  assert.equal(a1.success, true);
  assert.equal(a1.data.next_action, 'native_calls', '还有第二批');
  assert.equal(a1.data.counts.ok, 5);
  const results2 = a1.data.tasks.map((t) => ({
    taskId: t.taskId, ok: true, outputs: { body: '{}' },
    artifacts: [{ role: 'business', kind: 'json_string', outputKey: 'body', present: true, bytes: 2 }],
  }));
  const a2 = J.advanceJob({ accountId: account.id, jobId: p1.job_id, revision: a1.data.revision, batchId: a1.data.advance_call.batchId, results: results2 }, R.artifactStatus);
  assert.equal(a2.data.next_action, 'done');
  assert.equal(a2.data.counts.ok, 6);
  assert.ok(a2.data.delivery, '没有交付清单');
  assert.equal(a2.data.delivery.artifacts.length, 6);
  // 再 prepare 同一批：应该因为已覆盖被跳过
  const again = J.prepareJob({ account, dsls, skipCovered: true }, MATCH).data;
  assert.equal(again.next_action, 'done');
  assert.equal(again.plan.skipped.length, 6);
});

await test('advance：失败只重试一次；第二轮仍失败 → 交付里标未完成（不再重试）', () => {
  const account = { id: 'acc_taobao_v140c', platform: 'taobao', name: 'c' };
  const dsls = [fakeDsl('r0')];
  const p = J.prepareJob({ account, dsls, skipCovered: false }, MATCH).data;
  const fail = p.tasks.map((t) => ({ taskId: t.taskId, ok: false, code: 'STEP_TIMEOUT', error: '慢' }));
  const a1 = J.advanceJob({ accountId: account.id, jobId: p.job_id, revision: p.revision, batchId: p.batch.batchId, results: fail }, R.artifactStatus);
  assert.equal(a1.data.next_action, 'native_calls', '第一次失败应重试');
  const a2 = J.advanceJob({ accountId: account.id, jobId: p.job_id, revision: a1.data.revision, batchId: a1.data.advance_call.batchId, results: a2fix(a1.data.tasks) }, R.artifactStatus);
  assert.equal(a2.data.next_action, 'done', '重试过就不再重试');
  assert.equal(a2.data.counts.failed, 1);
  assert.equal(a2.data.delivery.incomplete[0].attempts, 2);
});

function a2fix(tasks) {
  return tasks.map((t) => ({ taskId: t.taskId, ok: false, code: 'STEP_TIMEOUT', error: '还是慢' }));
}

await test('advance：空产物算 empty（业务无数据）→ 不重试', () => {
  const account = { id: 'acc_taobao_v140d', platform: 'taobao', name: 'd' };
  const p = J.prepareJob({ account, dsls: [fakeDsl('e0')], skipCovered: false }, MATCH).data;
  const empty = p.tasks.map((t) => ({
    taskId: t.taskId, ok: true, outputs: { body: '' },
    artifacts: [{ role: 'business', kind: 'json_string', outputKey: 'body', present: false, bytes: 0 }],
  }));
  const a1 = J.advanceJob({ accountId: account.id, jobId: p.job_id, revision: p.revision, batchId: p.batch.batchId, results: empty }, R.artifactStatus);
  assert.equal(a1.data.next_action, 'done', '空数据不该重试');
  assert.equal(a1.data.counts.empty, 1);
  assert.match(a1.data.delivery.incomplete[0].reason, /业务无数据/);
});

await test('advance：UNSUPPORTED_ACTION 不重试（配置问题重试也没用）', () => {
  const account = { id: 'acc_taobao_v140e', platform: 'taobao', name: 'e' };
  const p = J.prepareJob({ account, dsls: [fakeDsl('u0')], skipCovered: false }, MATCH).data;
  const bad = p.tasks.map((t) => ({ taskId: t.taskId, ok: false, code: 'UNSUPPORTED_ACTION', error: '不支持' }));
  const a1 = J.advanceJob({ accountId: account.id, jobId: p.job_id, revision: p.revision, batchId: p.batch.batchId, results: bad }, R.artifactStatus);
  assert.equal(a1.data.next_action, 'done');
  assert.equal(a1.data.counts.failed, 1);
});

await test('advance：回执缺失的项保留 pending（不猜、不重发）', () => {
  const account = { id: 'acc_taobao_v140f', platform: 'taobao', name: 'f' };
  const p = J.prepareJob({ account, dsls: [fakeDsl('m0'), fakeDsl('m1')], skipCovered: false }, MATCH).data;
  const only = p.tasks.slice(0, 1).map((t) => ({
    taskId: t.taskId, ok: true, outputs: { body: '{}' },
    artifacts: [{ role: 'business', kind: 'json_string', outputKey: 'body', present: true, bytes: 2 }],
  }));
  const a1 = J.advanceJob({ accountId: account.id, jobId: p.job_id, revision: p.revision, batchId: p.batch.batchId, results: only }, R.artifactStatus);
  assert.equal(a1.data.counts.pending, 1, '缺回执的那项应留 pending');
  assert.equal(a1.data.counts.ok, 1);
});

await test('advance：revision 不对 → 拒绝（防止重复推进）', () => {
  const account = { id: 'acc_taobao_v140g', platform: 'taobao', name: 'g' };
  const p = J.prepareJob({ account, dsls: [fakeDsl('v0')], skipCovered: false }, MATCH).data;
  const r = J.advanceJob({ accountId: account.id, jobId: p.job_id, revision: p.revision + 99, batchId: p.batch.batchId, results: [] }, R.artifactStatus);
  assert.equal(r.success, false);
  assert.equal(r.errors[0].code, 'revision_mismatch');
});

await test('status / list：只读快照，不改变 revision', () => {
  const account = { id: 'acc_taobao_v140h', platform: 'taobao', name: 'h' };
  const p = J.prepareJob({ account, dsls: [fakeDsl('s0')], skipCovered: false }, MATCH).data;
  const s1 = J.statusJob({ accountId: account.id, jobId: p.job_id }).data;
  const s2 = J.statusJob({ accountId: account.id, jobId: p.job_id }).data;
  assert.equal(s1.revision, s2.revision, 'status 不该改 revision');
  assert.equal(s1.counts.pending, 1);
  const list = J.listJobs(account.id).data.jobs;
  assert.ok(list.some((j) => j.jobId === p.job_id));
});

// ── C. HTTP ────────────────────────────────────────────────────────────────
section('C. HTTP：collect-job 的 prepare / status / advance');

const host = await import(url('lib/index.js'));
function fakeRes() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; settle(); } };
  return { res, done };
}
function fakeReq(method, reqUrl, body) {
  const req = new EventEmitter();
  req.method = method; req.url = reqUrl; req.destroy = () => {};
  req.headers = { 'x-dsh-shop-accounts': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:43120' };
  if (body !== undefined) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    process.nextTick(() => { req.emit('data', Buffer.from(raw, 'utf8')); req.emit('end'); });
  } else process.nextTick(() => req.emit('end'));
  return req;
}
const registered = [];
host.apply({ webServer: { register: (r) => { registered.push(r); return () => {}; } }, logger: { info() {}, warn() {}, error() {}, debug() {} } });
const handler = registered[0].handler;
async function call(method, p, body) {
  const { res, done } = fakeRes();
  handler(fakeReq(method, p, body), res);
  await done;
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* ignore */ }
  return { status: res.statusCode, json };
}

let accId = '';
await test('建店 + POST collect-job：出现 native_calls 与 tasks', async () => {
  const a = await call('POST', '/shop-accounts/accounts', { platform: 'taobao', loginName: 'v140@example.com', password: 'V140-P@ss1', name: 'v140 店' });
  assert.equal(a.status, 200);
  accId = a.json.account.id;
  const r = await call('POST', `/shop-accounts/accounts/${accId}/collect-job`, { dslIds: ['tb_shop_overview'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.next_action, 'native_calls');
  assert.ok(Array.isArray(r.json.tasks) && r.json.tasks.length >= 1);
  assert.ok(r.json.tasks[0].ops.length > 0, 'tasks 里应带编译好的 ops');
});

let jobId = '';
let revision = 0;
await test('GET collect-job/:jobId：状态可查；POST advance revision 不对 → 400', async () => {
  const prep = await call('POST', `/shop-accounts/accounts/${accId}/collect-job`, { dslIds: ['tb_shop_overview'], skipCovered: false });
  jobId = prep.json.job_id; revision = prep.json.revision;
  const s = await call('GET', `/shop-accounts/accounts/${accId}/collect-job/${jobId}`);
  assert.equal(s.status, 200);
  assert.equal(s.json.revision, revision);
  const bad = await call('POST', `/shop-accounts/accounts/${accId}/collect-job/${jobId}/advance`, { revision: revision + 5, results: [] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors[0].code, 'revision_mismatch');
});

await test('POST advance：回执后推进到 done 并给出交付清单', async () => {
  const s = await call('GET', `/shop-accounts/accounts/${accId}/collect-job/${jobId}`);
  const batch = s.json.batches.find((b) => !b.settled);
  const tasks = s.json.tasks.filter((t) => batch && batch.batchId);
  void tasks;
  const prep = await call('GET', `/shop-accounts/accounts/${accId}/collect-job/${jobId}`);
  void prep;
  // 用 pending 的 taskId 造回执
  const pendingIds = s.json.tasks.filter((t) => t.state === 'pending').map((t) => t.taskId);
  const results = pendingIds.map((id) => ({
    taskId: id, ok: true, outputs: { overviewResponse: '{"data":1}' },
    artifacts: [{ role: 'business', kind: 'json_string', outputKey: 'overviewResponse', present: true, bytes: 10 }],
  }));
  const r = await call('POST', `/shop-accounts/accounts/${accId}/collect-job/${jobId}/advance`, {
    revision: s.json.revision, batchId: batch && batch.batchId, results,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.next_action, 'done');
  assert.ok(r.json.delivery && r.json.delivery.artifacts.length >= 1);
});

await test('GET collect-jobs：能列出作业', async () => {
  const r = await call('GET', `/shop-accounts/accounts/${accId}/collect-jobs`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.jobs) && r.json.jobs.length >= 1);
});

await test('工具：action 枚举与服务端都有 collect-job / collect-advance', () => {
  const src = readServerSource(ROOT);
  assert.ok(src.includes('collect-job'), 'index.js 里没有 collect-job');
  assert.ok(src.includes('advanceJob'), '没有接 advanceJob');
  assert.ok(src.includes('prepareJobForAccount'), '没有 prepare 包装');
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.log(`\u2717 失败 ${failures.length} / 通过 ${passed}`);
  for (const f of failures) console.log(`  · ${f.name}: ${f.err && f.err.message}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
console.log(`\u2713 全部通过（${passed} 项）`);
fs.rmSync(TMP, { recursive: true, force: true });
