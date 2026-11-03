/**
 * frames.mjs —— 找「登录表单到底在哪个 frame 里」，以及跨 frame 跑脚本。
 *
 * 为什么需要这一层：淘宝（含天猫、1688 卖家侧）的登录页是一个**壳页面**，
 * 真正的输入框在跨域 iframe 里：
 *
 *   主页面  https://loginmyseller.taobao.com/?from=…          ← 只有一张欢迎图
 *   └─ iframe#alibaba-login-box
 *        src https://havanalogin.taobao.com/mini_login.htm?appEntrance=qianniu_pc_web…
 *        └─ 这里才是 #fm-login-id / #fm-login-password
 *
 * 只往主 frame 里 `document.querySelectorAll` 一定会一无所获 —— 表现就是
 * 「点了自动登录，密码没填进去」。所以填充脚本必须放进 iframe 的上下文里执行
 * （CDP: `Page.createIsolatedWorld` 拿 executionContextId，再 `Runtime.evaluate` 带 contextId）。
 *
 * 这里只放**纯函数**（拍平 frame 树、按优先级排候选 frame）和 ego 运行时里用的
 * 同款脚本字符串；Chrome 侧的编排在 cdp.mjs 的 `evaluateInFrames`。
 */

/** 把 `Page.getFrameTree` 的嵌套结构拍平成 `[{ id, url, name, depth }]`（父在前）。 */
export function flattenFrameTree(node, out = [], depth = 0) {
  if (!node || !node.frame) return out;
  const f = node.frame;
  out.push({ id: String(f.id || ''), url: String(f.url || ''), name: String(f.name || ''), depth });
  for (const child of (Array.isArray(node.childFrames) ? node.childFrames : [])) {
    flattenFrameTree(child, out, depth + 1);
  }
  return out;
}

/**
 * 候选 frame 的优先顺序：
 *   1. URL 命中提示串的**子 frame**（深的优先）—— 淘宝/天猫的登录表单就在这一层；
 *   2. 主 frame（老结构，拼多多/京东/抖店表单就在主页面上）；
 *   3. 其余 http(s) 子 frame（最多 3 个，兜底：没给提示或提示不准时也能摸到）。
 *
 * 把主 frame 排在命中提示的子 frame 之后，是因为壳页面的 URL 往往也命中提示串
 * （比如主页面就是 loginmyseller.taobao.com），但它里面根本没有输入框。
 */
export function frameOrder(frames, hints = []) {
  const list = Array.isArray(frames) ? frames.filter((f) => f && f.id) : [];
  const H = (Array.isArray(hints) ? hints : []).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
  const urlOf = (f) => String(f.url || '').toLowerCase();
  const matched = (f) => H.length > 0 && H.some((h) => urlOf(f).includes(h));
  const isChild = (f) => Number(f.depth || 0) > 0;
  const byDepthDesc = (a, b) => Number(b.depth || 0) - Number(a.depth || 0);
  const hits = list.filter((f) => isChild(f) && matched(f)).sort(byDepthDesc);
  const main = list.filter((f) => !isChild(f));
  const rest = list.filter((f) => isChild(f) && !matched(f) && /^https?:/i.test(String(f.url || ''))).sort(byDepthDesc).slice(0, 3);
  const seen = new Set();
  const out = [];
  for (const f of [...hits, ...main, ...rest]) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * ego 运行时里用的同款逻辑（一段字符串，被拼进 ego 的 runner 源码）。
 *
 * 为什么在 ego 侧也重写一遍而不是 import：ego 的 runner 是一段独立脚本，
 * 只能拿到 ego SDK（`page.cdp()` 桥），不能 import 本插件的模块。
 * 规则必须和上面的 `frameOrder` 逐条对齐 —— `test/features-v0165.mjs` 会比对两边行为。
 */
export const FRAME_EVAL_SOURCE = `
async function __dshEvalInFrames(page, expression, hints, wantFilled) {
  const flatten = (node, out, depth) => {
    if (!node || !node.frame) return out;
    out.push({ id: String(node.frame.id || ''), url: String(node.frame.url || ''), depth: depth });
    for (const c of (node.childFrames || [])) flatten(c, out, depth + 1);
    return out;
  };
  const order = (frames, H) => {
    const hs = (H || []).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
    const urlOf = (f) => String(f.url || '').toLowerCase();
    const matched = (f) => hs.length > 0 && hs.some((h) => urlOf(f).includes(h));
    const isChild = (f) => f.depth > 0;
    const desc = (a, b) => b.depth - a.depth;
    const hits = frames.filter((f) => isChild(f) && matched(f)).sort(desc);
    const main = frames.filter((f) => !isChild(f));
    const rest = frames.filter((f) => isChild(f) && !matched(f) && /^https?:/i.test(f.url)).sort(desc).slice(0, 3);
    const out = [];
    const seen = {};
    for (const f of hits.concat(main, rest)) { if (seen[f.id]) continue; seen[f.id] = true; out.push(f); }
    return out;
  };
  const tree = await page.cdp('Page.getFrameTree', {});
  const frames = flatten(tree && tree.frameTree, [], 0);
  const tried = [];
  let last = null;
  for (const f of order(frames, hints)) {
    let value;
    try {
      const world = await page.cdp('Page.createIsolatedWorld', { frameId: f.id, worldName: 'dsh-shop-accounts-autofill', grantUniversalAccess: false });
      const ctxId = world && world.executionContextId;
      const r = await page.cdp('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: false, contextId: ctxId });
      value = r && r.result ? r.result.value : undefined;
    } catch (e) {
      tried.push({ frameId: f.id, url: f.url, error: String((e && e.message) || e) });
      continue;
    }
    tried.push({ frameId: f.id, url: f.url });
    last = { value: value, frameUrl: f.url, frameId: f.id, depth: f.depth };
    if (wantFilled) {
      const v = value;
      if (v && typeof v === 'object' && (v.userFilled || v.passFilled)) return { ok: true, value: v, frameUrl: f.url, frameId: f.id, depth: f.depth, tried: tried };
      if (v && typeof v === 'object' && v.ok === true) return { ok: true, value: v, frameUrl: f.url, frameId: f.id, depth: f.depth, tried: tried };
    } else {
      return { ok: true, value: value, frameUrl: f.url, frameId: f.id, depth: f.depth, tried: tried };
    }
  }
  return { ok: false, value: last ? last.value : null, frameUrl: last ? last.frameUrl : '', frameId: last ? last.frameId : '', depth: last ? last.depth : -1, tried: tried };
}
`;
