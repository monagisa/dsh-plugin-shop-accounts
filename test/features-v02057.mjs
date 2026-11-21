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

const rpa = read('lib/rpa.mjs');
const egoSrc = read('lib/ego.mjs');
const dsl = read('lib/rpa/dsls/taobao/tb_traffic_source_excel.json');
const pkg = JSON.parse(read('package.json'));

// A 组：引擎能力 —— 页内取字节
ok(rpa.includes("'assertElement', 'when', 'evaluate', 'fetchFile'"), 'A1 引擎认识 fetchFile 动作');
ok(rpa.includes('export function fetchFileExpression(url, timeoutMs = 30000)'), 'A2 有页内取字节表达式');
ok(rpa.includes("xhr.overrideMimeType('text/plain; charset=x-user-defined')"), 'A3 用 x-user-defined 保字节');
ok(rpa.includes("xhr.withCredentials = true"), 'A4 带着登录 cookie 请求');
ok(!rpa.includes('xhr.timeout = '), 'A5 不用同步请求上不支持的 timeout 属性');
ok(rpa.includes("if (action === 'fetchfile')") && rpa.includes("op: 'fetchfile'"), 'A6 compileExecution 会编译成 fetchfile 动作');
ok(rpa.includes('export function writeFetchFile(dir, got, hint = {})'), 'A7 有落盘辅助');
ok(rpa.includes("out.push({ op: 'fetchfile', url: String(step.url)") || rpa.includes("op: 'fetchfile', url: String(step.url)"), 'A8 动作带 url 与 outputKey');

// B 组：两条执行链路都支持
ok(rpa.includes("} else if (o.op === 'fetchfile') {"), 'B1 本地执行器（CDP）支持 fetchfile');
ok((rpa.match(/o\.op === 'fetchfile'/g) || []).length >= 2, 'B2 ego 运行时也支持 fetchfile（两处分支）');
ok(egoSrc.includes('writeFetchFile(dir, val, { base: key, ext'), 'B3 ego 侧把十六进制落盘成文件');
ok(egoSrc.includes("if (!dir) { hydrateError = 'fetchFile 需要下载目录"), 'B4 没给下载目录时明确报错');
ok(egoSrc.includes('savedSteps.push({ id: key, op: \'fetchFile\''), 'B5 落盘结果记进步骤明细');

// C 组：配方与文档
ok(dsl.includes('"action": "fetchFile"') && !dsl.includes('"action": "downloadFile"'), 'C1 流量来源配方改走 fetchFile，不再点下载按钮');
ok(dsl.includes('/flow/gray/excel.do') && dsl.includes('{dateRange}'), 'C2 仍用官方导出接口 + 日期占位符');
ok(dsl.includes('"output_key": "trafficSourceExcel"'), 'C3 产物键与配方声明一致');
const parts = pkg.version.split('.').map(Number);
ok(parts[1] === 20 && parts[2] >= 57, 'C4 版本已到 0.20.57');
ok(read('CHANGELOG.md').includes('v0.20.57'), 'C5 CHANGELOG 写了这一节');
ok(read('README.md').includes(pkg.version), 'C6 README 版本行一致');

console.log('合计 ' + (pass + fail) + ' 项，' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '（通过 ' + pass + '）');
process.exit(fail === 0 ? 0 : 1);
