/**
 * slider.mjs —— 淘宝/天猫登录页的「向右滑动验证」（nc 滑块）。
 *
 * 为什么需要：卖家登录页在密码代填提交后，风控会弹滑块：`#nc_1_n1z`（滑块）在
 * `#nc_1_n1t`（轨道）里。不滑过去登录就失败，而每天几十次手滑不现实。
 *
 * 边界（重要）：
 *   · 只做「向右滑到底」这一种。拼图、点选、短信验证码都不碰；
 *   · 滑不过去就如实返回 cleared:false，不假装成功（风控会先让滑块动、再判定失败并复位，
 *     这跟「拖都没拖」必须能分得开）；
 *   · 只滑一次不重试是没有意义的：真机实测同一段轨道要换「步数/间隔/抖动/超出量」重试
 *     几次才过（见下面 SLIDER_VARIANTS 的注释）。
 *
 * 坐标换算（这里最容易错）：滑块在跨域 iframe 里，getBoundingClientRect() 给的是它自己
 * 那个 frame 的视口坐标；CDP 的 Input.dispatchMouseEvent 要的是最外层页面的视口坐标。
 * 风控 punish 页还不是「一层 iframe」：主页面 → havana 登录框（depth 1）→ 验证码框（depth 2）。
 * 所以必须沿 frame 链把每一层 iframe 的位置累加；只加最外层那一层，事件会打偏。
 */

/** 滑块按钮的候选选择器（先精确后宽泛）。 */
const KNOB_SELECTORS = ['#nc_1_n1z', '.nc_iconfont.btn_slide', '[id^="nc_"][id$="_n1z"]', '.btn_slide'];

/** 轨道的候选选择器。 */
const TRACK_SELECTORS = ['#nc_1_n1t', '.nc_scale', '#nc_1_wrapper', '.nc-container'];

/**
 * 三套拖动参数。真机实测（同一 punish 页面依次试）：
 *   1) 40 步 × 25ms、到点停 200ms 再松手 —— 滑块滑到底后被判定失败、复位；
 *   2) 150 步不等待（挤在一起）—— 同样失败；
 *   3) 90 步 × 12ms、纵向抖动 2px、越过轨道 8px、松手前停 250ms —— **滑块消失、验证通过**。
 * 所以从「密、慢一点、略超出」这套开始，失败再依次换更快的与更粗的。
 */
const SLIDER_VARIANTS = [
  { label: 'dense-slow', steps: 90, stepMs: 12, jitter: 2, overshoot: 8, holdMs: 250 },
  { label: 'dense-fast', steps: 150, stepMs: 0, jitter: 1, overshoot: 0, holdMs: 180 },
  { label: 'coarse', steps: 40, stepMs: 25, jitter: 1, overshoot: 6, holdMs: 200 },
];

/**
 * 在「滑块所在的那个 frame」里跑的探查表达式。
 * 返回 `{ ok, found, knob:{x,y,w,h,right,bottom}, track:{...}, knobSel, trackSel, text, href }`。
 */
export function sliderProbeExpression() {
  return `(() => {
  const KNOB = ${JSON.stringify(KNOB_SELECTORS)};
  const TRACK = ${JSON.stringify(TRACK_SELECTORS)};
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 4 && r.height > 4)) return false;
    const st = getComputedStyle(el);
    if (!st) return false;
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    return true;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  const pick = (list) => {
    for (const sel of list) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
      const hit = nodes.find(vis);
      if (hit) return { el: hit, sel };
    }
    return null;
  };
  const knob = pick(KNOB);
  const track = pick(TRACK);
  const text = String((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 200);
  // 没找到时 ok 必须是 false —— 跨 frame 遍历器以 ok:true 作为「找到、可以停」的信号，
  // 这里若恒为 true，就会停在第一个 frame 而错过验证码那一层。
  if (!knob || !track) return { ok: false, found: false, reason: knob ? 'no-track' : 'no-knob', text, href: location.href };
  return { ok: true, found: true, knob: rectOf(knob.el), track: rectOf(track.el), knobSel: knob.sel, trackSel: track.sel, text, href: location.href };
})()`;
}

/**
 * 在某一层 frame 里跑的表达式：列出这一层所有 iframe 的位置与 src。
 * 返回 `{ ok, found, scrollX, scrollY, frames: [{ left, top, w, h, src }] }`。
 */
export function iframeRectsExpression() {
  return `(() => {
  const out = { ok: true, found: false, scrollX: Math.round(window.scrollX || 0), scrollY: Math.round(window.scrollY || 0), frames: [], href: location.href };
  let ifs = [];
  try { ifs = Array.from(document.querySelectorAll('iframe')); } catch (e) { ifs = []; }
  for (const el of ifs) {
    try {
      const r = el.getBoundingClientRect();
      // 尺寸门槛要小：风控验证码 iframe 只有 390x34（高 34px），用 40 卡会把整层漏掉（真机实测）
      if (!(r.width > 4 && r.height > 4)) continue;
      const st = getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
      out.frames.push({ left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), src: String(el.getAttribute('src') || '') });
    } catch (e) { /* 跳过异常元素 */ }
  }
  out.found = out.frames.length > 0;
  return out;
})()`;
}

/** 从 `Page.getFrameTree` 拍平结果里取「从根到目标 frame」的链（根在前）。 */
export function frameChainOf(frames, targetId) {
  const list = Array.isArray(frames) ? frames : [];
  const byId = new Map(list.map((f) => [String(f.id || ''), f]));
  const chain = [];
  let cur = byId.get(String(targetId || '')) || null;
  const guard = new Set();
  // 先查重再入队：frame 的父子指针一旦有环，这里必须停下来而不是把同一个 frame 收两遍。
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(String(cur.parentId)) || null : null;
  }
  return chain;
}

/** 把 `Page.getFrameTree` 的嵌套结构拍平成 `[{ id, url, depth, parentId }]`（父在前）。 */
export function flattenFrameTreeWithParents(node, out = [], depth = 0, parentId = '') {
  if (!node || !node.frame) return out;
  const f = node.frame;
  const id = String(f.id || '');
  out.push({ id, url: String(f.url || ''), name: String(f.name || ''), depth, parentId: String(parentId || '') });
  for (const child of (Array.isArray(node.childFrames) ? node.childFrames : [])) {
    flattenFrameTreeWithParents(child, out, depth + 1, id);
  }
  return out;
}

/**
 * 在父 frame 的 iframe 列表里挑「承载 childUrl 的那个」，返回它的位置。
 * 匹配规则：先按 URL 路径命中 src；匹配不到就取面积最大的 iframe。
 */
export function pickChildIframe(frames, childUrl) {
  const list = Array.isArray(frames) ? frames : [];
  if (!list.length) return null;
  let childPath = '';
  try { childPath = new URL(String(childUrl || '')).pathname.toLowerCase(); } catch (e) { childPath = ''; }
  if (childPath) {
    const hit = list.find((f) => {
      const src = String(f.src || '').toLowerCase();
      if (!src) return false;
      try { return new URL(src, 'https://x/').pathname.toLowerCase() === childPath; } catch (e) { return false; }
    });
    if (hit) return hit;
  }
  const sorted = [...list].sort((a, b) => Number(b.w) * Number(b.h) - Number(a.w) * Number(a.h));
  return sorted[0] || null;
}

/** 由「每层 iframe 的偏移」累加成顶层坐标偏移。 */
export function accumulateFrameOffset(steps) {
  let left = 0;
  let top = 0;
  let scrollX = 0;
  let scrollY = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    left += Number(s.left || 0);
    top += Number(s.top || 0);
    scrollX += Number(s.scrollX || 0);
    scrollY += Number(s.scrollY || 0);
  }
  return { left: Math.round(left), top: Math.round(top), scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
}

/**
 * 根据滑块/轨道几何算拖动轨迹（纯函数，便于单测）。
 * 终点 = 轨道右侧再往右 overshoot（真机实测略超出一点更容易过）。
 */
export function sliderDragPlan(probe, offset = {}, variant = {}) {
  if (!probe || !probe.found || !probe.knob || !probe.track) return null;
  const overshoot = Number(variant.overshoot || 0);
  const steps = Math.max(8, Math.min(200, Number(variant.steps) || 90));
  const left = Number(offset.left || 0);
  const top = Number(offset.top || 0);
  const scrollX = Number(offset.scrollX || 0);
  const scrollY = Number(offset.scrollY || 0);
  const knob = probe.knob;
  const track = probe.track;
  const start = {
    x: Math.round(left + knob.x + knob.w / 2 - scrollX),
    y: Math.round(top + knob.y + knob.h / 2 - scrollY),
  };
  // 滑块能走的距离 = 轨道宽度 - 滑块宽度；留 2px 余量，再加 overshoot。
  const distance = Math.max(40, Math.round(track.w - knob.w - 2));
  const total = distance + overshoot;
  return { start, distance, total, overshoot, steps };
}

/**
 * 把轨迹拆成「折线移动」：先快后慢 + 纵向抖动。
 * 抖动幅度与轨迹形状是 nc 判定的一部分：真机实测直线匀速必被复位。
 */
export function sliderDragMoves(plan, variant = {}) {
  const moves = [];
  const n = plan.steps;
  const jitter = Number(variant.jitter || 0);
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    // 前 85% 走完主要距离，最后 15% 慢慢收尾（人手松手前的减速）
    const local = t < 0.85 ? t / 0.85 : 1;
    const eased = 1 - (1 - local) * (1 - local);
    const x = Math.round(plan.start.x + plan.total * eased);
    const dy = i === n ? 0 : Math.round(jitter * Math.sin(i * 1.9));
    moves.push({ x, y: plan.start.y + dy });
  }
  return moves;
}

/** CDP 鼠标事件参数（Chrome 与 ego 两端共用同一份参数形状）。 */
export function sliderEventParams(type, point, extra = {}) {
  if (type === 'mousePressed') return { type, x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 };
  if (type === 'mouseReleased') return { type, x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 };
  return { type: 'mouseMoved', x: point.x, y: point.y, button: extra.button || 'none', buttons: extra.buttons === undefined ? 0 : extra.buttons, clickCount: 0 };
}

/** 三套参数的导出（ego 端与测试共用；顺序即优先级）。 */
export const SLIDER_DRAG_VARIANTS = SLIDER_VARIANTS;

/**
 * ego 运行时里用的「滑滑块」实现（一段字符串，被拼进 ego 的 runner 源码）。
 *
 * 为什么要单独写一份：ego 的 runner 是独立脚本，只能拿 ego SDK（page.cdp 桥），不能
 * import 本插件模块。算法必须和上面的 plan/moves 对齐（test/features-v02035.mjs 会比对）。
 * 返回 `cleared`：滑块消失 = 验证通过；`dragged` 只表示拖过（可能被判定失败后复位）。
 */
export const SLIDER_DRAG_SOURCE = `
const __dshSliderProbeExpr = ${JSON.stringify(sliderProbeExpression())};
const __dshSliderRectsExpr = ${JSON.stringify(iframeRectsExpression())};
const __dshSliderVariants = ${JSON.stringify(SLIDER_VARIANTS)};
async function __dshSolveSlider(page, hints) {
  const probeExpr = __dshSliderProbeExpr;
  const rectsExpr = __dshSliderRectsExpr;
  const result = { ok: true, found: false, dragged: false, cleared: false, attempts: [], variant: null, probe: null, offset: null, depth: null };
  const probeOnce = async () => {
    try {
      const r = await __dshEvalInFrames(page, probeExpr, hints || [], true);
      return { res: r, value: (r && r.value) || null };
    } catch (e) { return { res: null, value: null }; }
  };
  let first = await probeOnce();
  result.probe = first.value;
  result.depth = first.res && first.res.depth;
  if (!first.value || !first.value.found) { result.reason = (first.value && first.value.reason) || 'not-found'; return result; }
  result.found = true;

  // 沿 frame 链把每一层 iframe 的偏移累加起来（punish 页是「主页面 → 登录框 → 验证码框」两层）
  const offsetOf = async (probeRes) => {
    let acc = { left: 0, top: 0, scrollX: 0, scrollY: 0 };
    try {
      const tree = await page.cdp('Page.getFrameTree', {});
      const flat = [];
      (function walk(node, depth, parentId) {
        if (!node || !node.frame) return;
        const id = String(node.frame.id || '');
        flat.push({ id: id, url: String(node.frame.url || ''), depth: depth, parentId: parentId || '' });
        for (const c of (node.childFrames || [])) walk(c, depth + 1, id);
      })(tree && tree.frameTree, 0, '');
      const byId = {};
      for (const f of flat) byId[f.id] = f;
      const chain = [];
      let cur = byId[String((probeRes && probeRes.frameId) || '')] || null;
      const guard = {};
      while (cur && !guard[cur.id]) { guard[cur.id] = true; chain.unshift(cur); cur = cur.parentId ? (byId[cur.parentId] || null) : null; }
      for (let i = 1; i < chain.length; i += 1) {
        const parentId = chain[i - 1].id;
        const childUrl = String(chain[i].url || '');
        const world = await page.cdp('Page.createIsolatedWorld', { frameId: parentId, worldName: 'dsh-shop-accounts-slider', grantUniversalAccess: false });
        const rr = await page.cdp('Runtime.evaluate', { expression: rectsExpr, returnByValue: true, awaitPromise: false, contextId: world.executionContextId });
        const rv = rr && rr.result ? rr.result.value : null;
        if (!rv || !rv.frames || !rv.frames.length) continue;
        let childPath = '';
        try { childPath = new URL(childUrl).pathname.toLowerCase(); } catch (e) { childPath = ''; }
        let hit = null;
        if (childPath) {
          for (const f of rv.frames) {
            let p = '';
            try { p = new URL(String(f.src || ''), 'https://x/').pathname.toLowerCase(); } catch (e) { p = ''; }
            if (p && p === childPath) { hit = f; break; }
          }
        }
        if (!hit) { hit = rv.frames.slice().sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); })[0] || null; }
        if (!hit) continue;
        acc.left += Number(hit.left || 0);
        acc.top += Number(hit.top || 0);
        acc.scrollX += Number(rv.scrollX || 0);
        acc.scrollY += Number(rv.scrollY || 0);
      }
    } catch (e) { /* 拿不到 frame 链就按最外层坐标试 */ }
    return acc;
  };
  const send = async (type, x, y, buttons, button) => {
    const p = { type: type, x: x, y: y, clickCount: type === 'mouseMoved' ? 0 : 1 };
    if (type === 'mouseMoved') { p.button = button || 'none'; p.buttons = buttons || 0; }
    else { p.button = 'left'; p.buttons = type === 'mousePressed' ? 1 : 0; }
    await page.cdp('Input.dispatchMouseEvent', p);
  };

  for (let vi = 0; vi < __dshSliderVariants.length; vi += 1) {
    const variant = __dshSliderVariants[vi];
    const fresh = await probeOnce();
    if (!fresh.value || !fresh.value.found) { result.cleared = true; result.variant = variant.label; return result; }
    result.probe = fresh.value;
    const offset = await offsetOf(fresh.res);
    result.offset = offset;
    const knob = fresh.value.knob;
    const track = fresh.value.track;
    const sx = Math.round(Number(offset.left || 0) + knob.x + knob.w / 2 - Number(offset.scrollX || 0));
    const sy = Math.round(Number(offset.top || 0) + knob.y + knob.h / 2 - Number(offset.scrollY || 0));
    const distance = Math.max(40, Math.round(track.w - knob.w - 2));
    const total = distance + Number(variant.overshoot || 0);
    const n = Math.max(8, Math.min(200, Number(variant.steps) || 90));
    const attempt = { variant: variant.label, start: { x: sx, y: sy }, distance: distance, steps: n };
    try {
      await send('mouseMoved', sx - 3, sy - 2, 0, 'none');
      await page.waitForTimeout(140).catch(() => {});
      await send('mouseMoved', sx, sy, 0, 'none');
      await page.waitForTimeout(90).catch(() => {});
      await send('mousePressed', sx, sy, 1, 'left');
      for (let i = 1; i <= n; i += 1) {
        const t = i / n;
        const local = t < 0.85 ? t / 0.85 : 1;
        const eased = 1 - (1 - local) * (1 - local);
        const x = Math.round(sx + total * eased);
        const dy = i === n ? 0 : Math.round(Number(variant.jitter || 0) * Math.sin(i * 1.9));
        await send('mouseMoved', x, sy + dy, 1, 'left');
        if (Number(variant.stepMs) > 0) await page.waitForTimeout(Number(variant.stepMs)).catch(() => {});
      }
      await send('mouseMoved', sx + total, sy, 1, 'left');
      await page.waitForTimeout(Number(variant.holdMs) || 200).catch(() => {});
      await send('mouseReleased', sx + total, sy, 0, 'left');
      result.dragged = true;
      attempt.steps = n;
    } catch (e) {
      attempt.error = 'drag-failed:' + String((e && e.message) || e);
      result.attempts.push(attempt);
      continue;
    }
    // 松手后轮询：滑块消失 = 通过；还在 = 判定失败、被复位，换下一套参数
    let after = null;
    for (let i = 0; i < 8; i += 1) {
      await page.waitForTimeout(400).catch(() => {});
      const again = await probeOnce();
      after = again.value;
      if (!after || !after.found) break;
    }
    attempt.after = after && after.found ? { found: true, knobX: Math.round(Number(after.knob.x || 0)), text: String(after.text || '').slice(0, 40) } : { found: false };
    result.attempts.push(attempt);
    result.variant = variant.label;
    if (!after || !after.found) { result.cleared = true; return result; }
  }
  result.cleared = false;
  result.reason = 'slider-not-cleared';
  return result;
}
`;
