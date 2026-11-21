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

const ego = read('lib/ego.mjs');

// A 组：引擎里要有显式接管动作，并在被交还时自动接管后重放
ok(/if \(op === 'takeover'\) {/.test(ego), 'A1 runner 有 takeover 分支');
ok(/g\.takeOverTaskSpace\(entry\.id\)/.test(ego), 'A2 takeover 调 ego 的 takeOverTaskSpace');
ok(/op: 'takeover', space: spaceName/.test(ego), 'A3 egoRpa 失败时先调 takeover');
ok(/firstCode === 'ego_user_in_control'/.test(ego), 'A4 只对 ego_user_in_control 触发');
ok(/autoTakeover: true/.test(ego), 'A5 重试成功时标记 autoTakeover');
ok(/op === 'close' \|\| op === 'handoff'/.test(ego), 'A6 close/handoff 不参与重试');

// B 组：文档与版本
const pkg = JSON.parse(read('package.json'));
ok(pkg.version === '0.20.55' || pkg.version > '0.20.55', 'B1 版本已到 0.20.55');
const cl = read('CHANGELOG.md');
ok(cl.includes('v0.20.55') && /接管/.test(cl), 'B2 CHANGELOG 写了接管修复');
ok(read('README.md').includes(pkg.version), 'B3 README 版本行与 package.json 一致');

console.log('合计 ' + (pass + fail) + ' 项，' + (fail === 0 ? '全部通过' : fail + ' 项失败') + '（通过 ' + pass + '）');
process.exit(fail === 0 ? 0 : 1);
