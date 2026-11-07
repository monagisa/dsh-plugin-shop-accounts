/**
 * v0.18.0 自检：ego 新版「控制权在用户手里就硬停」的适配。
 *
 * 现场（2026-11-05，用户报错）：点「打开」时 ego 直接打一段说明并退出（脚本都没跑），
 *   原文：Control of this task space is with the user, either through task.handOff() or a takeover in the
 *   browser, so browser commands are paused. This is a hard stop, not an obstacle to route around — do not
 *   retry and do not take control back on your own. Wait until the user explicitly asks you to continue, then
 *   take control back and resume: const task = await takeOverTaskSpace(spaceId)
 * 插件原来的 acquire() 会对这类空间调 takeOverTaskSpace → 撞硬停 → 用户看到「ego 没有返回结果（退出码 0）」。
 *
 * 现在：ownership=user 的空间一律不碰（不 takeOver、不 claim），改用备用名字在同 profile 新开一个窗口；
 * 真撞上硬停时翻成中文并给下一步；界面把 note 弹出来。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const E = await import(pathToFileURL(path.join(ROOT, 'lib/ego.mjs')).href);
const egoSrc = read('lib/ego.mjs');
const indexSrc = readServerSource(ROOT);
const clientSrc = read('lib/client.js');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  }
}

const REAL_HARD_STOP = [
  'Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.',
  'This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.',
  'Wait until the user explicitly asks you to continue, then take control back and resume:',
  '  const task = await takeOverTaskSpace(spaceId)',
].join('\n');

// ── A. 硬停文案识别（Node 侧）───────────────────────────────────────────────

test('A1 能识别现场真实硬停文案', () => {
  assert.equal(E.isUserInControlOutput(REAL_HARD_STOP), true);
});

test('A2 能识别「任务已结束/空间归你」与错误码形态', () => {
  assert.equal(E.isUserInControlOutput('This task has ended and the space is yours.'), true);
  assert.equal(E.isUserInControlOutput('EGO_TASK_SPACE_USER_IN_CONTROL manual_takeover'), true);
});

test('A3 普通失败不会被误判成硬停', () => {
  assert.equal(E.isUserInControlOutput(''), false);
  assert.equal(E.isUserInControlOutput('Cannot read properties of undefined (reading render)'), false);
  assert.equal(E.isUserInControlOutput('等不到元素：transaction:等待成交分析日期栏就绪'), false);
});

// ── B. 执行器：user-owned 空间不抢控制权，改用备用名字 ────────────────────────

test('B1 acquire 只认 agent / agentDelegatedToUser，且完全不调 claimTaskSpace', () => {
  assert.ok(
    egoSrc.includes("ownership === 'agent' || ownership === 'agentDelegatedToUser'"),
    'acquire 没有把可接管范围限定在 agent / agentDelegatedToUser'
  );
  assert.ok(!egoSrc.includes('claimTaskSpace('), '不该调 claimTaskSpace（对 user 空间会被硬停）');
});

test('B2 user-owned 空间走「备用名字 + 同 profile 新开」', () => {
  assert.ok(egoSrc.includes("const alt = spaceName + ' (' + i + ')';"), '缺少备用名字逻辑');
  assert.ok(egoSrc.includes('alternativeName'), '没有把备用名字透出去');
  assert.ok(egoSrc.includes("const t = profileId ? await g.taskSpace(alt, { profileId }) : await g.taskSpace(alt);"), '备用窗口没带 profileId');
});

test('B3 关闭 / 交还控制权时不去动 user-owned 的空间', () => {
  assert.ok(egoSrc.includes("String(entry.ownership || '') === 'user' && (op === 'close' || op === 'handoff')"), '缺少 close/handoff 的 user 空间守卫');
  assert.ok(egoSrc.includes('插件不去动它'), '缺少说明文案');
  assert.ok(!egoSrc.includes("await g.claimTaskSpace"), '仍然会去认领用户的空间');
});

test('B4 每个动作都把 handOff 放在最后一个浏览器动作之后', () => {
  const hits = (egoSrc.match(/await handOff\(\);\n(?:    )?(?:emit|return|if)/g) || []).length;
  assert.ok(hits >= 4, 'handOff 的收尾位置不对：命中 ' + hits + ' 处');
});

// ── C. 失败翻译 + 界面提示 ──────────────────────────────────────────────────

test('C1 硬停被翻成中文并带可执行下一步', () => {
  assert.ok(egoSrc.includes("code: 'ego_user_in_control'"), '没有给硬停一个错误码');
  assert.ok(egoSrc.includes('这个店铺的窗口现在归你控制'), '缺少中文说明');
  assert.ok(egoSrc.includes('先在 ego 里点「继续」'), '缺少下一步指引');
  assert.ok(egoSrc.includes('isUserInControlOutput(errOut)'), 'runOnce 没识别 stderr 里的硬停');
});

test('C2 打开失败时不再套「ego 打开失败：<英文原文>」', () => {
  assert.ok(indexSrc.includes("if (r.code === 'ego_user_in_control') throw new Error(r.error"), '没有单独处理硬停');
});

test('C3 新开备用窗口时把说明透给界面，并被 toast 弹出来', () => {
  assert.ok(indexSrc.includes('已新开窗口「'), '接口没把备用窗口说明带上');
  assert.ok(clientSrc.includes("if (r && r.note) toast('ok', r.note);"), '界面没把 note 弹出来');
});

// ── D. 版本与文档 ───────────────────────────────────────────────────────────

test('D1 版本号已到 0.18.0', () => {
  const [maj, min] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && min >= 18, 'package.json 版本还是 ' + pkg.version);
});

test('D2 CHANGELOG / README 写了这次适配', () => {
  const changelog = read('CHANGELOG.md');
  const readme = read('CHANGELOG.md');
  assert.match(changelog, /v0\.18\.0/, 'CHANGELOG 没有 v0.18.0');
  assert.match(changelog, /控制权/, 'CHANGELOG 没写控制权');
  assert.match(readme, /0\.18\.0/, 'README 没更新版本');
});

console.log('\n' + passed + ' 项通过' + (failures.length ? '，' + failures.length + ' 项失败' : ''));
if (failures.length) process.exit(1);
