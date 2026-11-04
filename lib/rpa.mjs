/**
 * rpa.mjs —— 声明式采集 DSL 的编译与执行（v0.13.0）。
 *
 * 设计思路：
 * 采集配方不是写死的抓取代码，而是一份 **DSL（JSON 步骤集）**：
 *
 *   { "id": "tb_shop_overview",
 *     "conditions": { "time": { "kind": "range", "bindings": { "{dateRange}": "$condition.encoded" } } },
 *     "template": { "defaults": {...}, "steps": [
 *        {"action":"goto","url":"https://sycm.taobao.com/portal/home.htm","after":[{"action":"click","target":[...]}]},
 *        {"action":"waitTimeout","ms":3000},
 *        {"action":"readPageUrl","outputKey":"login_guard_entry_url"},
 *        {"action":"when","condition":{"kind":"element","target":[...],"state":"visible"},
 *         "then":[{"action":"assertElement","state":"hidden","onError":"fail","id":"...LOGIN_REQUIRED..."}]},
 *        {"action":"goto","url":"https://sycm.taobao.com/.../trend/v3.json?dateType=day&dateRange={dateRange}"},
 *        {"action":"readText","target":[{"by":"css","value":"pre"}],"outputKey":"overviewResponse"} ] },
 *     "collection": { "schedule": {"mode":"trailing_window","days":30,"query_anchor":"end"},
 *                     "artifacts": [{"role":"business","kind":"json_string","output_key":"overviewResponse"}] } }
 *
 * 为什么这么设计（而不是给每个指标写一段抓取代码）：
 *   · 站点改版只改 DSL 数据，不动代码；
 *   · 「进页面拿登录态 → 直接 goto 站内 JSON 接口 → 读 <pre> 文本」比点报表/下载 Excel 稳得多；
 *   · 登录守卫写成「命中登录框 → 断言它必须不可见（必然失败）」，用失败把 LOGIN_REQUIRED 传出来。
 *
 * 本模块分两层：
 *   1. **编译层（Node 侧，唯一真源）**：`compileExecution()` 把 DSL + 时间参数编译成 op 列表
 *      （goto / sleep / url / eval / wait / assert / branch），选择器、可见性判断、占位符填参全在这里；
 *   2. **执行层（哑执行器）**：`runOps()` 用 driver 跑 ops；ego 后端把同一份 ops 交给
 *      `EGO_EXECUTOR_SOURCE`（在 ego 运行时里跑，一次任务空间进出），语义完全一致、不用重复实现。
 */

import { evaluateOn, listPages, cdpCall, newPage } from './cdp.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 支持的步骤动作；表外动作默认报 UNSUPPORTED（不静默跳过，避免"假成功"）。 */
export const SUPPORTED_ACTIONS = new Set([
  'goto', 'waitTimeout', 'waitFor', 'readPageUrl', 'readText', 'click',
  'assertElement', 'when', 'evaluate',
]);

export const RPA_CODES = {
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  STEP_FAILED: 'STEP_FAILED',
  UNSUPPORTED: 'UNSUPPORTED_ACTION',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  TIMEOUT: 'STEP_TIMEOUT',
  NO_DRIVER: 'NO_DRIVER',
  INVALID_DSL: 'INVALID_DSL',
  TARGET_NOT_AVAILABLE: 'TARGET_NOT_AVAILABLE',
  PDD_FONT_DECRYPT_FAILED: 'PDD_FONT_DECRYPT_FAILED',
};

/**
 * 配方可以声明「采集后处理」能力（`collection.capabilities.after`）。
 *
 * `pdd_decrypt`（v0.16.8 起支持）：某些后台页面把数字渲染成私有区字符（U+E000–U+F8FF），
 * 靠页面动态注入的网页字体给出字形，码位每次会话都会重排 → 只能「按字形匹配」还原。
 * 处理方式是**按需**的：抓到的文本里没有私有区字符就什么都不用做（这叫 skip），
 * 有就先在页面里给这些码位逐个取字形，再和标准数字比对，得到本次会话的映射表后解码。
 * 映射建不全时如实报 `PDD_FONT_DECRYPT_FAILED`，不把没解开的数字当业务数据往下传。
 */
export const SUPPORTED_CAPABILITIES = new Set(['pdd_decrypt']);

export const PRIVATE_USE_RE = /[\ue000-\uf8ff]/;

/** 文本里出现的私有区码位（去重、升序，形如 `U+E3F7`）。 */
export function privateUseCodes(text) {
  const out = new Set();
  for (const ch of String(text == null ? '' : text)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xe000 && cp <= 0xf8ff) out.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  return Array.from(out).sort();
}

/** 把 `{E3F7:'2'}` 这类会话映射套到文本上；认不出的码位留成 `[?U+XXXX]` 以便如实暴露。 */
export function decodePrivateUseText(text, mapping) {
  const map = mapping || {};
  let out = '';
  for (const ch of String(text == null ? '' : text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0xe000 || cp > 0xf8ff) { out += ch; continue; }
    const key = cp.toString(16).toUpperCase().padStart(4, '0');
    const digit = map[key];
    out += digit === undefined ? `[?U+${key}]` : String(digit);
  }
  return out;
}

/**
 * 页面内取字形的脚本：给一批私有区码位，用页面里已注入的网页字体把它们画到位图上，
 * 再和用普通字体画出来的 0–9 比对，同一会话内建 `{码位 → 数字}` 映射。
 * 只读字面、不读页面数据、不落盘；渲染/比对全在浏览器内存里。
 */
export const FONT_DECODE_EXPR_FN = `(function (codes, opts) {
  const o = opts || {};
  const FAMILY_FALLBACK = ['spider-font', 'PDD-spider-font', 'pdd-spider-font'];
  const W = 32, H = 48, SIZE = 64;
  const norm = (v) => String(v == null ? '' : v);
  function family() {
    const declared = o.family ? [o.family] : [];
    const stack = (getComputedStyle(document.body || document.documentElement).fontFamily || '')
      .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    const known = [];
    try {
      document.fonts.forEach((f) => { if (f && f.family) known.push(String(f.family)); });
    } catch (e) { /* ignore */ }
    return declared.concat(FAMILY_FALLBACK, known, stack);
  }
  function draw(ch, fam) {
    const cv = document.createElement('canvas');
    cv.width = SIZE * 2; cv.height = Math.round(SIZE * 1.8);
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#000';
    ctx.font = SIZE + 'px ' + JSON.stringify(fam) + ', sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ch, 4, SIZE);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
    const on = new Uint8Array(cv.width * cv.height);
    for (let y = 0; y < cv.height; y += 1) {
      for (let x = 0; x < cv.width; x += 1) {
        const idx = y * cv.width + x;
        const v = data[idx * 4];
        if (v < 128) {
          on[idx] = 1;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    // 最近邻缩放回 32×48，得到与参考位图同规格的指纹
    let bits = '';
    for (let gy = 0; gy < H; gy += 1) {
      for (let gx = 0; gx < W; gx += 1) {
        const sx = minX + Math.min(bw - 1, Math.floor((gx * bw) / W));
        const sy = minY + Math.min(bh - 1, Math.floor((gy * bh) / H));
        bits += on[sy * cv.width + sx] ? '1' : '0';
      }
    }
    return { bits, w: bw, h: bh };
  }
  function iou(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let inter = 0, union = 0;
    for (let i = 0; i < a.length; i += 1) {
      const ia = a[i] === '1', ib = b[i] === '1';
      if (ia && ib) inter += 1;
      if (ia || ib) union += 1;
    }
    return union ? inter / union : 0;
  }
  function referenceBits(fam) {
    const out = {};
    for (let d = 0; d <= 9; d += 1) {
      const r = draw(String(d), fam);
      if (r) out[String(d)] = r.bits;
    }
    return out;
  }
  const fams = family();
  let ref = null, refFamily = '';
  for (const fam of fams) {
    const bits = referenceBits(fam);
    if (Object.keys(bits).length >= 10) { ref = bits; refFamily = fam; break; }
  }
  if (!ref) return { ok: false, reason: 'no-reference-digits', tried: fams.slice(0, 6) };
  const found = [], candidates = [];
  for (const code of (codes || [])) {
    const cp = parseInt(String(code).replace(/^U\\+/i, ''), 16);
    if (!Number.isFinite(cp)) continue;
    const ch = String.fromCodePoint(cp);
    const best = [];
    for (const fam of fams) {
      const r = draw(ch, fam);
      if (!r) continue;
      const scored = Object.keys(ref).map((d) => ({ digit: d, score: iou(r.bits, ref[d]) }))
        .sort((a, b) => b.score - a.score);
      best.push({ family: fam, top: scored[0], runner: scored[1] || { digit: '', score: 0 }, shape: r });
    }
    if (!best.length) { candidates.push({ code, reason: 'render-failed' }); continue; }
    best.sort((a, b) => b.top.score - a.top.score);
    const winner = best[0];
    const margin = winner.top.score - winner.runner.score;
    const record = {
      code, digit: winner.top.digit, family: winner.family,
      iou: Math.round(winner.top.score * 1000) / 1000,
      margin: Math.round(margin * 1000) / 1000,
      runnerUp: winner.runner.digit, shape: winner.shape,
    };
    // 相似度太低、或与次优差距太小 → 宁可不认也不猜
    if (record.iou < 0.55 || record.margin < 0.06) { candidates.push({ ...record, reason: 'ambiguous' }); continue; }
    found.push(record);
  }
  // 一个码位抢到一个数字，若同一数字被两个码位同时认领 → 两个都作废
  const byDigit = {};
  for (const item of found) (byDigit[item.digit] = byDigit[item.digit] || []).push(item);
  const mapping = {}, conflicts = [];
  for (const [digit, items] of Object.entries(byDigit)) {
    if (items.length > 1) { conflicts.push({ digit, codes: items.map((i) => i.code) }); continue; }
    mapping[items[0].code] = digit;
  }
  return { ok: true, mapping, referenceFamily: refFamily, decoded: Object.keys(mapping).length, conflicts, unresolved: candidates };
})`;

/** 把页面内脚本包成一次求值：`codes` 是 `['U+E3F7', …]`。 */
export function fontDecodeExpression(codes) {
  return `(${FONT_DECODE_EXPR_FN})(${JSON.stringify(codes)}, null)`;
}

/** 文本 → 数值型指标（供 `text_metrics` 这类按页面文字取数的配方用）。 */
export function parseTextMetrics(text, spec) {
  const src = String(text == null ? '' : text);
  const metrics = (spec && spec.metrics) || [];
  const yesterdayWord = String((spec && spec.yesterdayLabel) || '昨日');
  const NUM = '([-+]?[0-9]+(?:\\.[0-9]+)?)';
  const values = {}, yesterday = {}, missing = [];
  for (const m of metrics) {
    const id = String((m && m.id) || '');
    const label = String((m && m.label) || '');
    if (!id || !label) continue;
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*' + NUM);
    const hit = re.exec(src);
    if (!hit) { missing.push(id); continue; }
    const value = Number(hit[1]);
    if (!Number.isFinite(value)) { missing.push(id); continue; }
    values[id] = value;
    const tail = src.slice(hit.index + hit[0].length, hit.index + hit[0].length + 24);
    const prev = new RegExp(yesterdayWord + '\\s*' + NUM).exec(tail);
    if (prev) {
      const v = Number(prev[1]);
      if (Number.isFinite(v)) yesterday[id] = v;
    }
  }
  return { values, yesterday, missing, matched: Object.keys(values).length };
}

const DEFAULT_TIMEOUT = 15000;

// ── 页面内脚本（选择器解析 / 可见性 / 点击 / 读文本）──────────────────────────
// 候选 target 依次尝试，先命中先返回；只做读/点/判可见这类无害操作，
// 不注入 fetch/XHR 钩子、不读 cookie、不碰 localStorage。
export const PAGE_PRELUDE = `(() => {
  const norm = (v) => String(v == null ? '' : v);
  const list = (t) => (Array.isArray(t) ? t : (t ? [t] : []));
  const nthOf = (t) => (Number.isInteger(t && t.nth) ? t.nth : 0);
  // 站点配方里的选择器带 jQuery 扩展伪类（:visible / :text-is("x") / :has(:text-is("x"))），
  // 原生 querySelectorAll 会直接抛错。这里把它们拆出来：能用 CSS 的部分照常用，
  // 拆掉之后失效的（例如整段就是 :has(:text-is(...)))就退化成「按文字找可见元素」。
  const cleanWant = (v) => { let t = String(v == null ? '' : v).trim(); if (t.charAt(0) === '$') t = t.slice(1).trim(); return t; };
  function stripBarePseudo(css) {
    let out = css;
    for (const bare of [':is', ':has', ':not']) {
      let idx = out.indexOf(bare);
      while (idx !== -1) {
        if (out.charAt(idx + bare.length) === '(') { idx = out.indexOf(bare, idx + bare.length); continue; }
        out = out.slice(0, idx) + out.slice(idx + bare.length);
        idx = out.indexOf(bare, idx);
      }
    }
    return out;
  }
  // 上游配方用 $ 前缀标「精确文字」，例如 //*[...][normalize-space(.)='$近30天']。
  // xpath 里的 $ 只是一个标记，直接去掉，否则会当成字面量去匹配「$近30天」。
  function cleanXPath(value) {
    let out = String(value == null ? '' : value);
    out = out.replace(/'\\$([^']*)'/g, "'$1'");
    out = out.replace(/"\\$([^"]*)"/g, '"$1"');
    return out;
  }
  function splitPseudo(value) {
    let css = String(value || '');
    const texts = [];
    css = css.replace(/:(text-is|has-text|contains)\\(\\s*(?:"([^"]*)"|'([^']*)')\\s*\\)/g, function (m, kind, dq, sq) {
      texts.push(cleanWant(dq != null ? dq : sq));
      return '';
    });
    const needVisible = /:visible/.test(css);
    css = css.replace(/:visible/g, '');
    css = css.replace(/:(?:is|has|not)\\(\\s*\\)/g, '');
    css = stripBarePseudo(css);
    css = css.replace(/\\(\\s*,?\\s*\\)/g, '');
    css = stripBarePseudo(css);
    return { css: css.trim(), texts: texts.filter(Boolean), needVisible: needVisible };
  }
  function selectNodes(root, t) {
    const value = norm(t && t.value);
    const p = splitPseudo(value);
    const doc0 = root || document;
    let nodes = [];
    let cssInvalid = !p.css;
    try { nodes = Array.from(doc0.querySelectorAll(p.css)); } catch (e) { nodes = []; cssInvalid = true; }
    if (nodes.length && p.texts.length) {
      nodes = nodes.filter(function (el) {
        const ss = String((el && el.textContent) || '').trim();
        return p.texts.some(function (w) { return ss === w || ss.indexOf(w) !== -1; });
      });
    }
    if (p.needVisible) nodes = nodes.filter(visible);
    if (nodes.length === 0 && p.texts.length && cssInvalid) {
      const all = Array.from(doc0.querySelectorAll('*'));
      nodes = all.filter(function (el) {
        const ss = String((el && el.textContent) || '').trim();
        return visible(el) && p.texts.some(function (w) { return ss === w || ss.indexOf(w) !== -1; });
      });
    }
    if (nodes.length && p.texts.length) {
      const exact = nodes.filter(function (el) {
        const ss = String((el && el.textContent) || '').trim();
        return p.texts.some(function (w) { return ss === w; });
      });
      if (exact.length) nodes = exact;
    }
    return nodes;
  }
  function queryOne(t) {
    const by = norm(t && t.by).toLowerCase() || 'css';
    const value = norm(t && t.value);
    if (!value) return null;
    try {
      if (by === 'xpath') {
        const r = document.evaluate(cleanXPath(value), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return r.snapshotItem(nthOf(t));
      }
      if (by === 'id') return document.getElementById(value);
      if (by === 'text') {
        const want = value.trim();
        const all = document.querySelectorAll('body *');
        let seen = 0;
        for (const el of all) {
          if (el.children.length === 0 && (el.textContent || '').trim() === want) {
            if (seen === nthOf(t)) return el;
            seen += 1;
          }
        }
        return null;
      }
      return selectNodes(document, t)[nthOf(t)] || null;
    } catch (e) { return null; }
  }
  function scopedDoc(frameSpec) {
    if (!frameSpec) return { doc: document };
    try {
      const fe = queryOne(list(frameSpec)[0]);
      const doc = fe && (fe.contentDocument || (fe.contentWindow && fe.contentWindow.document));
      return doc ? { doc } : { blocked: true };
    } catch (e) { return { blocked: true }; }
  }
  function queryIn(doc, t) {
    const by = norm(t && t.by).toLowerCase() || 'css';
    const value = norm(t && t.value);
    try {
      if (by === 'xpath') {
        const r = doc.evaluate(cleanXPath(value), doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return r.snapshotItem(nthOf(t));
      }
      if (by === 'id') return doc.getElementById(value);
      return selectNodes(doc, t)[nthOf(t)] || null;
    } catch (e) { return null; }
  }
  function find(target, frameSpec) {
    const scope = scopedDoc(frameSpec);
    if (scope.blocked) return { blocked: true };
    for (const t of list(target)) {
      const el = scope.doc === document ? queryOne(t) : queryIn(scope.doc, t);
      if (el) return { el };
    }
    return { el: null };
  }
  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const st = window.getComputedStyle(el);
    if (!st || st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    return true;
  }
  window.__rpa = { find, visible, queryOne, selectNodes, splitPseudo };
  return true;
})()`;

function j(value) { return JSON.stringify(value === undefined ? null : value); }

/** 「元素是否可见」表达式。 */
export function exprExists(target, frame) {
  return `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(target)}, ${j(frame || null)});
  if (hit.blocked) return { blocked: true };
  return { found: Boolean(hit.el), visible: window.__rpa.visible(hit.el) };
})()`;
}

/** 点击表达式。 */
export function exprRect(target, frame) {
  return `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(target)}, ${j(frame || null)});
  if (hit.blocked) return { blocked: true };
  if (!hit.el) return { found: false };
  try { hit.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  const r = hit.el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { found: true, visible: false, x: 0, y: 0, w: Math.round(r.width), h: Math.round(r.height) };
  return { found: true, visible: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
})()`;
}

export function exprClick(target, frame) {
  return `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(target)}, ${j(frame || null)});
  if (hit.blocked) return { blocked: true };
  if (!hit.el) return { found: false };
  try { hit.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  try { hit.el.click(); } catch (e) { return { found: true, clicked: false, error: String((e && e.message) || e) }; }
  return { found: true, clicked: true };
})()`;
}

/** 读文本表达式（readMode: textContent | value | innerHTML）。 */
export function exprText(target, { mode = 'textContent', trim = true, frame = null } = {}) {
  return `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(target)}, ${j(frame || null)});
  if (hit.blocked) return { blocked: true };
  if (!hit.el) return { found: false };
  const m = ${j(String(mode || 'textContent'))};
  let text = m === 'value' ? String(hit.el.value == null ? '' : hit.el.value)
    : m === 'innerHTML' ? String(hit.el.innerHTML == null ? '' : hit.el.innerHTML)
    : String(hit.el.textContent == null ? '' : hit.el.textContent);
  if (${trim === false ? 'false' : 'true'}) text = text.trim();
  return { found: true, text };
})()`;
}

/** 通用表达式（evaluate 动作 / condition.kind=expression）。 */
export function exprUser(expression) {
  return `(() => { try { const v = (function(){ ${String(expression || 'return null;')} })(); return { ok: true, value: v === undefined ? null : v }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()`;
}

// ── 补充动作的页面表达式（v0.13.0 覆盖配方里的高频动作）────────────────────

/** 滚动到元素（scrollIntoView）；toBottom=true 时滚到底。 */
export function exprScroll(target, frame, toBottom = false) {
  if (toBottom) {
    return `(() => { try { window.scrollTo(0, document.body ? document.body.scrollHeight : 0); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()`;
  }
  return `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(target)}, ${j(frame || null)});
  if (hit.blocked) return { blocked: true };
  if (!hit.el) return { found: false };
  try { hit.el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  return { found: true };
})()`;
}

/** 填值（type）：原生 setter + input/change 事件，React/Vue 受控组件也认（同 autologin 的思路）。 */
export function exprType(target, text, frame) {
  return `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(target)}, ${j(frame || null)});
  if (hit.blocked) return { blocked: true };
  if (!hit.el) return { found: false };
  const el = hit.el;
  const value = ${j(String(text == null ? '' : text))};
  try {
    const proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, value: el.value };
  } catch (e) { return { found: true, error: String((e && e.message) || e) }; }
})()`;
}

/** 读属性（readAttribute）。 */
export function exprAttribute(target, name, frame) {
  return `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(target)}, ${j(frame || null)});
  if (hit.blocked) return { blocked: true };
  if (!hit.el) return { found: false };
  return { found: true, value: hit.el.getAttribute(${j(String(name || ''))}) };
})()`;
}

/** 批量读文本（queryAll）：返回 [{text}] 数组，上限 2000 条。 */
export function exprQueryAll(target, { limit = 2000 } = {}) {
  const t = Array.isArray(target) ? target[0] : target;
  return `${PAGE_PRELUDE};(() => {
  try {
    const by = ${j(String((t && t.by) || 'css').toLowerCase())};
    const value = ${j(String((t && t.value) || ''))};
    const cap = ${Number(limit) > 0 ? Number(limit) : 2000};
    let nodes = [];
    if (by === 'xpath') {
      const r = document.evaluate(value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength && i < cap; i += 1) { const el = r.snapshotItem(i); if (el) nodes.push(el); }
    } else {
      nodes = window.__rpa.selectNodes(document, { by: by, value: value }).slice(0, cap);
    }
    return { ok: true, items: nodes.map((el) => ({ text: String(el.textContent == null ? '' : el.textContent).trim() })) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
})()`;
}

// ── 时间条件与占位符 ────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDay(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/**
 * 「最近 N 个完整自然日」（trailing_window：锚在 end，30 天前到昨天，不含今天）。
 * @returns {{start:string,end:string,days:number}}
 */
export function trailingWindow(now = new Date(), days = 30) {
  const n = Number(days) > 0 ? Number(days) : 30;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  return { start: fmtDay(start), end: fmtDay(end), days: n };
}

/**
 * conditions → 占位符取值。站长接口常吃 `dateRange=YYYY-MM-DD%7CYYYY-MM-DD`（竖线转义），
 * DSL 里用 `$condition.encoded` 声明，这里按 kind 生成 encoded / start / end。
 */
export function conditionValues(dsl, { start, end, extra } = {}) {
  const cond = (dsl && dsl.conditions) || {};
  const out = { ...(extra && typeof extra === 'object' ? extra : {}) };
  for (const [, spec] of Object.entries(cond)) {
    const kind = String((spec && spec.kind) || '').toLowerCase();
    const vals = {};
    if (kind === 'range' || kind === 'window') {
      vals.start = start;
      vals.end = end;
      // 站内接口大多吃 `YYYY-MM-DD|YYYY-MM-DD`；竖线在 URL 里要编码成 %7C
      vals.encoded = `${start}%7C${end}`;
    } else if (kind === 'day' || kind === 'date') {
      vals.day = end;
      vals.date = end;
    } else if (kind === 'days') {
      vals.days = String(Number((spec && spec.days) || 30));
    }
    Object.assign(out, vals);
    // bindings 把「占位符名」显式绑到某个条件值上：`{"{dateRange}": "$condition.encoded"}`
    // —— 配方里就是这么绑的，不实现 `{dateRange}` 永远填不上。
    const bindings = spec && spec.bindings;
    if (bindings && typeof bindings === 'object') {
      for (const [placeholder, ref] of Object.entries(bindings)) {
        const name = String(placeholder).replace(/[{}]/g, '').replace(/^\$/, '').trim();
        if (!name) continue;
        const refKey = String(ref || '').replace(/^\$condition\.?/, '').replace(/^\$/, '').trim();
        if (refKey && Object.prototype.hasOwnProperty.call(vals, refKey)) out[name] = vals[refKey];
        else if (Object.prototype.hasOwnProperty.call(vals, name)) out[name] = vals[name];
      }
    }
  }
  if (out.start === undefined && start) out.start = start;
  if (out.end === undefined && end) out.end = end;
  if (out.encoded === undefined && start && end) out.encoded = `${start}%7C${end}`;
  return out;
}

/** 递归替换 `{name}` 与 `${name}`（未声明的占位符原样保留，由校验报错）。 */
function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_$][\w$]*)\}|\{([A-Za-z_$][\w$]*)\}/g, (whole, a, b) => {
      const key = a || b;
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = fillTemplate(v, vars);
    return o;
  }
  return value;
}

/** 填参后仍残留的占位符（不能把 `{dateRange}` 直接发给站点）。 */
export function unresolvedPlaceholders(value, out = []) {
  if (typeof value === 'string') {
    const m = value.match(/\$\{([A-Za-z_$][\w$]*)\}|\{([A-Za-z_$][\w$]*)\}/g);
    if (m) out.push(...m);
  } else if (Array.isArray(value)) value.forEach((v) => unresolvedPlaceholders(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => unresolvedPlaceholders(v, out));
  return [...new Set(out)];
}

// ── DSL 解析 ────────────────────────────────────────────────────────────────

export function parseDsl(raw) {
  let dsl = raw;
  if (typeof raw === 'string') {
    try { dsl = JSON.parse(raw); } catch (err) {
      throw Object.assign(new Error(`DSL 不是合法 JSON：${(err && err.message) || err}`), { code: RPA_CODES.INVALID_DSL });
    }
  }
  if (!dsl || typeof dsl !== 'object') throw Object.assign(new Error('DSL 不是对象'), { code: RPA_CODES.INVALID_DSL });
  const tpl = dsl.template || {};
  const steps = tpl.steps;
  if (!Array.isArray(steps) || !steps.length) {
    throw Object.assign(new Error(`DSL ${dsl.id || '(无 id)'} 没有 steps`), { code: RPA_CODES.INVALID_DSL });
  }
  return {
    id: String(dsl.id || tpl.name || ''),
    platform: String(dsl.platform || ''),
    description: String(dsl.description || tpl.description || ''),
    conditions: dsl.conditions || {},
    defaults: { timeoutMs: DEFAULT_TIMEOUT, retries: 0, stepGapMs: 0, continueOnError: false, ...(tpl.defaults || {}) },
    steps,
    collection: dsl.collection || {},
    raw: dsl,
  };
}

/** DSL 声明的时间窗口（`collection.schedule.days`，默认 30）。 */
export function dslWindow(dsl, now = new Date()) {
  const sched = (dsl && dsl.collection && dsl.collection.schedule) || {};
  return trailingWindow(now, Number(sched.days) > 0 ? Number(sched.days) : 30);
}

/** 编译：DSL + 时间 → {dsl, steps(已填参), vars, window}；有残留占位符直接抛。 */
export function buildExecution(dslInput, opts = {}) {
  const dsl = dslInput && dslInput.steps ? dslInput : parseDsl(dslInput);
  const win = opts.start && opts.end
    ? { start: String(opts.start), end: String(opts.end), days: 0 }
    : dslWindow(dsl, opts.now instanceof Date ? opts.now : new Date());
  // 自动参数：`runId` 由编排层生成（DSL 里用 `{runId}` 给文件/目录命名），
  // 不给就会残留占位符；productIds 数组也顺带从 productId 派生，省得调用方每次写两遍。
  const auto = {
    runId: opts.runId || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ...(opts.params && typeof opts.params === 'object' ? opts.params : {}),
  };
  if (auto.productId && auto.productIds === undefined) auto.productIds = String(auto.productId);
  if (Array.isArray(auto.productIds)) auto.productIds = auto.productIds.join(',');
  // 「查询口径」和「覆盖口径」是两回事（v0.16.7）：
  //   trailing_window / per_day / snapshot 这类配方的接口按**单日锚点**查（如生意参谋趋势接口
  //   `dateRange=当天|当天` 才返回最近 30 天曲线），传整段 30 天范围会被接口判参数错误（code 1003）。
  //   所以查询用锚点日；覆盖天数仍按声明的窗口（30 天）记台账。
  const sched = (dsl.collection && dsl.collection.schedule) || {};
  const mode = String(sched.mode || '').toLowerCase();
  const anchorFirst = String(sched.query_anchor || 'end').toLowerCase() === 'start';
  const anchorDay = anchorFirst ? win.start : win.end;
  const singleDayQuery = mode === 'trailing_window' || mode === 'per_day' || mode === 'snapshot';
  const queryStart = singleDayQuery ? anchorDay : win.start;
  const queryEnd = singleDayQuery ? anchorDay : win.end;
  const vars = conditionValues(dsl, { start: queryStart, end: queryEnd, extra: auto });
  const steps = fillTemplate(dsl.steps, vars);
  const leftover = unresolvedPlaceholders(steps);
  if (leftover.length) {
    throw Object.assign(new Error(`DSL ${dsl.id} 还有没填的参数：${leftover.join(' ')}（用 params 传业务参数）`), {
      code: RPA_CODES.INVALID_DSL, unresolved: leftover,
    });
  }
  return {
    dsl, steps, vars,
    window: { start: win.start, end: win.end },
    query: { start: queryStart, end: queryEnd, singleDay: singleDayQuery },
    defaults: dsl.defaults,
  };
}

// ── 编译成 op 列表（唯一真源；ego 运行时只当哑执行器）─────────────────────────

function timeoutOf(step, defaults) {
  const n = Number(step && step.timeoutMs);
  return Number.isFinite(n) && n > 0 ? n : defaults.timeoutMs;
}

function isLoginGuard(step) {
  return /LOGIN_REQUIRED/i.test(String((step && step.id) || '')) || /LOGIN_REQUIRED/i.test(String((step && step.description) || ''));
}

function compileAction(step, defaults, out, path) {
  const action = String((step && step.action) || '').toLowerCase();
  const stepId = String((step && step.id) || '') || `${path}:${action}`;
  const optional = step.optional === true || step.onError === 'continue';
  const timeoutMs = timeoutOf(step, defaults);

  if (action === 'goto') {
    if (!step.url) throw Object.assign(new Error('goto 缺 url'), { code: RPA_CODES.INVALID_DSL });
    out.push({ op: 'goto', url: String(step.url), waitUntil: String(step.waitUntil || 'domcontentloaded'), timeoutMs, stepId });
    for (const after of Array.isArray(step.after) ? step.after : []) {
      compileAction({ optional: true, onError: 'continue', ...after }, defaults, out, `${stepId}>after`);
    }
    return;
  }
  if (action === 'waittimeout' || action === 'wait' || action === 'sleep') {
    out.push({ op: 'sleep', ms: Number(step.ms) > 0 ? Number(step.ms) : timeoutMs, stepId });
    return;
  }
  if (action === 'readpageurl') {
    out.push({ op: 'url', outputKey: String(step.outputKey || ''), stepId });
    return;
  }
  if (action === 'waitfor') {
    out.push({
      op: 'wait',
      expr: exprExists(step.target, step.frame || null),
      expect: String(step.state || 'visible').toLowerCase(),
      timeoutMs,
      optional,
      stepId,
    });
    return;
  }
  if (action === 'readtext') {
    out.push({
      op: 'eval',
      expr: exprText(step.target, { mode: step.readMode, trim: step.trim, frame: step.frame || null }),
      outputKey: String(step.outputKey || ''),
      require: true,
      notFoundCode: RPA_CODES.TARGET_NOT_AVAILABLE,
      notFoundMessage: `读不到元素文本：${stepId}`,
      stepId,
    });
    return;
  }
  if (action === 'click') {
    out.push({
      op: 'click',
      expr: exprClick(step.target, step.frame || null),
      rectExpr: exprRect(step.target, step.frame || null),
      optional,
      stepId,
    });
    return;
  }
  if (action === 'assertelement') {
    out.push({
      op: 'assert',
      expr: exprExists(step.target, step.frame || null),
      expect: String(step.state || 'visible').toLowerCase(),
      code: isLoginGuard(step) ? RPA_CODES.LOGIN_REQUIRED : RPA_CODES.STEP_FAILED,
      message: isLoginGuard(step) ? '未登录或登录态失效（登录框仍可见）' : `断言失败：元素不是 ${String(step.state || 'visible')}`,
      optional,
      stepId,
    });
    return;
  }
  if (action === 'when') {
    const cond = step.condition || {};
    const kind = String(cond.kind || 'element').toLowerCase();
    let condOp;
    if (kind === 'element') {
      condOp = {
        op: 'wait',
        expr: exprExists(cond.target, cond.frame || null),
        expect: String(cond.state || 'visible').toLowerCase(),
        timeoutMs: Number(cond.timeoutMs) > 0 ? Number(cond.timeoutMs) : timeoutMs,
        optional: true,
        stepId,
        asCondition: true,
      };
    } else if (kind === 'expression') {
      condOp = { op: 'eval', expr: exprUser(cond.expression || 'return false;'), stepId, asCondition: true };
    } else {
      // url 之类的条件：编译期没法判，交给运行时按 finalUrl 判断
      condOp = { op: 'urlCondition', value: String(cond.value || ''), pattern: String(cond.pattern || ''), stepId, asCondition: true };
    }
    const branchOps = [];
    for (const nested of Array.isArray(step.then) ? step.then : []) {
      compileAction(nested, defaults, branchOps, `${stepId}>then`);
    }
    out.push({ op: 'branch', cond: condOp, ops: branchOps, stepId });
    return;
  }
  if (action === 'evaluate') {
    out.push({ op: 'eval', expr: exprUser(step.expression || 'return null;'), outputKey: String(step.outputKey || ''), stepId });
    return;
  }
  // ── v0.13.0 补充动作（按配方里的实际使用频次排序）──────────────────────
  if (action === 'runscript') {
    // DSL 直接给一段页面脚本：等价于 evaluate，但输出键可省
    out.push({ op: 'eval', expr: exprUser(step.script || step.expression || 'return null;'), outputKey: String(step.outputKey || ''), stepId });
    return;
  }
  if (action === 'scrollintoview') {
    out.push({ op: 'eval', expr: exprScroll(step.target, step.frame || null, false), optional: true, stepId });
    return;
  }
  if (action === 'scrolltobottom') {
    out.push({ op: 'eval', expr: exprScroll(null, null, true), optional: true, stepId });
    return;
  }
  if (action === 'type' || action === 'fill') {
    const text = step.value !== undefined ? step.value : (step.text !== undefined ? step.text : step.input);
    out.push({ op: 'eval', expr: exprType(step.target, text, step.frame || null), require: true, notFoundCode: RPA_CODES.TARGET_NOT_AVAILABLE, notFoundMessage: `填不进去（找不到输入框）：${stepId}`, stepId });
    return;
  }
  if (action === 'hover') {
    out.push({
      op: 'eval',
      expr: `${PAGE_PRELUDE};(() => {
  const hit = window.__rpa.find(${j(step.target)}, ${j(step.frame || null)});
  if (hit.blocked) return { blocked: true };
  if (!hit.el) return { found: false };
  try { hit.el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); hit.el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); } catch (e) {}
  return { found: true };
})()`,
      optional: true,
      stepId,
    });
    return;
  }
  if (action === 'readattribute') {
    out.push({ op: 'eval', expr: exprAttribute(step.target, step.attribute || step.name || '', step.frame || null), outputKey: String(step.outputKey || ''), require: true, notFoundCode: RPA_CODES.TARGET_NOT_AVAILABLE, stepId });
    return;
  }
  if (action === 'queryall') {
    out.push({ op: 'eval', expr: exprQueryAll(step.target), outputKey: String(step.outputKey || ''), stepId });
    return;
  }
  if (action === 'asserttext') {
    out.push({
      op: 'assertText',
      expr: exprText(step.target, { mode: step.readMode, trim: step.trim, frame: step.frame || null }),
      expect: String(step.expect !== undefined ? step.expect : (step.text !== undefined ? step.text : (step.value !== undefined ? step.value : ''))),
      mode: String(step.match || (step.contains ? 'contains' : 'equals')),
      optional,
      stepId,
    });
    return;
  }
  if (action === 'clickandwait') {
    out.push({ op: 'click', expr: exprClick(step.target, step.frame || null), optional, stepId });
    out.push({ op: 'sleep', ms: Number(step.ms) > 0 ? Number(step.ms) : 1500, stepId: `${stepId}:wait` });
    return;
  }
  if (action === 'waitforloadstate') {
    out.push({ op: 'loadState', state: String(step.state || 'load'), timeoutMs, stepId });
    return;
  }
  if (action === 'press') {
    out.push({ op: 'press', key: String(step.key || step.value || 'Enter'), optional, stepId });
    return;
  }
  if (action === 'if') {
    const cond = step.condition || {};
    const condOp = String(cond.kind || 'element') === 'element'
      ? { op: 'wait', expr: exprExists(cond.target, cond.frame || null), expect: String(cond.state || 'visible').toLowerCase(), timeoutMs: Number(cond.timeoutMs) > 0 ? Number(cond.timeoutMs) : timeoutMs, optional: true, stepId, asCondition: true }
      : { op: 'eval', expr: exprUser(cond.expression || 'return false;'), stepId, asCondition: true };
    const thenOps = [];
    for (const nested of Array.isArray(step.then) ? step.then : []) compileAction(nested, defaults, thenOps, `${stepId}>then`);
    const elseOps = [];
    for (const nested of Array.isArray(step.else) ? step.else : []) compileAction(nested, defaults, elseOps, `${stepId}>else`);
    out.push({ op: 'branch', cond: condOp, ops: thenOps, elseOps, stepId });
    return;
  }
  if (action === 'while') {
    const cond = step.condition || {};
    const condOp = String(cond.kind || 'element') === 'element'
      ? { op: 'wait', expr: exprExists(cond.target, cond.frame || null), expect: String(cond.state || 'visible').toLowerCase(), timeoutMs: Number(cond.timeoutMs) > 0 ? Number(cond.timeoutMs) : timeoutMs, optional: true, stepId, asCondition: true }
      : { op: 'eval', expr: exprUser(cond.expression || 'return false;'), stepId, asCondition: true };
    const body = [];
    for (const nested of Array.isArray(step.do) ? step.do : (Array.isArray(step.steps) ? step.steps : [])) compileAction(nested, defaults, body, `${stepId}>do`);
    out.push({ op: 'loop', cond: condOp, ops: body, maxIterations: Number(step.maxIterations) > 0 ? Number(step.maxIterations) : 20, stepId });
    return;
  }
  if (action === 'downloadfile') {
    // 下载型配方（外部配方库里很常见）：点下载按钮 → 浏览器把文件落到我们指定的目录 → 轮询取文件。
    // 这条路线要靠 driver 设置 `Page.setDownloadBehavior`；driver 不支持时如实报 UNSUPPORTED。
    out.push({
      op: 'download',
      expr: step.target ? exprClick(step.target, step.frame || null) : '',
      outputKey: String(step.outputKey || ''),
      saveName: String(step.fileName || step.saveName || ''),
      timeoutMs: Number(step.timeoutMs) > 0 ? Number(step.timeoutMs) : 60000,
      optional,
      stepId,
    });
    return;
  }
  if (optional) {
    out.push({ op: 'skip', reason: `不支持的步骤动作：${action}（声明为可继续，跳过）`, stepId });
    return;
  }
  throw Object.assign(new Error(`不支持的步骤动作：${action}（${stepId}）`), { code: RPA_CODES.UNSUPPORTED, stepId });
}

/**
 * 编译整条 DSL：返回 `{dslId, ops, window, artifacts(dsl 声明), trace 用元数据}`。
 * 递归展开 after / when.then；保留 stepId 便于报错定位。
 */
export function compileExecution(dslInput, opts = {}) {
  const exec = buildExecution(dslInput, opts);
  // 「采集后处理」能力门控（v0.16.7）：配方声明了本插件没有的后处理能力（解密器等）时，
  // 提前、明确地报不支持 —— 否则跑完只会得到「空业务数据」，看起来像站点没数据。
  const afterCaps = (((exec.dsl.collection || {}).capabilities || {}).after) || [];
  const missingCaps = Array.isArray(afterCaps)
    ? afterCaps.map((c) => String(c || '')).filter(Boolean).filter((c) => !SUPPORTED_CAPABILITIES.has(c))
    : [];
  if (missingCaps.length) {
    throw Object.assign(
      new Error(`这条配方声明了本插件没有的采集后处理能力：${missingCaps.join('、')} —— 采到的内容无法还原成业务数据`),
      { code: RPA_CODES.UNSUPPORTED_CAPABILITY, unsupported: missingCaps, dslId: String((exec.dsl && exec.dsl.id) || '') },
    );
  }
  const ops = [];
  for (const step of exec.steps) {
    compileAction(step, exec.defaults, ops, 'step');
    const gap = Number(exec.defaults.stepGapMs) > 0 ? Number(exec.defaults.stepGapMs) : 0;
    if (gap) ops.push({ op: 'sleep', ms: gap, stepId: `${String((step && step.id) || '')}:gap` });
  }
  return {
    dslId: exec.dsl.id,
    dsl: exec.dsl,
    ops,
    window: exec.window,
    defaults: exec.defaults,
    declaredArtifacts: (exec.dsl.collection && exec.dsl.collection.artifacts) || [],
    // 已声明且本插件能做的后处理（按需触发，不是一律执行）
    postprocess: Array.isArray(afterCaps) ? afterCaps.map((c) => String(c || '')).filter(Boolean) : [],
  };
}

// ── 执行层（哑执行器）──────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0))); }

function unwrap(res) {
  if (res && res.result && Object.prototype.hasOwnProperty.call(res.result, 'value')) return res.result.value;
  if (res && Object.prototype.hasOwnProperty.call(res, 'value')) return res.value;
  return res;
}

function stateMatch(value, expect) {
  const want = String(expect || 'visible').toLowerCase();
  const found = Boolean(value && value.found);
  const visible = Boolean(value && value.visible);
  if (value && value.blocked) return { ok: false, blocked: true };
  if (want === 'hidden' || want === 'not-visible' || want === 'absent') return { ok: !found || !visible };
  return { ok: found && visible };
}

/**
 * 跑编译好的 ops。driver 需要：goto(url,opts) / evaluate(expr) / url() / sleep(ms)。
 * @returns {{ok:boolean, code:string, dslId:string, outputs:object, artifacts:Array, steps:Array, finalUrl:string, window:object, error?:string}}
 */
export async function runOps(compiled, driver, opts = {}) {
  if (!driver) throw Object.assign(new Error('没有可用的浏览器驱动'), { code: RPA_CODES.NO_DRIVER });
  const outputs = {};
  const trace = [];
  let finalUrl = '';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const deadline = Date.now() + (Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10 * 60_000);
  // 下载落盘目录：没指定就用临时目录（调用方要留档的话自己传 downloadDir）
  const downloadRoot = String(opts.downloadDir || '').trim()
    || path.join(os.tmpdir(), 'dsh-shop-accounts-dl', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  let downloadReady = false;

  async function ensureDownloadDir() {
    if (downloadReady) return downloadRoot;
    try { fs.mkdirSync(downloadRoot, { recursive: true }); } catch { /* ignore */ }
    if (typeof driver.setDownloadDir === 'function') await driver.setDownloadDir(downloadRoot);
    downloadReady = true;
    return downloadRoot;
  }

  function listDownloads(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names
      .filter((n) => !/\.(crdownload|tmp|part)$/i.test(n))
      .map((n) => {
        const p = path.join(dir, n);
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* ignore */ }
        return { name: n, path: p, size };
      })
      .filter((f) => f.size > 0);
  }

  function distinctDownloads(before) {
    const seen = new Set(before.map((b) => b.path));
    return listDownloads(downloadRoot).filter((f) => !seen.has(f.path));
  }

  async function evalExpr(expr) {
    return unwrap(await driver.evaluate(expr));
  }

  async function execOps(list) {
    for (const o of list) {
      if (Date.now() > deadline) {
        throw Object.assign(new Error('采集超时（整条 DSL 超过预算）'), { code: RPA_CODES.TIMEOUT });
      }
      const at = Date.now();
      const rec = { id: o.stepId || '', op: o.op, status: 'ok', ms: 0 };
      try {
        if (o.op === 'goto') {
          await driver.goto(o.url, { waitUntil: o.waitUntil, timeoutMs: o.timeoutMs });
          finalUrl = String((await driver.url().catch(() => '')) || o.url);
        } else if (o.op === 'sleep') {
          await driver.sleep(o.ms);
        } else if (o.op === 'url') {
          finalUrl = String((await driver.url().catch(() => '')) || '');
          if (o.outputKey) outputs[o.outputKey] = finalUrl;
        } else if (o.op === 'eval') {
          const value = await evalExpr(o.expr);
          if (value && value.blocked) {
            throw Object.assign(new Error('元素在跨域 iframe 里（本引擎只能探测同源 iframe）'), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
          }
          if (o.require && value && value.found === false) {
            throw Object.assign(new Error(o.notFoundMessage || '元素不存在'), { code: o.notFoundCode || RPA_CODES.TARGET_NOT_AVAILABLE });
          }
          if (o.outputKey) {
            outputs[o.outputKey] = value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')
              ? value.text
              : (value && typeof value === 'object' && 'value' in value ? value.value : value);
          }
        } else if (o.op === 'click') {
          const rect = (o.rectExpr && typeof driver.clickAt === 'function')
            ? await evalExpr(o.rectExpr).catch(() => null)
            : null;
          if (rect && rect.blocked) throw Object.assign(new Error('按钮在跨域 iframe 里'), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
          if (rect && rect.found && rect.visible !== false) {
            await driver.clickAt(rect.x, rect.y);
            rec.clickedBy = 'mouse';
          } else {
            const r = await evalExpr(o.expr);
            if (r && r.blocked) throw Object.assign(new Error('按钮在跨域 iframe 里'), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
            if (!r || !r.found) {
              if (!o.optional) throw Object.assign(new Error(`点不到元素：${o.stepId}`), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
              rec.status = 'skipped';
            } else if (r.clicked === false && !o.optional) {
              throw Object.assign(new Error(`点击失败：${r.error || '未知'}`), { code: RPA_CODES.STEP_FAILED });
            }
          }
        } else if (o.op === 'wait') {
          const until = Date.now() + Math.max(0, o.timeoutMs || DEFAULT_TIMEOUT);
          let last = null;
          for (;;) {
            last = await evalExpr(o.expr);
            const m = stateMatch(last, o.expect);
            if (m.blocked) {
              // 当「条件判断」用时，跨域 iframe 里的元素只能算「本引擎看不到」= 条件不成立，
              // 不能当成致命错误 —— 否则页面里挂着一个登录 iframe 就会把整条配方打断（v0.16.7 修）。
              if (o.asCondition) { rec.blocked = true; break; }
              throw Object.assign(new Error('元素在跨域 iframe 里'), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
            }
            if (m.ok) break;
            if (Date.now() >= until) {
              if (o.asCondition) break; // 条件不成立不算错
              if (o.optional) { rec.status = 'skipped'; break; }
              throw Object.assign(new Error(`等不到元素（${o.expect}）：${o.stepId}`), { code: RPA_CODES.TIMEOUT });
            }
            await sleep(200);
          }
          if (o.asCondition) rec.matched = stateMatch(last, o.expect).ok;
          if (o.outputKey) outputs[o.outputKey] = last;
          rec.value = last;
        } else if (o.op === 'urlCondition') {
          finalUrl = String((await driver.url().catch(() => '')) || '');
          rec.matched = o.pattern ? new RegExp(o.pattern).test(finalUrl) : finalUrl.includes(o.value);
        } else if (o.op === 'assertText') {
          const r = await evalExpr(o.expr);
          if (r && r.blocked) throw Object.assign(new Error('文本在跨域 iframe 里'), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
          const text = String((r && r.text) == null ? '' : r.text);
          const expect = String(o.expect == null ? '' : o.expect);
          const ok = o.mode === 'contains' ? text.includes(expect) : text === expect;
          if (!ok && !o.optional) {
            throw Object.assign(new Error(`文本不符（期望${o.mode === 'contains' ? '包含' : '等于'}「${expect}」，实际「${text.slice(0, 80)}」）：${o.stepId}`), { code: RPA_CODES.STEP_FAILED });
          }
          rec.matched = ok;
        } else if (o.op === 'loadState') {
          const until = Date.now() + Math.max(0, o.timeoutMs || DEFAULT_TIMEOUT);
          const want = String(o.state || 'load').toLowerCase();
          for (;;) {
            const st = String((await evalExpr('document.readyState')) || '');
            if (want === 'domcontentloaded' ? (st === 'interactive' || st === 'complete') : st === 'complete') break;
            if (Date.now() >= until) throw Object.assign(new Error(`等不到页面 ${want}：${o.stepId}`), { code: RPA_CODES.TIMEOUT });
            await sleep(200);
          }
        } else if (o.op === 'press') {
          if (typeof driver.press !== 'function') {
            if (o.optional) { rec.status = 'skipped'; }
            else throw Object.assign(new Error('这个驱动不支持按键（press）'), { code: RPA_CODES.UNSUPPORTED });
          } else {
            await driver.press(o.key);
          }
        } else if (o.op === 'loop') {
          const max = Math.max(1, Number(o.maxIterations) || 20);
          for (let i = 0; i < max; i += 1) {
            const before = trace.length;
            await execOps([{ ...o.cond, asCondition: true, optional: true, stepId: `${o.stepId}:cond` }]);
            const condRec = trace[before];
            const matched = Boolean(condRec && (condRec.matched !== undefined
              ? condRec.matched
              : (condRec.value && condRec.value.found && condRec.value.visible)));
            if (!matched) break;
            if (Array.isArray(o.ops) && o.ops.length) await execOps(o.ops);
            if (i === max - 1) {
              rec.truncated = true;
              log(`[rpa] 循环到上限 ${max} 次仍未结束：${o.stepId}`);
            }
          }
        } else if (o.op === 'download') {
          const dir = await ensureDownloadDir();
          const before = listDownloads(dir);
          if (o.expr) {
            const r = await evalExpr(o.expr);
            if (r && r.blocked) throw Object.assign(new Error('下载按钮在跨域 iframe 里'), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
            if (!r || !r.found) {
              if (o.optional) { rec.status = 'skipped'; rec.reason = 'button_missing'; }
              else throw Object.assign(new Error(`点不到下载按钮：${o.stepId}`), { code: RPA_CODES.TARGET_NOT_AVAILABLE });
            }
          }
          if (rec.status !== 'skipped') {
            const until = Date.now() + Math.max(1000, o.timeoutMs || 60000);
            let got = [];
            for (;;) {
              got = distinctDownloads(before);
              if (got.length) break;
              if (Date.now() >= until) {
                if (o.optional) { rec.status = 'skipped'; rec.reason = 'download_timeout'; break; }
                throw Object.assign(new Error(`等不到下载文件：${o.stepId}`), { code: RPA_CODES.TIMEOUT });
              }
              await sleep(500);
            }
            if (got.length) {
              // 多个文件都留着：产物按「第一个」作为主键，其余进 files 供调用方处理
              const primary = got[0];
              let saved = primary.path;
              if (o.saveName) {
                try {
                  const target = path.join(dir, o.saveName);
                  fs.copyFileSync(primary.path, target);
                  saved = target;
                } catch { /* 复制失败就用原路径 */ }
              }
              rec.files = got.map((f) => ({ name: f.name, path: f.path, bytes: f.size }));
              if (o.outputKey) outputs[o.outputKey] = saved;
              rec.outputKey = o.outputKey || '';
            }
          }
        } else if (o.op === 'assert') {
          const value = await evalExpr(o.expr);
          const m = stateMatch(value, o.expect);
          if (!m.ok) throw Object.assign(new Error(o.message || '断言失败'), { code: o.code || RPA_CODES.STEP_FAILED });
        } else if (o.op === 'branch') {
          // 先算条件（条件不成立不是错误），成立再执行 then
          const before = trace.length;
          await execOps([{ ...o.cond, asCondition: true, optional: true, stepId: `${o.stepId}:cond` }]);
          const condRec = trace[before];
          const matched = Boolean(condRec && (condRec.matched !== undefined
            ? condRec.matched
            : (condRec.value && condRec.value.found && condRec.value.visible)));
          rec.matched = matched;
          if (matched && Array.isArray(o.ops) && o.ops.length) await execOps(o.ops);
          if (!matched && Array.isArray(o.elseOps) && o.elseOps.length) await execOps(o.elseOps);
        } else if (o.op === 'skip') {
          rec.status = 'skipped';
          rec.reason = o.reason || '';
          log(`[rpa] ${o.reason || '跳过一步'}（${o.stepId}）`);
        }
      } catch (err) {
        rec.status = 'failed';
        rec.code = (err && err.code) || RPA_CODES.STEP_FAILED;
        rec.error = String((err && err.message) || err);
        rec.ms = Date.now() - at;
        trace.push(rec);
        throw err;
      }
      rec.ms = Date.now() - at;
      trace.push(rec);
    }
  }

  try {
    await execOps(compiled.ops || []);
    return await finish(true, '');
  } catch (err) {
    return await finish(false, err);
  }

  async function finish(ok, err) {
    // 后处理：配方声明的能力按需执行（现在是 `pdd_decrypt`：只有真出现私有区字符才动手）
    let postprocess;
    if (ok && (compiled.postprocess || []).includes('pdd_decrypt')) {
      const codes = collectPrivateUseCodes(outputs);
      if (!codes.length) {
        postprocess = { pdd_decrypt: { action: 'skip', reason: 'no-private-use-characters' } };
      } else {
        try {
          const raw = await evalExpr(fontDecodeExpression(codes));
          const mapping = (raw && raw.mapping) || {};
          const decodedCount = Object.keys(mapping).length;
          if (!decodedCount) throw Object.assign(new Error('没能认出页面字体里的数字字形'), { code: RPA_CODES.PDD_FONT_DECRYPT_FAILED });
          const unresolved = codes.filter((c) => !mapping[String(c).replace(/^U\+/i, '')]);
          const replaced = mapOutputTexts(outputs, (text) => decodePrivateUseText(text, mapping));
          if (unresolved.length) {
            ok = false;
            err = Object.assign(
              new Error(`页面字体解码没覆盖到的码位：${unresolved.join('、')} —— 解不开的数字不会当业务数据往下传`),
              { code: RPA_CODES.PDD_FONT_DECRYPT_FAILED },
            );
          }
          postprocess = {
            pdd_decrypt: {
              action: 'decrypt',
              mapping,
              decodedCodes: decodedCount,
              totalCodes: codes.length,
              unresolved,
              referenceFamily: (raw && raw.referenceFamily) || '',
              replacedLeaves: replaced,
            },
          };
          if (unresolved.length) {
            postprocess.pdd_decrypt.action = 'decrypt-partial';
            postprocess.pdd_decrypt.remaining = unresolved;
          }
        } catch (e) {
          ok = false;
          err = e && e.code ? e : Object.assign(new Error(`页面字体解码失败：${String((e && e.message) || e)}`), { code: RPA_CODES.PDD_FONT_DECRYPT_FAILED });
          postprocess = { pdd_decrypt: { action: 'decrypt-failed', error: String((e && e.message) || e) } };
        }
      }
    }
    const artifacts = collectArtifacts({ collection: { artifacts: compiled.declaredArtifacts || [] } }, outputs);
    return {
      ok,
      code: ok ? '' : ((err && err.code) || RPA_CODES.STEP_FAILED),
      dslId: compiled.dslId || '',
      error: ok ? undefined : String((err && err.message) || err),
      stepId: ok ? undefined : ((err && err.stepId) || lastFailedStep(trace)),
      outputs,
      artifacts,
      postprocess,
      finalUrl,
      window: compiled.window,
      steps: trace,
    };
  }
}

/** 收集 outputs 里所有字符串叶子出现的私有区码位。 */
export function collectPrivateUseCodes(outputs) {
  const found = new Set();
  walkOutputTexts(outputs, (text) => { for (const c of privateUseCodes(text)) found.add(c); });
  return Array.from(found).sort();
}

function walkOutputTexts(node, visit, depth = 0) {
  if (depth > 8 || node === null || node === undefined) return;
  if (typeof node === 'string') { visit(node); return; }
  if (Array.isArray(node)) { for (const v of node) walkOutputTexts(v, visit, depth + 1); return; }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) walkOutputTexts(v, visit, depth + 1);
  }
}

/** 就地把 outputs 里所有字符串叶子过一遍（返回被改写的叶子数）。 */
export function mapOutputTexts(root, fn) {
  let count = 0;
  function visit(node, depth) {
    if (depth > 8 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const v = node[i];
        if (typeof v === 'string') {
          const next = fn(v);
          if (next !== v) { node[i] = next; count += 1; }
        } else visit(v, depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string') {
          const next = fn(v);
          if (next !== v) { node[k] = next; count += 1; }
        } else visit(v, depth + 1);
      }
    }
  }
  visit(root, 0);
  return count;
}

function lastFailedStep(trace) {
  for (let i = trace.length - 1; i >= 0; i -= 1) if (trace[i].status === 'failed') return trace[i].id;
  return '';
}

/** 按 DSL 的 artifacts 声明整理交付物清单（含下载型：值是本机文件路径）。 */
export function collectArtifacts(dsl, outputs) {
  const declared = (dsl && dsl.collection && dsl.collection.artifacts) || [];
  const out = [];
  for (const a of declared) {
    const key = String((a && (a.output_key || a.outputKey) || a && a.pointer) || '').trim();
    const kind = String(a.kind || 'json_string');
    // raw_envelope 且没给键 = 整份原始产物本身就是业务交付物
    // （页面型配方就该这样：采到的是页面里读出来的文本/JSON，不是某个字段）
    if (kind === 'raw_envelope' && !key) {
      const has = Boolean(outputs) && Object.keys(outputs).length > 0;
      out.push({ role: String(a.role || 'business'), kind, outputKey: '', present: has, bytes: has ? Buffer.byteLength(JSON.stringify(outputs), 'utf8') : 0 });
      continue;
    }
    if (!key) continue;
    const value = outputs ? outputs[key] : undefined;
    let present = value !== undefined && value !== null && String(value) !== '';
    let bytes = present ? Buffer.byteLength(String(value), 'utf8') : 0;
    let filePath = '';
    let records;
    if (present && kind === 'download_ref') {
      filePath = String(value);
      try {
        const st = fs.statSync(filePath);
        bytes = st.size;
        present = st.size > 0;
      } catch { present = false; bytes = 0; }
    }
    // text_metrics：把页面文字按配方给的标签解析成指标值（今天的值和昨天的值各一份）
    if (present && kind === 'text_metrics') {
      const parsed = parseTextMetrics(value, a);
      records = { values: parsed.values, yesterday: parsed.yesterday, missing: parsed.missing };
    }
    out.push({
      role: String(a.role || 'business'),
      kind,
      outputKey: key,
      present,
      bytes,
      ...(filePath ? { filePath } : {}),
      ...(kind === 'text_metrics' ? { domain: String(a.domain || ''), period: String(a.period || '') } : {}),
      ...(records ? { records } : {}),
    });
  }
  return out;
}

/**
 * 采集是否真拿到了业务数据：
 *   · 声明了 artifact 但值为空 → `empty_business_data`（业务确实无数据，**不重试**）
 *   · 没声明 artifact → `no_artifact_declared`（DSL 写错了，得改配方）
 */
export function artifactStatus(result) {
  const arts = (result && result.artifacts) || [];
  if (!arts.length) return { ok: false, reason: 'no_artifact_declared' };
  const present = arts.filter((a) => a.present);
  if (!present.length) return { ok: false, reason: 'empty_business_data' };
  return { ok: true, artifacts: present };
}

/** 便捷入口：编译 + 执行。 */
export async function runDsl(dslInput, driver, opts = {}) {
  const compiled = compileExecution(dslInput, opts);
  return runOps(compiled, driver, opts);
}

// ── drivers ─────────────────────────────────────────────────────────────────

/**
 * 测试用 driver：纯内存。`pages` 是 URL → `{elements: {选择器: {visible?, text?}}, text}`。
 * 靠「表达式里出现的 JSON 选择器字符串」匹配页面模型，能覆盖全部 op 语义。
 */
export function makeMockDriver({ pages = {}, calls = [], url = 'about:blank', downloadName = '', downloadBody = '' } = {}) {
  let currentUrl = url;
  let dlDir = '';
  function pageFor(u) {
    if (pages[u]) return pages[u];
    for (const key of Object.keys(pages)) {
      if (key !== '*' && u.includes(key)) return pages[key];
    }
    return pages['*'] || { elements: {} };
  }
  return {
    calls,
    async goto(u) { calls.push({ op: 'goto', url: u }); currentUrl = u; },
    async url() { return currentUrl; },
    async sleep(ms) { calls.push({ op: 'sleep', ms }); await sleep(0); },
    /** 测试用下载：点下载按钮时在指定目录里"落地"一个文件（模拟浏览器落盘）。 */
    async setDownloadDir(dir) {
      dlDir = dir;
      calls.push({ op: 'setDownloadDir', dir });
    },
    async evaluate(expression) {
      calls.push({ op: 'evaluate', expression });
      const page = pageFor(currentUrl);
      const elements = page.elements || {};
      const found = Object.keys(elements).find((sel) => expression.includes(JSON.stringify(sel).slice(1, -1)));
      const el = found ? elements[found] : null;
      if (expression.includes('return { found:') || expression.includes('window.__rpa')) {
        if (expression.includes('clicked')) {
          if (!el) return { result: { value: { found: false } } };
          calls.push({ op: 'click', selector: found });
          // 模拟浏览器下载：点了带下载语义的按钮就把文件写进下载目录
          if (downloadName && dlDir) {
            try {
              fs.mkdirSync(dlDir, { recursive: true });
              fs.writeFileSync(path.join(dlDir, downloadName), downloadBody || 'mock-download', 'utf8');
            } catch { /* ignore */ }
          }
          return { result: { value: { found: true, clicked: true } } };
        }
        if (expression.includes('String(hit.el.textContent')) {
          if (!el) return { result: { value: { found: false } } };
          return { result: { value: { found: true, text: String(el.text == null ? page.text || '' : el.text) } } };
        }
        return { result: { value: { found: Boolean(el), visible: Boolean(el && el.visible !== false) } } };
      }
      if (expression.includes('return { ok: true, value:')) {
        return { result: { value: { ok: true, value: page.expressionValue === undefined ? null : page.expressionValue } } };
      }
      return { result: { value: null } };
    },
  };
}

/** Chrome 后端 driver：复用已开的调试端口，每个 op 一次 Runtime.evaluate。 */
export function makeCdpDriver({ port } = {}) {
  if (!port) throw Object.assign(new Error('makeCdpDriver 需要 port'), { code: RPA_CODES.NO_DRIVER });
  let wsUrl = '';
  async function ensureWs() {
    if (wsUrl) return wsUrl;
    const pages = await listPages(port).catch(() => []);
    let target = Array.isArray(pages) ? pages[0] : null;
    if (!target) target = await newPage(port, 'about:blank');
    if (!target || !target.webSocketDebuggerUrl) {
      throw Object.assign(new Error('找不到可用的页面（浏览器没开或页面已关）'), { code: RPA_CODES.NO_DRIVER });
    }
    wsUrl = target.webSocketDebuggerUrl;
    return wsUrl;
  }
  return {
    async goto(url) {
      const ws = await ensureWs();
      await cdpCall(ws, 'Page.navigate', { url }, 30000, port);
      await sleep(800);
    },
    async url() {
      const ws = await ensureWs();
      const r = await evaluateOn(ws, 'location.href', 5000, port).catch(() => null);
      return (r && typeof r.value === 'string' && r.value) || '';
    },
    async evaluate(expression) {
      const ws = await ensureWs();
      const r = await evaluateOn(ws, expression, 20000, port);
      return { result: { value: JSON.parse(JSON.stringify(r && r.value !== undefined ? r.value : null)) } };
    },
    async sleep(ms) { await sleep(ms); },
    /** 真实鼠标点击（Input.dispatchMouseEvent）：有些站点的组件只认「可信」鼠标事件。 */
    async clickAt(x, y) {
      const ws = await ensureWs();
      const px = Math.round(x);
      const py = Math.round(y);
      await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', clickCount: 0 }, 5000, port);
      await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 }, 5000, port);
      await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 }, 5000, port);
    },
    /** 让浏览器把下载落到这个目录（Chrome 的 Page.setDownloadBehavior，兼容性最好）。 */
    async setDownloadDir(dir) {
      const ws = await ensureWs();
      try {
        await cdpCall(ws, 'Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }, 5000, port);
      } catch (err) {
        throw Object.assign(new Error(`浏览器不接受下载目录设置：${String((err && err.message) || err)}`), { code: RPA_CODES.UNSUPPORTED });
      }
    },
  };
}

/**
 * ego 运行时里的哑执行器源码：`async function(page, ops)`。
 * 与 runOps 语义一致（goto / sleep / url / eval / click / wait / assert / branch），
 * 但只做「发 CDP 求值 + 比较状态」，不做任何选择器构造 —— 选择器都在 Node 侧编译好了。
 */
export const EGO_EXECUTOR_SOURCE = `async function __rpaRunOps(page, ops, opts) {
  const outputs = {};
  const trace = [];
  let finalUrl = '';
  const dlRoot = (opts && opts.downloadDir) || '';
  let dlReady = false;
  const sleep = (ms) => page.waitForTimeout(Math.max(0, Number(ms) || 0)).catch(() => {});
  const evalIn = async (expr) => {
    const r = await page.cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    return r && r.result ? r.result.value : null;
  };
  async function ensureDl() {
    if (dlReady) return dlRoot;
    if (!dlRoot) throw Object.assign(new Error('没有下载目录'), { code: 'UNSUPPORTED_ACTION' });
    try { await page.cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlRoot }); }
    catch (e) { throw Object.assign(new Error('浏览器不接受下载目录设置：' + String((e && e.message) || e)), { code: 'UNSUPPORTED_ACTION' }); }
    dlReady = true;
    return dlRoot;
  }
  async function listDl(dir) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      if (/\\.(crdownload|tmp|part)$/i.test(n)) continue;
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.size > 0) out.push({ name: n, path: path.join(dir, n), size: st.size });
      } catch (e) { /* ignore */ }
    }
    return out;
  }
  const matchState = (v, expect) => {
    const want = String(expect || 'visible').toLowerCase();
    const found = Boolean(v && v.found);
    const visible = Boolean(v && v.visible);
    if (v && v.blocked) return { ok: false, blocked: true };
    if (want === 'hidden' || want === 'not-visible' || want === 'absent') return { ok: !found || !visible };
    return { ok: found && visible };
  };
  async function exec(list) {
    for (const o of list) {
      const rec = { id: o.stepId || '', op: o.op, status: 'ok' };
      try {
        if (o.op === 'goto') {
          try { await page.goto(o.url, { timeout: o.timeoutMs || 20000 }); } catch (e) { rec.navWarning = String((e && e.message) || e); }
          finalUrl = await page.url().catch(() => '') || o.url;
        } else if (o.op === 'sleep') {
          await sleep(o.ms);
        } else if (o.op === 'url') {
          finalUrl = await page.url().catch(() => '');
          if (o.outputKey) outputs[o.outputKey] = finalUrl;
        } else if (o.op === 'urlCondition') {
          finalUrl = await page.url().catch(() => '');
          rec.matched = o.pattern ? new RegExp(o.pattern).test(finalUrl) : finalUrl.includes(o.value);
        } else if (o.op === 'eval') {
          const v = await evalIn(o.expr);
          if (v && v.blocked) throw Object.assign(new Error('元素在跨域 iframe 里'), { code: 'TARGET_NOT_AVAILABLE' });
          if (o.require && v && v.found === false) throw Object.assign(new Error(o.notFoundMessage || '元素不存在'), { code: o.notFoundCode || 'TARGET_NOT_AVAILABLE' });
          if (o.outputKey) outputs[o.outputKey] = (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'text')) ? v.text : v;
        } else if (o.op === 'click') {
          const rect = o.rectExpr ? await evalIn(o.rectExpr).catch(function () { return null; }) : null;
          if (rect && rect.blocked) throw Object.assign(new Error('按钮在跨域 iframe 里'), { code: 'TARGET_NOT_AVAILABLE' });
          if (rect && rect.found && rect.visible !== false) {
            await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', clickCount: 0 });
            await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
            await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
            rec.clickedBy = 'mouse';
          } else {
            const r = await evalIn(o.expr);
            if (r && r.blocked) throw Object.assign(new Error('按钮在跨域 iframe 里'), { code: 'TARGET_NOT_AVAILABLE' });
            if (!r || !r.found) { if (!o.optional) throw Object.assign(new Error('点不到元素：' + o.stepId), { code: 'TARGET_NOT_AVAILABLE' }); rec.status = 'skipped'; }
          }
        } else if (o.op === 'wait') {
          const until = Date.now() + (o.timeoutMs || 15000);
          let last = null;
          for (;;) {
            last = await evalIn(o.expr);
            const m = matchState(last, o.expect);
            if (m.blocked) {
              // 条件判断：跨域 iframe 里的元素本引擎看不到 = 条件不成立（不能打断整条配方，v0.16.7）
              if (o.asCondition) break;
              throw Object.assign(new Error('元素在跨域 iframe 里'), { code: 'TARGET_NOT_AVAILABLE' });
            }
            if (m.ok) break;
            if (Date.now() >= until) {
              if (o.asCondition) break;
              if (o.optional) { rec.status = 'skipped'; break; }
              throw Object.assign(new Error('等不到元素：' + o.stepId), { code: 'STEP_TIMEOUT' });
            }
            await sleep(200);
          }
          if (o.asCondition) rec.matched = matchState(last, o.expect).ok;
        } else if (o.op === 'assertText') {
          const r = await evalIn(o.expr);
          if (r && r.blocked) throw Object.assign(new Error('文本在跨域 iframe 里'), { code: 'TARGET_NOT_AVAILABLE' });
          const text = String((r && r.text) == null ? '' : r.text);
          const expect = String(o.expect == null ? '' : o.expect);
          const ok = o.mode === 'contains' ? text.includes(expect) : text === expect;
          if (!ok && !o.optional) throw Object.assign(new Error('文本不符：' + o.stepId), { code: 'STEP_FAILED' });
          rec.matched = ok;
        } else if (o.op === 'loadState') {
          const until = Date.now() + (o.timeoutMs || 15000);
          const want = String(o.state || 'load').toLowerCase();
          for (;;) {
            const st = String((await evalIn('document.readyState')) || '');
            if (want === 'domcontentloaded' ? (st === 'interactive' || st === 'complete') : st === 'complete') break;
            if (Date.now() >= until) throw Object.assign(new Error('等不到页面 ' + want), { code: 'STEP_TIMEOUT' });
            await sleep(200);
          }
        } else if (o.op === 'press') {
          try {
            await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: o.key, windowsVirtualKeyCode: o.key === 'Enter' ? 13 : (o.key === 'Escape' ? 27 : 0) });
            await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: o.key });
          } catch (e) { if (!o.optional) throw Object.assign(new Error('按键失败：' + String((e && e.message) || e)), { code: 'STEP_FAILED' }); }
        } else if (o.op === 'loop') {
          const max = Math.max(1, Number(o.maxIterations) || 20);
          for (let i = 0; i < max; i += 1) {
            const probe = Object.assign({}, o.cond, { asCondition: true, optional: true });
            await exec([probe]);
            if (!probe.matched) break;
            if (Array.isArray(o.ops) && o.ops.length) await exec(o.ops);
          }
        } else if (o.op === 'download') {
          const dir = await ensureDl();
          const before = await listDl(dir);
          const seen = new Set(before.map((f) => f.path));
          if (o.expr) {
            const r = await evalIn(o.expr);
            if (r && r.blocked) throw Object.assign(new Error('下载按钮在跨域 iframe 里'), { code: 'TARGET_NOT_AVAILABLE' });
            if (!r || !r.found) {
              if (o.optional) { rec.status = 'skipped'; rec.reason = 'button_missing'; }
              else throw Object.assign(new Error('点不到下载按钮：' + o.stepId), { code: 'TARGET_NOT_AVAILABLE' });
            }
          }
          if (rec.status !== 'skipped') {
            const until = Date.now() + Math.max(1000, o.timeoutMs || 60000);
            let got = [];
            for (;;) {
              got = (await listDl(dir)).filter((f) => !seen.has(f.path));
              if (got.length) break;
              if (Date.now() >= until) {
                if (o.optional) { rec.status = 'skipped'; rec.reason = 'download_timeout'; break; }
                throw Object.assign(new Error('等不到下载文件：' + o.stepId), { code: 'STEP_TIMEOUT' });
              }
              await sleep(500);
            }
            if (got.length) {
              if (o.outputKey) outputs[o.outputKey] = got[0].path;
              rec.files = got;
            }
          }
        } else if (o.op === 'assert') {
          const assertValue = await evalIn(o.expr);
          if (!matchState(assertValue, o.expect).ok) throw Object.assign(new Error(o.message || '断言失败'), { code: o.code || 'STEP_FAILED' });
        } else if (o.op === 'branch') {
          const probe = Object.assign({}, o.cond, { asCondition: true, optional: true });
          await exec([probe]);
          const matched = Boolean(probe.matched);
          rec.matched = matched;
          if (matched && Array.isArray(o.ops) && o.ops.length) await exec(o.ops);
        }
      } catch (e) {
        rec.status = 'failed';
        rec.code = (e && e.code) || 'STEP_FAILED';
        rec.error = String((e && e.message) || e);
        trace.push(rec);
        throw e;
      }
      trace.push(rec);
    }
  }
  const __FONT_FN = ${FONT_DECODE_EXPR_FN};
  function __walkText(node, visit, depth) {
    if ((depth || 0) > 8 || node === null || node === undefined) return;
    if (typeof node === 'string') { visit(node); return; }
    if (Array.isArray(node)) { for (const v of node) __walkText(v, visit, (depth || 0) + 1); return; }
    if (typeof node === 'object') { for (const k of Object.keys(node)) __walkText(node[k], visit, (depth || 0) + 1); }
  }
  function __puaCodes(root) {
    const found = {};
    __walkText(root, (text) => {
      for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        if (cp >= 0xe000 && cp <= 0xf8ff) found['U+' + cp.toString(16).toUpperCase().padStart(4, '0')] = 1;
      }
    });
    return Object.keys(found).sort();
  }
  function __applyDecode(root, mapping) {
    let count = 0;
    const visit = (node, depth) => {
      if (depth > 8 || node === null || node === undefined) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const v = node[i];
          if (typeof v === 'string') { const next = __decodeOne(v, mapping); if (next !== v) { node[i] = next; count += 1; } }
          else visit(v, depth + 1);
        }
        return;
      }
      if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
          const v = node[k];
          if (typeof v === 'string') { const next = __decodeOne(v, mapping); if (next !== v) { node[k] = next; count += 1; } }
          else visit(v, depth + 1);
        }
      }
    };
    visit(root, 0);
    return count;
  }
  function __decodeOne(text, mapping) {
    let out = '';
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp < 0xe000 || cp > 0xf8ff) { out += ch; continue; }
      const key = cp.toString(16).toUpperCase().padStart(4, '0');
      out += (mapping[key] === undefined) ? ('[?U+' + key + ']') : String(mapping[key]);
    }
    return out;
  }
  try {
    await exec(ops);
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'STEP_FAILED', error: String((e && e.message) || e), outputs, trace, finalUrl };
  }
  let postprocess;
  const caps = (opts && Array.isArray(opts.postprocess)) ? opts.postprocess : [];
  if (caps.indexOf('pdd_decrypt') >= 0) {
    const codes = __puaCodes(outputs);
    if (!codes.length) {
      postprocess = { pdd_decrypt: { action: 'skip', reason: 'no-private-use-characters' } };
    } else {
      const r = await page.cdp('Runtime.evaluate', { expression: '(' + String(__FONT_FN) + ')(' + JSON.stringify(codes) + ', null)', returnByValue: true, awaitPromise: false });
      const raw = (r && r.result && r.result.value) || null;
      const mapping = (raw && raw.mapping) || {};
      if (!Object.keys(mapping).length) {
        return { ok: false, code: 'PDD_FONT_DECRYPT_FAILED', error: '没能认出页面字体里的数字字形', outputs, trace, finalUrl, postprocess: { pdd_decrypt: { action: 'decrypt-failed' } } };
      }
      const unresolved = codes.filter(function (c) { return !mapping[String(c).replace(/^U\+/i, '')]; });
      const replaced = __applyDecode(outputs, mapping);
      postprocess = { pdd_decrypt: { action: 'decrypt', mapping, decodedCodes: Object.keys(mapping).length, totalCodes: codes.length, unresolved: unresolved, replacedLeaves: replaced } };
      const left = unresolved;
      if (left.length) {
        return { ok: false, code: 'PDD_FONT_DECRYPT_FAILED', error: '页面字体解码没覆盖到：' + left.join('、'), outputs, trace, finalUrl, postprocess: { pdd_decrypt: { action: 'decrypt-partial', remaining: left } } };
      }
    }
  }
  return { ok: true, outputs, trace, finalUrl, postprocess };
}`;
