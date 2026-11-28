// features-v0212：代填可靠性（登录按钮 disabled 时再点一次 / 已登录不再误报未找到输入框）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail += 1;
    console.log('  \u2717 ' + name + ' -> ' + (e && e.message));
  }
}

const egoSrc = read('lib/ego.mjs');
const alSrc = read('lib/autologin.mjs');

ok('代填：提交按钮 disabled 时等 1.5 秒再用「只提交」脚本点一次', () => {
  assert.match(egoSrc, /filled\.submitDisabled && P\.resubmitExpr/);
  assert.match(egoSrc, /filled\.resubmitted = true/);
});

ok('代填：已在登录状态时返回 ALREADY_LOGGED_IN 而不是「没找到输入框」', () => {
  assert.match(alSrc, /AUTOLOGIN_ALREADY_LOGGED_IN/);
  assert.match(alSrc, /earlyJudge\.loggedIn/);
});

ok('抖店切页签后的等待时间不少于 2 秒（邮箱登录表单要渲染）', () => {
  const m = /preWaitMs:\s*(\d+)/.exec(alSrc);
  assert.ok(m, 'preWaitMs');
  assert.ok(Number(m[1]) >= 2000, 'preWaitMs=' + m[1]);
});

ok('版本 ≥ 0.21.2，说明仍是店铺定时采集插件', () => {
  const parts = String(pkg.version).split('.').map(Number);
  assert.ok(parts[0] > 0 || parts[1] > 21 || (parts[1] === 21 && parts[2] >= 2), pkg.version);
  assert.match(String(pkg.description || ''), /店铺|采集/);
});

console.log('\n' + (fail ? 'FAIL ' : 'PASS ') + pass + ' passed, ' + fail + ' failed');
console.log('通过（' + pass + ' 项）');
if (fail) process.exit(1);
