/**
 * v0.20.2 自检：到点采集自己把 ego 拉起来。
 *
 * 现场（用户反馈：四个店的定时采集全部「上次失败」）：
 * 12:00 / 12:30 到点时 ego lite 没在运行，采集链路的每个配方都拿回同一句
 * 「ego lite 没在运行 —— 插件不会为了查状态把整个浏览器拉起来」，
 * 于是一次跑完全部失败（`ALL_FAILED`、产物 0 个）。
 *
 * 修法：
 *   · 定时采集属于「要开窗口」的动作，和「打开店铺」同等对待：
 *     到点先探活，不在就 `ensureEgoApp` 启动；启动失败把原因写回账号（`EGO_LAUNCH_FAILED`）；
 *   · 顺带修 `memGB()` 少了 `node:os` 的导入（拆分时丢的），否则每组大小永远按 0 算。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const indexSrc = readServerSource(ROOT);
const schedulerSrc = read('lib/scheduler-run.mjs');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}
const at = (needle) => {
  const i = schedulerSrc.indexOf(needle);
  assert.ok(i >= 0, '源码里找不到：' + needle);
  return i;
};

console.log('1. 定时采集自动启动 ego（源码）');

await test('A1 memGB 真的读内存（补回 node:os 导入）', () => {
  assert.match(schedulerSrc, /^import os from 'node:os';/m, '缺少 node:os 导入');
  assert.ok(schedulerSrc.includes('os.totalmem()'), 'memGB 要读 os.totalmem()');
});

await test('A2 引入了 ensureEgoApp', () => {
  assert.match(schedulerSrc, /import \{ .*ensureEgoApp.*\} from '\.\/ego-lifecycle\.mjs';/, '要从 ego-lifecycle 导入 ensureEgoApp');
});

await test('A3 启动检查排在准备作业之前', () => {
  const ensure = at('await ensureEgoApp(cfgNow)');
  const prepare = at('const prepareFn =');
  assert.ok(ensure < prepare, '启动 ego 必须在 prepareFn 之前');
});

await test('A4 只在 ego 后端做启动', () => {
  assert.ok(schedulerSrc.includes("if (backendFor(cfgNow) === 'egolite') {"), '启动分支要限定 ego 后端');
});

await test('A5 先探活再启动', () => {
  const probe = at('await refreshEgoInfo(true)');
  const launch = at('await ensureEgoApp(cfgNow)');
  assert.ok(probe < launch, '要先 refreshEgoInfo 探活，再 ensureEgoApp');
  assert.ok(schedulerSrc.includes('info.running === false'), '探活结果要判断 running === false');
});

await test('A6 启动失败时记下原因并返回明确错误码', () => {
  assert.ok(schedulerSrc.includes("code: 'EGO_LAUNCH_FAILED'"), '要有 EGO_LAUNCH_FAILED');
  assert.ok(schedulerSrc.includes('lastSchedError: error'), '失败原因要写回账号');
  assert.match(
    schedulerSrc,
    /applyCollectionResult\(account, \{ status: 'failed', note: error, by: 'schedule' \}\)/,
    '采集卡片要记成失败',
  );
});

await test('A7 失败文案说明怎么补救', () => {
  assert.ok(schedulerSrc.includes('自动启动失败'), '文案要说清是启动失败');
  assert.ok(schedulerSrc.includes('点「启动 ego」'), '文案要给出手动补救入口');
});

console.log('\n2. 行为：memGB 不再是 0');

await test('B1 memGB 能读到本机内存（大于 0）', async () => {
  const { memGB } = await import('../lib/scheduler-run.mjs');
  const v = memGB();
  assert.ok(Number(v) > 0, 'memGB 读不到内存（仍按 0 算会退化成每组 1 个）：' + v);
});

console.log('\n3. 版本与文档');

await test('C1 版本号已到 0.20.2', () => {
  const parts = String(pkg.version).split('.').map((x) => Number(x));
  assert.ok(parts[0] > 0 || (parts[0] === 0 && (parts[1] > 20 || (parts[1] === 20 && parts[2] >= 2))), '版本应 ≥ 0.20.2：' + pkg.version);
});

await test('C2 CHANGELOG 与 README 同步', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.20.2'), 'CHANGELOG 要有 v0.20.2');
  assert.ok(changelog.includes('自动启动 ego'), 'CHANGELOG 要说明定时采集自动启动 ego');
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.version), 'README 版本行没跟上 ' + pkg.version);
});

if (failures.length) {
  console.log('\n✗ 失败 ' + failures.length + ' / 通过 ' + passed);
  for (const f of failures) console.log('  [' + f.name + ']');
  for (const f of failures) console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  process.exit(1);
}
console.log('\n✓ 全部通过（' + passed + ' 项）');
