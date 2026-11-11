// 自检：设置页「采集数据保存在哪」= 状态里下发采集数据目录 + 只读打开目录的接口（v0.20.16）。
// 需求：用户要求「添加一个设置，就说采集的数据存储在哪」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const serverSrc = readServerSource(ROOT);
const clientSrc = read('lib/client.js');
const pkg = JSON.parse(read('package.json'));

const stateSrc = read('lib/server/state.mjs');
const routesSrc = read('lib/server/routes.mjs');

function slice(src, startMark, endMark) {
  const start = src.indexOf(startMark);
  assert.ok(start >= 0, '找不到片段起点：' + startMark);
  const end = src.indexOf(endMark, start);
  assert.ok(end > start, '找不到片段终点：' + endMark);
  return src.slice(start, end);
}

let pts = 0;
async function test(name, fn) {
  await fn();
  pts += 1;
  console.log('  ✓ ' + name);
}

console.log('1. 状态与接口');

await test('A1 /state 里带上采集数据目录（和 dataDir 同源）', () => {
  assert.match(stateSrc, /collection: path\.join\(dataDir\(\), 'collection'\)/, '状态要下发采集数据目录');
  assert.ok(stateSrc.includes("import path from 'node:path';"), 'state 要导入 path');
  assert.ok(serverSrc.includes('paths:'), '状态对象里要有 paths');
});

await test('A2 有只读打开目录的接口：参数是 kind，不是任意路径', () => {
  const seg = slice(routesSrc, "if (method === 'POST' && p === '/data/reveal')", "// v0.20.17：数据目录");
  assert.ok(seg.includes("kind !== 'collection' && kind !== 'data'"), '只允许两种目录');
  assert.ok(!seg.includes('body.dir') && !seg.includes('body.path'), '不能接受任意路径');
  assert.ok(seg.includes('path.resolve(base)'), '目录必须落在插件数据目录内');
  assert.ok(seg.includes('ensureDir(dir)'), '目录不存在要先建出来（首次采集前也能打开）');
  assert.ok(seg.includes('osPlatform.revealDir(dir)'), '用平台层打开目录');
});

await test('A3 界面里有「数据目录」这一块 + 打开目录按钮（v0.20.17 起这块还能改目录）', () => {
  assert.ok(clientSrc.includes("'数据目录'"), '设置卡里要写清楚数据存在哪');
  assert.ok(clientSrc.includes("'打开'"), '要能一键打开目录');
  assert.ok(clientSrc.includes("api('/data/reveal'"), '按钮走后端接口');
  assert.ok(clientSrc.includes("kind: 'data'"), '打开的是数据目录本身');
  assert.ok(clientSrc.includes('dataDirInfo'), '路径来自 /state 下发的值');
});

await test('A4 打开目录不是「打开任意位置」的原语', () => {
  const seg = slice(routesSrc, "if (method === 'POST' && p === '/data/reveal')", "// v0.20.17：数据目录");
  assert.ok(seg.includes('只支持打开采集数据目录或数据目录'), '非法 kind 要明确拒绝');
  assert.ok(!seg.includes('explorer.exe'), '不要在业务层直接拼平台命令');
});

console.log('2. 版本与文档');

await test('C1 版本号已到 0.20.16', () => {
  const parts = String(pkg.version).split('.').map((x) => Number(x));
  assert.ok(parts[0] > 0 || (parts[0] === 0 && (parts[1] > 20 || (parts[1] === 20 && parts[2] >= 16))), '版本应 ≥ 0.20.16：' + pkg.version);
});

await test('C2 CHANGELOG 与 README 同步', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.20.16'), 'CHANGELOG 要有 v0.20.16');
  assert.ok(/采集数据/.test(changelog), 'CHANGELOG 要说明采集数据目录');
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.version), 'README 版本行没跟上 ' + pkg.version);
});

console.log('\n✓ 全部通过（' + pts + ' 项）');
