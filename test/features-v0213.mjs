import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('ok  ' + name); } else { fail += 1; console.log('FAIL ' + name); }
}

const rpa = read('lib/rpa.mjs');
const support = read('lib/collect-support.mjs');
const pkg = JSON.parse(read('package.json'));

// A 组：下载事件必须由插件自己掐表（ego 的 waitForEvent 不认 timeout 参数）
ok('A1 下载等待不再把 timeout 交给 ego', !/waitForEvent\('download',\s*\{/.test(rpa));
ok('A2 下载等待有插件侧超时变量', /const dlWaitMs = Math\.max\(5000/.test(rpa));
ok('A3 下载等待与计时器赛跑', /Promise\.race\(\[dlPromise, sleep\(dlWaitMs \+ 1500\)/.test(rpa));
ok('A4 拿不到事件时按兜底路径继续', /const download = dlPromise \? await Promise\.race/.test(rpa));

// B 组：批次层硬看门狗，防止某个 await 永不返回拖死整批
ok('B1 看门狗时长 = 单任务预算 + 30 秒', /const watchdogMs = perTask \+ 30000;/.test(support));
ok('B2 任务执行与看门狗赛跑', /Promise\.race\(\[\s*[\r\n]+\s*runTask,/.test(support.replace(/\r\n/g, '\n')));
ok('B3 看门狗超时记 TIMEOUT 且带 watchdog 标记', /code: 'TIMEOUT',[\s\S]{0,240}watchdog: true,/.test(support));
ok('B4 看门狗超时文案带配方 id', /任务执行超时（看门狗 [^`]*：\$\{task\.dslId\}/.test(support));
ok('B5 重试分层仍只重试可重试错误码', /const retryable = new Set\(\[[\s\S]{0,320}'TIMEOUT',[\s\S]{0,40}\]\)/.test(support));

// C 组：版本与脚本链
const parts = String(pkg.version || '').split('.').map((n) => Number(n));
ok('C1 版本 ≥ 0.21.3', parts[0] >= 0 && (parts[1] > 21 || (parts[1] === 21 && parts[2] >= 3)));
ok('C2 自检命令链包含本套件', /node test\/features-v0213\.mjs/.test(String((pkg.scripts || {}).test || '')));

console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
