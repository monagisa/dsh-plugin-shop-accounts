import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  SLIDER_DRAG_SOURCE, SLIDER_DRAG_VARIANTS, accumulateFrameOffset, frameChainOf,
  pickChildIframe, sliderDragMoves, sliderDragPlan, sliderEventParams, sliderProbeExpression,
} from '../lib/slider.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const passed = [];
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u2717 ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const TAOBAO_FLOW = {
  frameHints: ['havanalogin.taobao.com', 'mini_login.htm', 'login.taobao.com'],
};

await test('A1 探查表达式覆盖淘宝滑块与轨道选择器，且找不到时 ok 为 false', () => {
  const expr = sliderProbeExpression();
  assert.match(expr, /#nc_1_n1z/, '要有滑块选择器');
  assert.match(expr, /#nc_1_n1t/, '要有轨道选择器');
  assert.match(expr, /found: false/, '找不到时必须 ok/found 都 false');
  assert.match(expr, /return { ok: true, found: true/, '找到时返回 ok:true');
  assert.match(expr, /visibility === 'hidden'/, '要排除不可见元素');
});

await test('A2 iframe 列表表达式收录小尺寸 iframe（验证码框只有 390x34）', () => {
  const expr = sliderProbeExpression();
  assert.match(expr, /r\.width > 4 && r\.height > 4/, '尺寸门槛要小于 40');
});

await test('B1 frame 链：从根到目标 frame 按顺序返回，环不会死循环', () => {
  const frames = [
    { id: 'root', parentId: '' },
    { id: 'mid', parentId: 'root' },
    { id: 'leaf', parentId: 'mid' },
  ];
  const chain = frameChainOf(frames, 'leaf');
  assert.deepEqual(chain.map((f) => f.id), ['root', 'mid', 'leaf']);
  const cyc = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
  const c2 = frameChainOf(cyc, 'a');
  assert.ok(c2.length <= 2, '有环时不能无限循环');
});

await test('B2 挑子 iframe：先按 URL 路径命中，匹配不到取面积最大', () => {
  const frames = [
    { left: 1135, top: 243, w: 456, h: 603, src: 'https://havanalogin.taobao.com/mini_login.htm?x=1' },
    { left: 0, top: 0, w: 0, h: 0, src: 'https://assets.diantoushi.com/page/io.html' },
  ];
  const hit = pickChildIframe(frames, 'https://havanalogin.taobao.com/mini_login.htm?lang=zh_CN');
  assert.equal(hit.left, 1135, '按 pathname 命中外层登录框');
  const small = [
    { left: 33, top: 259, w: 390, h: 34, src: 'https://havanalogin.taobao.com/newlogin/_____tmd_____/punish' },
    { left: 0, top: 0, w: 300, h: 40, src: 'https://example.invalid/other.html' },
  ];
  const hit2 = pickChildIframe(small, 'https://havanalogin.taobao.com/newlogin/login.do/_____tmd_____/punish?x5step=2');
  assert.equal(hit2.w, 390, '按 pathname 命中验证码框（尺寸小也要能命中）');
});

await test('C1 偏移累加：两层 (1135,243)+(33,259) = (1168,502)', () => {
  const acc = accumulateFrameOffset([{ left: 1135, top: 243 }, { left: 33, top: 259 }]);
  assert.deepEqual(acc, { left: 1168, top: 502, scrollX: 0, scrollY: 0 });
});

await test('C2 拖动轨迹：起点是滑块中心，终点滑到底（可略超出），步数与参数一致', () => {
  const probe = { found: true, knob: { x: 0, y: 0, w: 42, h: 34 }, track: { x: 0, y: 0, w: 390, h: 34 } };
  const offset = { left: 1168, top: 502, scrollX: 0, scrollY: 0 };
  const variant = SLIDER_DRAG_VARIANTS[0];
  const plan = sliderDragPlan(probe, offset, variant);
  assert.equal(plan.start.x, 1189);
  assert.equal(plan.start.y, 519);
  assert.equal(plan.distance, 346);
  assert.equal(plan.total, 346 + variant.overshoot);
  assert.equal(plan.steps, variant.steps);
  const moves = sliderDragMoves(plan, variant);
  assert.equal(moves.length, variant.steps);
  assert.ok(moves[moves.length - 1].x >= 1189 + 346, '最后一步要滑到（或略过）轨道右端');
  assert.ok(moves[0].x < moves[moves.length - 1].x, '单调向右');
  const fast = sliderDragPlan(probe, offset, SLIDER_DRAG_VARIANTS[1]);
  assert.ok(fast.steps > plan.steps, '第二套参数步数更多（更密）');
});

await test('C3 鼠标事件参数：按下带左键、移动带 buttons、抬起 buttons=0', () => {
  const p = { x: 1189, y: 519 };
  const down = sliderEventParams('mousePressed', p);
  assert.equal(down.button, 'left');
  assert.equal(down.buttons, 1);
  const move = sliderEventParams('mouseMoved', { x: 1200, y: 519 }, { button: 'left', buttons: 1 });
  assert.equal(move.buttons, 1);
  const up = sliderEventParams('mouseReleased', p);
  assert.equal(up.buttons, 0);
});

await test('D1 ego 端实现与 Node 端几何/参数对齐，并带「滑不动就换参数」', () => {
  assert.match(SLIDER_DRAG_SOURCE, /async function __dshSolveSlider\(page, hints\)/, '要有 ego 运行时函数');
  assert.match(SLIDER_DRAG_SOURCE, /Page\.getFrameTree/, '要沿 frame 链取偏移');
  assert.match(SLIDER_DRAG_SOURCE, /Input\.dispatchMouseEvent/, '要发鼠标事件');
  assert.match(SLIDER_DRAG_SOURCE, /__dshSliderVariants/, '要复用同一套参数');
  assert.match(SLIDER_DRAG_SOURCE, /result\.cleared = true/, '要报「滑块消失 = 通过」');
  assert.match(SLIDER_DRAG_SOURCE, /var|let|const .*distance|track\.w - knob\.w - 2/, '距离算法与 Node 端一致');
  assert.ok(SLIDER_DRAG_VARIANTS.length >= 2, '至少两套参数');
  assert.equal(SLIDER_DRAG_VARIANTS[0].label, 'dense-slow', '第一套是实测通过的那套');
});

await test('E1 代填链路接线：ego 侧注入 solver、Chrome 侧滑完再提交', () => {
  const egoSrc = read('lib/ego.mjs');
  assert.match(egoSrc, /SLIDER_DRAG_SOURCE/, 'ego.mjs 要 import 并注入 slider 源码');
  assert.match(egoSrc, /__dshSolveSlider\(page, P\.frameHints/, 'autofill 里要调用 solver');
  assert.match(egoSrc, /P\.resubmitExpr/, '滑完要重新提交');
  const autoSrc = read('lib/autologin.mjs');
  assert.match(autoSrc, /solveSliderViaChrome/, 'Chrome 侧要有滑滑块');
  assert.match(autoSrc, /SLIDER_DRAG_VARIANTS/, 'Chrome 侧复用同一套参数');
  assert.match(autoSrc, /buildSubmitExpression\(flow\)/, '滑完再点一次登录');
  const flow = read('lib/autologin.mjs');
  assert.ok(flow.includes(TAOBAO_FLOW.frameHints[0]), '淘宝登录流程 frameHints 仍指向 havana 登录框');
});

await test('F1 版本号已到 0.20.35', () => {
  const nums = (v) => String(v).split('.').map(Number);
  const [a, b, c] = nums(pkg.version);
  const [x, y, z] = nums('0.20.35');
  const ok = a > x || (a === x && (b > y || (b === y && c >= z)));
  assert.ok(ok, '版本要 ≥ 0.20.35，当前 ' + pkg.version);
});

await test('F2 CHANGELOG 与 README 写了滑块这件事', () => {
  const cl = read('CHANGELOG.md');
  assert.ok(cl.includes('v0.20.35'), 'CHANGELOG 要有 v0.20.35 段');
  assert.ok(cl.includes('滑块'), 'CHANGELOG 要写滑块');
  const readme = read('README.md');
  assert.ok(readme.includes(pkg.version), 'README 当前版本要与 package.json 一致');
});

console.log('');
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message ? f.err.message : f.err));
  process.exit(1);
}
console.log(`\u2713 全部通过（${passed.length} 项）`);
