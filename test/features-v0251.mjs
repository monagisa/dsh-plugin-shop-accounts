/**
 * v0.20.51：采集数据的目录名与文件名带上店铺名（一眼能看出是哪家店）。
 *
 * 命名口径：
 *   jobs/job_<YYYYMMDD-HHmm>_<随机>_<店名>_<采集项>/
 *   artifacts/<taskId>/<采集项>_<YYYYMMDD-HHmm>_<店名>_<原始文件名>
 *
 * 没有店名的作业（老数据 / 手动构造）保持旧命名，不会因为升级而错位。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shopNameSafe } from '../lib/dsl-names.mjs';
import { organizeArtifacts, prepareJob } from '../lib/collect-runner.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v0251-'));

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name);
    console.log('       ' + String((err && err.message) || err).split('\n').slice(0, 6).join('\n       '));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function fakeDsl(id) {
  return JSON.parse(read('lib/rpa/dsls/taobao/tb_shop_overview.json'));
}

function writeFakeJob(dirName, accountName, dslId) {
  const jobDir = path.join(TMP, dirName);
  fs.mkdirSync(path.join(jobDir, 'artifacts', 't_001'), { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'artifacts', 't_001', dslId + '_20261120-1200_表格.xlsx'), 'x', 'utf8');
  fs.writeFileSync(
    path.join(jobDir, 'artifacts', 't_001.json'),
    JSON.stringify({ taskId: 't_001', dslId, state: 'ok', artifacts: [] }),
    'utf8',
  );
  const job = {
    version: 1,
    jobId: 'job_20261120-1200_abc123_' + dslId,
    accountId: 'acc_x',
    accountName,
    platform: 'taobao',
    createdAt: '2026-11-20T04:00:00Z',
    tasks: [{ taskId: 't_001', dslId, state: 'ok', artifacts: [], outputs: {} }],
  };
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  return { jobDir, job };
}

await test('A1 shopNameSafe：去掉路径非法字符，最多 20 字', () => {
  assert.equal(shopNameSafe('测试铺'), '测试铺');
  assert.equal(shopNameSafe('  a/b:c*d?e"f<g>h|i  '), 'abcdefghi');
  assert.equal(shopNameSafe('家庭作坊式经营的老店铺名字很长'), '家庭作坊式经营的老店铺名字很长');
  assert.equal(shopNameSafe('一二三四五六七八九十一二三四五六七八九十多余'), '一二三四五六七八九十一二三四五六七八九十');
});

await test('A2 没店名时返回空串（老数据保持旧命名）', () => {
  assert.equal(shopNameSafe(''), '');
  assert.equal(shopNameSafe(null), '');
  assert.equal(shopNameSafe('  '), '');
});

await test('B1 产物文件名带店铺名', () => {
  const { jobDir, job } = writeFakeJob('b1', '测试铺', 'tb_shop_overview');
  organizeArtifacts(jobDir, job);
  const files = fs.readdirSync(path.join(jobDir, 'artifacts'));
  assert.ok(
    files.some((f) => f.startsWith('采集数据_20261120-1200_测试铺')),
    '产物名没带店铺名：' + files.join(','),
  );
});

await test('B2 manifest 说明里写上店名这一段', () => {
  const { jobDir, job } = writeFakeJob('b2', '测试铺', 'tb_shop_overview');
  organizeArtifacts(jobDir, job);
  const manifest = JSON.parse(fs.readFileSync(path.join(jobDir, 'artifacts', 'manifest.json'), 'utf8'));
  assert.equal(manifest.naming, '<采集项>_<YYYYMMDD-HHmm>_<店名>_<原始文件名>');
  assert.equal(manifest.accountName, '测试铺');
  assert.ok(manifest.files.every((f) => String(f.fileName).includes('测试铺')), 'manifest 里的文件名没带店名');
});

await test('B3 没有店名的作业仍是旧命名（不会把老数据改坏）', () => {
  const { jobDir, job } = writeFakeJob('b3', '', 'tb_shop_overview');
  organizeArtifacts(jobDir, job);
  const manifest = JSON.parse(fs.readFileSync(path.join(jobDir, 'artifacts', 'manifest.json'), 'utf8'));
  assert.equal(manifest.naming, '<采集项>_<YYYYMMDD-HHmm>_<原始文件名>');
  const files = fs.readdirSync(path.join(jobDir, 'artifacts'));
  assert.ok(files.some((f) => f === '采集数据_20261120-1200.xlsx'), '旧命名被动过了：' + files.join(','));
});

await test('C1 作业目录名按「店名_采集项」排列', () => {
  const doc = fakeDsl('tb_shop_overview');
  const out = prepareJob(
    { account: { id: 'acc_taobao_mw05dt23d7jw', name: '测试铺', platform: 'taobao' }, dslIds: ['tb_shop_overview'], start: '2026-10-20', end: '2026-11-18' },
    () => ({ dsl: doc, ops: [], declaredArtifacts: [], postprocess: null, defaults: {} }),
  );
  if (!out.ok) return;
  const id = out.data.job_id;
  assert.match(id, /^job_\d{8}-\d{4}_[a-z0-9]{3,12}_测试铺_/, 'jobId 里没有店名：' + id);
  assert.ok(id.endsWith('_淘宝-店铺概览'), 'jobId 末尾不是采集项：' + id);
});

await test('D1 迁移工具也按店名补全（老数据能重命名）', () => {
  const tool = read('tools/migrate-collect-naming.mjs');
  assert.ok(tool.includes('shopNameSafe'), '迁移工具没导入 shopNameSafe');
  assert.ok(tool.includes('const shop = shopNameSafe(job.accountName);'), '迁移工具没读 job.accountName');
  assert.ok(tool.includes('const prefix = midPrefix + (shop ? shop + \'_\' : \'\');'), '迁移工具没把店名拼进产物前缀');
});

await test('E1 版本与文档写清了这次命名变化', () => {
  const pkg = JSON.parse(read('package.json'));
  const nums = String(pkg.version).split('.').map(Number);
  assert.ok(nums[0] > 0 || nums[1] > 20 || (nums[1] === 20 && nums[2] >= 51), 'package.json 版本没到 0.20.51：' + pkg.version);
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.20.51'), 'CHANGELOG 没有 v0.20.51');
  const readme = read('README.md');
  assert.ok(readme.includes('店名'), 'README 没写店名进命名');
  assert.ok(readme.includes(pkg.version), 'README 当前版本没跟上 package.json');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('');
console.log(fail === 0 ? '全部通过（' + pass + ' 项）' : '失败 ' + fail + ' / 通过 ' + pass);
if (fail) process.exit(1);
