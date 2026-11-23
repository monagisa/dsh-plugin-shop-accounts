import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}

const support = read('lib/collect-support.mjs');
const scheduler = read('lib/scheduler-run.mjs');
const tools = read('lib/server/tools.mjs');
const pkg = JSON.parse(read('package.json'));

// A 组：采集前置登录检查 + 自动代填
ok(support.includes('const state = await quickLoginState(account).catch(() => null);'), 'A1 采集前先查登录态');
ok(support.includes('if (hasPassword(account.id))'), 'A2 有保存密码才自动代填');
ok(support.includes('await autoLogin(account, {') && support.includes('password: getPassword(account.id)'), 'A3 用 vault 里的密码自动登录');
ok(support.includes("code: 'RELOGIN_FAILED'") && support.includes('登录态已过期，自动代填也没成功'), 'A4 代填失败立刻报错，不浪费一轮');
ok(support.includes("code: 'NO_PASSWORD'") && support.includes('这个店铺没有保存密码'), 'A5 没密码不硬失败，只记录原因');
ok(support.includes('if (!isBuyerAccount(account) && body.relogin === true)'), 'A6 只有真正开跑（relogin）才做登录前置');

// B 组：登录前置接进调度与工具入口
ok(/prepareJobForAccount\(account, \{ drive: true, skipCovered: true, includeDownload: true, relogin: true/.test(scheduler), 'B1 定时采集带 relogin');
ok(/relogin: args\.drive === true,/.test(tools), 'B2 collect-job 真跑时带 relogin');

// C 组：单任务硬超时
ok(support.includes('export async function executeOps(account, ops, downloadDir, compiledInfo = {}, opts = {})'), 'C1 executeOps 接受每任务预算');
ok(support.includes('const timeoutMs = Math.max(30000, Number(opts.timeoutMs) || 150000);'), 'C2 默认 150 秒、最小 30 秒');
ok(support.includes('}, { timeoutMs: perTask });') && support.includes('const isDownloadTask = declaredForBudget.some') && support.includes('(isDownloadTask ? 300000 : 150000)'), 'C3 批量链路逐任务独立预算（下载型 300 秒，其余 150 秒）');
ok(support.includes('const declaredForBudget = Array.isArray(task.declaredArtifacts)') && support.includes("(((one.raw || {}).collection || {}).artifacts || [])"), 'C3b 产物声明两边都看（作业里为空时回落到配方原文）');
ok(!support.includes('{ timeoutMs: 300000, downloadDir }'), 'C4 旧的固定 300 秒已清除');
ok(support.includes("String((x || {}).kind || '') === 'download_ref'"), 'E1 下载型配方单独给 300 秒预算');
const egoSrc = read('lib/ego.mjs');
ok(!egoSrc.includes('Math.min(120000, Number(opts.timeoutMs)') && egoSrc.includes('Math.min(300000, Number(opts.timeoutMs)'), 'E2 换窗口重跑的上限不再固定 120 秒');

// D 组：文档与版本
ok(support.includes('body.__collectionHint.loginBootstrap = loginBootstrap;'), 'D1 登录前置结果写进作业报告');
const parts = pkg.version.split('.').map(Number);
ok(parts[1] === 20 && parts[2] >= 56, 'D2 版本已到 0.20.56');
ok(read('CHANGELOG.md').includes('v0.20.56'), 'D3 CHANGELOG 写了这一节');
ok(read('README.md').includes(pkg.version), 'D4 README 版本行一致');

console.log('合计 ' + (pass + fail) + ' 项，' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '（通过 ' + pass + '）');
process.exit(fail === 0 ? 0 : 1);
