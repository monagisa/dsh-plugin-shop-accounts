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

const rpa = read('lib/rpa.mjs').replace(/\r\n/g, '\n');
const support = read('lib/collect-support.mjs');
const dsls = read('lib/dsls.mjs');
const changelog = read('CHANGELOG.md');
const pkg = JSON.parse(read('package.json'));

// A 组：type 语义对齐 上游 —— 逐字符真实键盘输入
ok(rpa.includes('export function exprFocusClear(target, frame, clear)'), 'A1 新增「聚焦 + 清空」表达式');
ok(rpa.includes('export function exprFieldValue(target, frame)'), 'A2 新增「读回输入框值」表达式');
ok(rpa.includes("op: 'typereal',"), 'A3 type 编译成 typereal（不再只是设 value）');
ok(rpa.includes('delayMs: Math.max(0, Math.min(120, Number(step.delay) || 30)),'), 'A4 逐字符间隔对齐 30ms（上限 120ms）');
ok(/if \(action === 'fill'\) \{\n      out\.push\(\{ op: 'eval', expr: exprType/.test(rpa), 'A5 fill 仍走原生 setter（保留旧语义）');
ok(!/if \(action === 'type' \|\| action === 'fill'\) \{\n    const text = .*\n    out\.push\(\{ op: 'eval'/.test(rpa), 'A6 type 不再直接走 exprType');

// B 组：两个执行器都实现 typereal
ok(rpa.includes('async typeChar(ch) {'), 'B1 本地驱动新增 typeChar');
ok(rpa.includes("type: 'keyDown', key: text, text") && rpa.includes("type: 'keyUp', key: text"), 'B2 本地驱动派发真实 keyDown + keyUp');
ok(rpa.includes('} else if (o.op === \'typereal\') {'), 'B3 本地执行器有 typereal 分支');
ok(rpa.includes("type: 'keyDown', key: ch, text: ch") && rpa.includes("type: 'keyUp', key: ch"), 'B4 ego 执行器逐字符派发真实 keyDown + keyUp');
ok(rpa.includes("type: 'mousePressed', x: Number(box.x), y: Number(box.y)"), 'B5 输入前用真实鼠标聚焦');

// C 组：download 原子动作
ok(rpa.includes('timeoutMs: Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : 90000,'), 'C1 下载默认 90 秒硬超时');
ok((rpa.match(/_download-failure\.json/g) || []).length >= 2, 'C2 本地与 ego 两个执行器都写失败现场快照');
ok(rpa.includes('downloadTimeout: true'), 'C3 下载超时带上可重试标记');
ok(rpa.includes("if (o.outputKey) outputs[o.outputKey] = saved;"), 'C4 成功下载按 outputKey 回传文件路径');

// D 组：下载类配方门禁
ok(dsls.includes('declaresDownload: ((raw.collection && raw.collection.artifacts) || [])'), 'D1 配方元信息识别「声明了下载型产物」');
ok(support.includes('if (meta.declaresDownload === true && meta.hasDownload !== true)'), 'D2 缺下载步骤的配方直接跳过');
ok(support.includes("skipped.noDownload.push(meta.id)") && support.includes('noDownload: []'), 'D3 跳过原因可追溯');

// E 组：重试分层
ok(support.includes('const maxAttempts = isCoreDaily ? 3 : ((isDownloadTask || isAdsTask) ? 2 : 1);'), 'E1 默认 1 次 / 核心日报 3 次 / 推广与下载类 2 次');
ok(support.includes('const isCoreDaily = /store_core_daily|core_daily_tpl/.test(dslIdLower);'), 'E2 核心日报识别');
ok(support.includes('const isAdsTask = /ads_marketing|ads_scene|tb_ads_|alimama/.test(dslIdLower);'), 'E3 推广类识别');
ok(support.includes("'STEP_TIMEOUT', 'TARGET_NOT_AVAILABLE', 'EGO_RPA_FAILED', 'EGO_NOT_RUNNING',"), 'E4 只重试页面/ego 抖动');
const retrySet = (/retryable = new Set\(\[([\s\S]*?)\]\)/.exec(support) || [])[1] || '';
ok(retrySet.length > 0 && !retrySet.includes('LOGIN_REQUIRED'), 'E5 登录失效不重试（要走去代填那条路）');
ok(support.includes('if (res && attempts.length > 1) res = { ...res, attempts };'), 'E6 重试记录写回结果');

// F 组：语义行为（真编译一遍）
const { parseDsl, compileExecution } = await import(url.pathToFileURL(path.join(ROOT, 'lib/rpa.mjs')).href);
const spec = { id: 't1', platform: 'taobao', template: { steps: [
  { id: 's-type', action: 'type', target: '#a', value: '2026-11-23' },
  { id: 's-fill', action: 'fill', target: '#b', value: 'x' },
] } };
const compiled = compileExecution(parseDsl(JSON.stringify(spec)), { params: {} });
ok(compiled.ops[0] && compiled.ops[0].op === 'typereal', 'F1 type → typereal');
ok(compiled.ops[0] && compiled.ops[0].delayMs === 30, 'F2 默认间隔 30ms');
ok(compiled.ops[0] && compiled.ops[0].text === '2026-11-23', 'F3 值原样带进 op');
ok(compiled.ops[1] && compiled.ops[1].op === 'eval', 'F4 fill → 仍是原生 setter 的 eval');

// H 组：pickdate（输入 + 点日历格）——生意参谋日期组件只认这一种提交方式
ok(rpa.includes("action === 'pickdate'"), 'H1 引擎新增 pickdate 动作');
const dslDir = path.join(ROOT, 'lib/rpa/dsls');
const refundFiles = [
  'taobao/lingyang_refund_overall.json',
  'taobao/tb_product_refund_overall.json',
  'taobao/tb_product_refund_by_sku.json',
  'taobao/tb_product_refund_completed.json',
  'taobao/tb_product_refund_reason.json',
  'tmall/tmall_product_refund_overall.json',
  'tmall/tmall_product_refund_by_sku.json',
  'tmall/tmall_product_refund_completed.json',
  'tmall/tmall_product_refund_reason.json',
];
const recipeBodies = refundFiles.map((rel) => fs.readFileSync(path.join(dslDir, rel), 'utf8'));
ok(recipeBodies.every((b) => b.includes('"pickdate"')), 'H2 退款配方统一改用 pickdate');
ok(recipeBodies.every((b) => !b.includes('"open-start-date"')), 'H3 旧日历点击步骤已移除');
const pdSpec = { id: 't2', platform: 'taobao', template: { steps: [
  { id: 'd1', action: 'pickdate', value: '{startDate}', input: [{ by: 'xpath', value: "//div[contains(@class,'dt-oui-picker-range')]//input[@placeholder='开始日期']", nth: 0 }], target: [{ by: 'xpath', value: "//*[contains(@class,'picker-cell') and @title='{startDate}' and not(contains(@class,'disabled'))]", nth: 0 }] },
] } };
const pdCompiled = compileExecution(parseDsl(JSON.stringify(pdSpec)), { params: { startDate: '2026-11-22', endDate: '2026-11-22' } });
ok(pdCompiled.ops.length === 4, 'H4 pickdate 编译成 4 个动作');
ok(pdCompiled.ops[0] && pdCompiled.ops[0].op === 'typereal', 'H5 先逐字符键入');
ok(pdCompiled.ops[0] && pdCompiled.ops[0].text === '2026-11-22', 'H6 占位符已替换');
ok(pdCompiled.ops[1] && pdCompiled.ops[1].op === 'sleep', 'H7 等面板弹出');
ok(pdCompiled.ops[2] && pdCompiled.ops[2].op === 'click', 'H8 再点日历格提交');
ok(pdCompiled.ops[3] && pdCompiled.ops[3].op === 'sleep', 'H9 等组件接收');
ok(JSON.stringify(pdCompiled.ops[2]).includes('picker-cell') && JSON.stringify(pdCompiled.ops[2]).includes('disabled'), 'H10 格位排除 disabled（当天不可选）');

// G 组：版本与文档
ok(/^\s*"version": "0\.20\./, 'G1 版本号在 0.20 系列');
ok(JSON.stringify(pkg.version).length > 0 && String(pkg.version) >= '0.20.59', 'G2 版本 ≥ 0.20.59');
ok(changelog.includes('0.20.59'), 'G3 CHANGELOG 有 0.20.59 段');

console.log(`\nfeatures-v02059: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
