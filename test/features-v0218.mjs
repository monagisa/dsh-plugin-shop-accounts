#!/usr/bin/env node
/**
 * features-v0218.mjs —— v0.20.18：采集数据的命名规范
 *
 *   A. 作业目录用可读 id（job_<YYYYMMDD-HHmm>_<随机 6 位>），目录名 = jobId
 *   B. 下载产物改名成 <dslId>_<YYYYMMDD-HHmm>_<原始文件名>，并写 artifacts/manifest.json
 *   C. 保留上限：有数据的留最近 20 次、只有失败/空数据的留最近 3 次
 *   D. 旧目录（旧随机 id）仍然读得出来；仓库里不再生成旧的 base36 id
 *   E. 迁移工具在 tools/ 里，能按 job.json 的 createdAt 换算目录名
 *
 * 全离线：临时数据目录 + 假配方，不碰浏览器。
 * 跑法：node test/features-v0218.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0218-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
const section = (text) => console.log('\n' + text);
const versionAtLeast = (version, want) => {
  const a = String(version || '').split('.').map((n) => Number(n) || 0);
  const b = String(want || '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
};

const J = await import(url('lib/collect-runner.mjs'));
const R = await import(url('lib/rpa.mjs'));
const pkg = JSON.parse(read('package.json'));

const MATCH = (raw, opts) => R.compileExecution(raw, opts);
const fakeAccount = () => ({ id: 'acc_taobao_v218a', platform: 'taobao', name: 'v218a' });
const fakeDsl = (id) => ({
  id,
  meta: { id, platform: 'taobao' },
  raw: { id, platform: 'taobao', template: { steps: [{ action: 'goto', url: 'https://example.com/item' }] } },
});

// ── A. 可读 id ──────────────────────────────────────────────────────────────
section('A. 作业目录名带上时间');

await test('runStamp / readableJobId 按本地时间拼出可读 id', () => {
  assert.equal(typeof J.runStamp, 'function', 'runStamp 没导出');
  assert.equal(typeof J.readableJobId, 'function', 'readableJobId 没导出');
  assert.equal(J.runStamp(new Date('2026-11-11T12:30:00')), '20261111-1230');
  assert.equal(J.readableJobId(new Date('2026-11-11T12:30:00'), 'abc123'), 'job_20261111-1230_abc123');
});

await test('prepare：jobId 可读，且目录名就是 jobId', () => {
  const out = J.prepareJob({ account: fakeAccount(), dsls: [fakeDsl('tb_demo_218')], skipCovered: false }, MATCH);
  assert.equal(out.success, true);
  assert.match(out.data.job_id, /^job_(\d{8}-\d{4})_[a-z0-9]{3,12}$/, 'jobId 不是可读格式：' + out.data.job_id);
  assert.equal(path.basename(out.data.job_dir), out.data.job_id, '目录名应与 jobId 一致');
});

// ── B. 产物命名 + manifest ─────────────────────────────────────────────────
section('B. 下载产物按配方与时间命名，并写 manifest');

await test('organizeArtifacts：文件改成 <dslId>_<时间>_<原名>，manifest 记清文件名与字节', () => {
  const jobDir = path.join(TMP, 'artifacts-job');
  fs.mkdirSync(jobDir, { recursive: true });
  const artSub = path.join(jobDir, 'artifacts', 't_001');
  fs.mkdirSync(artSub, { recursive: true });
  const origName = '抖音电商罗盘-成交分析-20261005-20261103.xlsx';
  const file = path.join(artSub, origName);
  fs.writeFileSync(file, 'xlsx-bytes', 'utf8');
  const job = {
    jobId: 'job_20261111-1230_abc123',
    accountId: 'acc_taobao_v218a',
    accountName: 'v218a',
    platform: 'taobao',
    createdAt: '2026-11-11T04:30:00.000Z',
    finishedAt: '',
    plan: { window: { start: '2026-10-05', end: '2026-11-03' } },
    tasks: [{ taskId: 't_001', dslId: 'douyin_shop_transaction', state: 'ok', artifacts: [{ present: true, kind: 'download_ref', outputKey: 'xlsx', bytes: 11, filePath: file }] }],
  };
  const manifest = J.organizeArtifacts(jobDir, job);
  const name = path.basename(job.tasks[0].artifacts[0].filePath);
  assert.match(name, /^douyin_shop_transaction_\d{4}-\d{4}_|^douyin_shop_transaction_\d{8}-\d{4}_/, '产物名没带配方与时间：' + name);
  assert.ok(name.endsWith(origName), '原始文件名要留在后缀里');
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].fileName, name);
  assert.equal(manifest.naming, '<dslId>_<YYYYMMDD-HHmm>_<原始文件名>');
  const manifestFile = path.join(jobDir, 'artifacts', 'manifest.json');
  assert.ok(fs.existsSync(manifestFile), 'manifest.json 没落盘');
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).jobId, 'job_20261111-1230_abc123');
});

// ── C. 保留上限 ─────────────────────────────────────────────────────────────
section('C. 作业目录按保留上限清理');

await test('pruneJobs：只留有数据的最新 keepOk 次，只有失败的最多 keepFailed 次', () => {
  assert.equal(typeof J.pruneJobs, 'function', 'pruneJobs 没导出');
  const accountId = 'acc_taobao_v218b';
  const root = path.join(process.env.DSH_SHOP_ACCOUNTS_DIR, 'collection', accountId, 'jobs');
  fs.mkdirSync(root, { recursive: true });
  const make = (tail, day, okTask) => {
    const jobId = 'job_2026110' + day + '-1200_' + tail;
    const dir = path.join(root, jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'job.json'),
      JSON.stringify({ version: 1, jobId, accountId, createdAt: '2026-11-0' + day + 'T04:00:00.000Z', finished: true, plan: { window: { start: '', end: '' } }, tasks: [{ taskId: 't_001', dslId: 'x', state: okTask ? 'ok' : 'failed' }] }, null, 2),
      'utf8'
    );
    return dir;
  };
  const okA = make('aaa1', 1, true);
  const okB = make('bbb2', 2, true);
  const okC = make('ccc3', 3, true);
  const badA = make('ddd4', 4, false);
  const badB = make('eee5', 5, false);
  const out = J.pruneJobs(accountId, { keepOk: 2, keepFailed: 1 });
  const left = fs.readdirSync(root);
  assert.equal(out.removed, 2, '应删掉 2 个（1 个旧的成功 + 1 个旧的失败）');
  assert.equal(left.length, 3, '留 2 个成功 + 1 个失败：' + left.join(','));
  assert.ok(fs.existsSync(okC), '最新的成功作业不该被删');
  assert.ok(fs.existsSync(okB), '第二新的成功作业不该被删');
  assert.ok(!fs.existsSync(okA), '最旧的成功作业应被删');
  assert.ok(fs.existsSync(badB), '最新的失败作业不该被删');
  assert.ok(!fs.existsSync(badA), '最旧的失败作业应被删');
});

// ── D. 兼容旧目录 ───────────────────────────────────────────────────────────
section('D. 旧目录还能读');

await test('jobDirFor 仍接受旧的随机 id，listJobs 能读到它', () => {
  const accountId = 'acc_taobao_v218c';
  const oldId = 'job_mw1k5t79_s9l6vh';
  const dir = J.jobDirFor(accountId, oldId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'job.json'),
    JSON.stringify({ version: 1, jobId: oldId, accountId, createdAt: '2026-11-04T03:29:00.000Z', finished: true, plan: { window: { start: '', end: '' } }, tasks: [] }, null, 2),
    'utf8'
  );
  const list = J.listJobs(accountId);
  assert.ok(list.data.jobs.some((j) => j.jobId === oldId), '旧 id 的作业没被列出来');
});

await test('仓库里不再生成旧的 base36 作业 id', () => {
  const src = read('lib/collect-runner.mjs');
  assert.ok(!src.includes('Date.now().toString(36)'), '还在用 base36 时间戳拼 job id');
  assert.ok(src.includes('readableJobId(new Date())'), '新建作业没用可读 id');
});

// ── E. 迁移工具 ─────────────────────────────────────────────────────────────
section('E. 迁移工具');

await test('tools/migrate-collect-naming.mjs 能换算目录名、补 manifest、按上限清理', () => {
  const tool = read('tools/migrate-collect-naming.mjs');
  assert.ok(tool.includes('readableJobId('), '迁移工具没有按 createdAt 换算 job id');
  assert.ok(tool.includes('fs.renameSync('), '迁移工具没有改名动作');
  assert.ok(tool.includes('writeManifest('), '迁移工具没有补 manifest');
  assert.ok(tool.includes('pruneJobs('), '迁移工具没有按保留上限清理');
  assert.ok(tool.includes("'--dry'") || tool.includes('--dry'), '迁移工具缺 --dry 预览');
  assert.ok(fs.existsSync(path.join(ROOT, 'tools', 'migrate-collect-naming.mjs')));
});

// ── F. 版本与文档 ────────��────────────────────────────────────────────────────
section('F. 版本与文档');

await test('版本号已到 0.20.18', () => {
  assert.ok(versionAtLeast(pkg.version, '0.20.18'), '版本应 ≥ 0.20.18：' + pkg.version);
});

await test('CHANGELOG 与 README 写清了采集数据命名', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');
  assert.ok(changelog.includes('v0.20.18'), 'CHANGELOG 缺 v0.20.18');
  assert.ok(changelog.includes('命名'), 'CHANGELOG 没讲命名规范');
  assert.ok(readme.includes(pkg.version), 'README 版本没跟上 ' + pkg.version);
});

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch { /* ignore */ }

console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' / 通过 ' + passed : '\u2713 全部通过（' + passed + ' 项）'));
process.exit(failures.length ? 1 : 0);
