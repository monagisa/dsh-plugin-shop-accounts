/**
 * datastore.mjs —— 采集数据的**本地数据层**（v0.11.0）。
 *
 * 为什么要有这一层：v0.9 的采集只做到「存域配置 + 拼一段提示词」，skill 采完的数据没有落点，
 * 结果是每天从零开始 —— 不知道哪些天已采过、同一窗口反复重采、重复数据反复进、下次分析还得重采一遍。
 * Accio 的做法是把采集做成一条**带契约的管线**（plan → collect → import → coverage 台账 → query），
 * 这里实现它的轻量本地版：
 *
 *   plan   ：给定账号 + 采集域 + 日期区间，返回"缺哪些天"（COLLECTION_REQUIRED / NO_COLLECTION_REQUIRED）
 *   import ：把 skill/agent 采到的记录写进来 —— 逐条校验 → content_hash 去重 → 追加落盘 → 记覆盖台账
 *   query  ：按账号/域/日期/指标把数据取出来（给后续分析用，不用重采）
 *
 * 存储（都在 `<数据目录>/collection/<账号id>/` 下，一个账号一套，互不影响）：
 *   coverage.json  —— 覆盖台账：每个域若干段 `{start,end}`（相邻/重叠自动合并）
 *   records.jsonl  —— 追加写的业务记录，一行一条 JSON（不重写整个文件，坏了也只坏一行）
 *   imports.json   —— 最近 100 次导入的批次日志（谁、什么时候、导入多少、跳过多少）
 *
 * 为什么用 JSONL 而不是 SQLite：宿主的 Node/Electron 运行时不一定带 `node:sqlite`
 * （22.x 还要 `--experimental-sqlite`），而插件必须零依赖、跨平台可用。数据量在这个场景
 * （每店每天几十~几百条）下 JSONL + 内存哈希索引完全够，且坏一行不影响其它行。
 *
 * 两个关键不变量（照抄 Accio 的语义）：
 *   1. **合法空结果也记台账**：采了但那天确实没数据，也要把覆盖区间记下来，否则每天都会重采；
 *   2. **导入是幂等的**：content_hash 相同就跳过，重复导入不会翻倍。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { dataDir, ensureDir, atomicWriteJson, validAccountId } from './store.mjs';
import {
  CATALOG_EXTRA_DOMAINS, COLLECTION_DOMAINS, COLLECTION_LABELS, collectDomainId, collectionRangeText,
} from './collection.mjs';

/** 单次请求的最大日期窗口（与 Accio 的 366 天上限一致）。 */
export const MAX_WINDOW_DAYS = 366;

/** 域是否合法：默认 5 域，加上目录层（v0.12.0）按平台开放的额外域（目前只有「竞争洞察」）。 */
function isKnownDomain(d) {
  return COLLECTION_DOMAINS.includes(d) || CATALOG_EXTRA_DOMAINS.includes(d);
}

/** 域白名单提示文案。 */
const DOMAIN_HINT = [...COLLECTION_DOMAINS, ...CATALOG_EXTRA_DOMAINS].join(' / ');
/** 单次导入的最大记录数：一次导入一个域的一个区间，5000 条已经很宽松。 */
export const MAX_IMPORT_ITEMS = 5000;
/** 导入批次日志保留条数。 */
const MAX_IMPORT_LOG = 100;
/** extra 字段的 JSON 字节上限（别让外部输入把文件撑爆）。 */
const MAX_EXTRA_BYTES = 2048;

// ── 路径 ────────────────────────────────────────────────────────────────────

function requireAccountId(accountId) {
  const id = String(accountId || '').trim();
  // 账号 id 是路径的一段，必须是插件自己生成的形状（挡掉 `..`、`/` 之类）
  if (!validAccountId(id)) throw new Error('账号 id 不合法：' + (id || '(空)'));
  return id;
}

export function collectionStoreDir(accountId) {
  return path.join(dataDir(), 'collection', requireAccountId(accountId));
}
export function coveragePath(accountId) { return path.join(collectionStoreDir(accountId), 'coverage.json'); }
export function recordsPath(accountId) { return path.join(collectionStoreDir(accountId), 'records.jsonl'); }
export function importsPath(accountId) { return path.join(collectionStoreDir(accountId), 'imports.json'); }

/** 删账号时连带删掉它的采集数据（否则重建同 id 的账号会"凭空有历史数据"）。 */
export function removeCollectionStore(accountId) {
  const dir = collectionStoreDir(accountId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉不影响主流程 */ }
}

// ── 日期（一律按 UTC 零点算，避开本地时区/夏令时把天数算错）───────────────────

const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => (n < 10 ? '0' + n : String(n));

export function parseDay(value) {
  const s = String(value == null ? '' : value).trim();
  if (!DAY_RE.test(s)) throw new Error(`日期必须是 YYYY-MM-DD：${s || '(空)'}`);
  const [y, m, d] = s.split('-').map((x) => Number(x));
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error('日期不存在：' + s);
  }
  return ms;
}

export function fmtDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 含头含尾的天数。 */
export function daySpan(startMs, endMs) {
  return Math.round((endMs - startMs) / DAY_MS) + 1;
}

/** 校验一个请求区间（含头含尾、窗口上限）。 */
function normalizeWindow(start, end) {
  const s = parseDay(start);
  const e = parseDay(end);
  if (s > e) throw new Error(`开始日期不能晚于结束日期：${fmtDay(s)} > ${fmtDay(e)}`);
  const days = daySpan(s, e);
  if (days > MAX_WINDOW_DAYS) throw new Error(`一次最多查/采 ${MAX_WINDOW_DAYS} 天，这次要 ${days} 天`);
  return { start: s, end: e, days };
}

// ── 小工具：读 JSON（坏文件退默认，不抛）────────────────────────────────────

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

// ── 覆盖台账 ────────────────────────────────────────────────────────────────

/** 把若干 `{start,end}`（天字符串）合并成不重叠、相邻相接的区间。 */
export function mergeRanges(ranges) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .map((r) => {
      try { return { s: parseDay(r.start), e: parseDay(r.end) }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e + DAY_MS) {
      if (r.e > last.e) last.e = r.e;
    } else {
      out.push({ s: r.s, e: r.e });
    }
  }
  return out.map((r) => ({ start: fmtDay(r.s), end: fmtDay(r.e) }));
}

export function readCoverage(accountId) {
  const data = readJsonFile(coveragePath(accountId), { version: 1, domains: {} });
  const domains = data && typeof data.domains === 'object' && data.domains ? data.domains : {};
  const clean = {};
  for (const [domain, ranges] of Object.entries(domains)) {
    if (!isKnownDomain(domain)) continue; // 白名单外的旧数据不认
    clean[domain] = mergeRanges(ranges);
  }
  return { version: 1, updatedAt: data.updatedAt || null, domains: clean, error: data.__error || null };
}

/** 记一段覆盖（相邻/重叠自动合并后落盘）。 */
export function recordCoverage(accountId, { domain, start, end, by = 'agent', importId = '' } = {}) {
  if (!isKnownDomain(domain)) throw new Error(`未知采集域：${domain}`);
  const win = normalizeWindow(start, end);
  const cov = readCoverage(accountId);
  const at = new Date().toISOString();
  cov.domains[domain] = mergeRanges([
    ...(cov.domains[domain] || []),
    { start: fmtDay(win.start), end: fmtDay(win.end), at, by, importId },
  ]);
  atomicWriteJson(coveragePath(accountId), {
    version: 1,
    updatedAt: at,
    domains: cov.domains,
  });
  return cov.domains[domain];
}

/**
 * 请求区间里**没被覆盖**的连续区间。
 * 按天判断（窗口 ≤366 天，足够快），再把连续缺失的天合成区间 —— 这样调用方拿到的是
 * "10-03 ~ 10-05、10-09" 这种可直接去采的清单，而不是 30 个零散日期。
 */
export function coverageGaps(accountId, domain, start, end) {
  if (!isKnownDomain(domain)) throw new Error(`未知采集域：${domain}`);
  const win = normalizeWindow(start, end);
  const ranges = readCoverage(accountId).domains[domain] || [];
  const covered = ranges.map((r) => ({ s: parseDay(r.start), e: parseDay(r.end) }));
  const gaps = [];
  let runStart = null;
  for (let t = win.start; t <= win.end; t += DAY_MS) {
    const hit = covered.some((r) => t >= r.s && t <= r.e);
    if (!hit && runStart === null) runStart = t;
    if (hit && runStart !== null) {
      gaps.push({ start: fmtDay(runStart), end: fmtDay(t - DAY_MS) });
      runStart = null;
    }
  }
  if (runStart !== null) gaps.push({ start: fmtDay(runStart), end: fmtDay(win.end) });
  return gaps;
}

// ── 记录文件（JSONL）────────────────────────────────────────────────────────

/**
 * content_hash 索引：按文件 (size, mtime) 缓存，文件没变就不重扫。
 * 导入时用它判重；追加后把缓存 key 一并更新，避免下次全量重扫。
 */
const hashIndexCache = new Map(); // accountId → { key, set, count }

function fileKey(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

function loadHashIndex(accountId) {
  const file = recordsPath(accountId);
  const key = fileKey(file);
  const hit = hashIndexCache.get(accountId);
  if (hit && hit.key === key) return hit;
  const set = new Set();
  let count = 0;
  if (key !== 'missing') {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = ''; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      count += 1;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.hash === 'string') set.add(rec.hash);
      } catch { /* 坏行跳过：JSONL 的好处就是坏一行不连坐 */ }
    }
  }
  const entry = { key, set, count };
  hashIndexCache.set(accountId, entry);
  return entry;
}

function appendRecords(accountId, lines) {
  const file = recordsPath(accountId);
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
  // 写完让索引缓存失效即可：下次 loadHashIndex 会按新的 (size, mtime) 重扫。
  // 注意**不能**在这里 loadHashIndex 之后再 `count += lines.length` —— 重扫出来的 count
  // 已经把新行算进去了，再加一次就会翻倍（v0.11.0 自检抓到过）。
  hashIndexCache.delete(accountId);
}

/** 读全部记录（坏行跳过）。量不大，查询/统计都直接扫一遍。 */
export function readRecords(accountId) {
  const file = recordsPath(accountId);
  const out = [];
  if (!fs.existsSync(file)) return out;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

// ── 记录校验（外部输入，一律当成不可信）────────────────────────────────────

function normalizeText(value, field, max) {
  const s = String(value == null ? '' : value).normalize('NFC').trim();
  if (!s) throw new Error(`${field} 不能为空`);
  if (s.length > max) throw new Error(`${field} 太长（最多 ${max} 个字符）`);
  // 控制字符（含换行/制表）在指标名里没有任何意义，只会污染文件
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`${field} 含控制字符`);
  return s;
}

function normalizeNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} 必须是有限数字`);
  if (Math.abs(value) > 1e15) throw new Error(`${field} 数值超出范围（±1e15）`);
  return value;
}

function normalizeExtra(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('extra 必须是对象');
  let text = '';
  try { text = JSON.stringify(value); } catch { throw new Error('extra 不能序列化'); }
  if (Buffer.byteLength(text, 'utf8') > MAX_EXTRA_BYTES) throw new Error(`extra 太大（最多 ${MAX_EXTRA_BYTES} 字节）`);
  return value;
}

function hashRecord(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 归一化一条记录：
 *   要么 `{metric, value}`（单指标），要么 `{values:{指标:数值, …}}`（一行多指标，像报表的一行）。
 * 两种都要求 `bizDate`（业务日期）与可选 `productId`（商品维度）。
 */
function normalizeRecord(item, ctx) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('记录必须是对象');
  const bizDate = fmtDay(parseDay(item.bizDate === undefined ? item.date : item.bizDate));

  let metric = '';
  let value = null;
  let values = null;
  const hasValues = item.values !== undefined && item.values !== null;
  if (hasValues) {
    if (typeof item.values !== 'object' || Array.isArray(item.values)) throw new Error('values 必须是对象');
    const entries = Object.entries(item.values);
    if (!entries.length) throw new Error('values 不能是空对象');
    if (entries.length > 200) throw new Error('values 里的指标太多（最多 200 个）');
    values = {};
    for (const [k, v] of entries) {
      const key = normalizeText(k, 'values 的指标名', 128);
      values[key] = normalizeNumber(v, `values["${key}"]`);
    }
    if (item.metric !== undefined && String(item.metric || '').trim()) {
      throw new Error('metric 与 values 只能二选一');
    }
  } else {
    metric = normalizeText(item.metric, 'metric', 128);
    value = normalizeNumber(item.value, 'value');
  }

  const productId = item.productId === undefined || item.productId === null || String(item.productId).trim() === ''
    ? ''
    : normalizeText(item.productId, 'productId', 64);
  // v0.12.0 目录层：记录可以带 catalog 里的 metric_id（`tb_ads_人群_展现量` 这种）。
  // 是否属于该平台由调用方用 catalog 校验；这里只保证形状合法并参与去重哈希。
  const metricId = item.metricId === undefined || item.metricId === null || String(item.metricId).trim() === ''
    ? ''
    : normalizeText(item.metricId, 'metricId', 128);
  const period = item.period === undefined || item.period === null || String(item.period).trim() === ''
    ? ctx.period
    : normalizeText(item.period, 'period', 8);
  if (!['h', 'd', 'w', 'm', 'y'].includes(period)) throw new Error(`period 只能是 h/d/w/m/y：${period}`);
  const extra = normalizeExtra(item.extra);

  const metricsPart = values ? { values } : { metric, value };
  const hash = hashRecord([
    ctx.platform || '', ctx.domain, productId, bizDate, period, metricId,
    values ? Object.keys(values).sort() : metric,
    values ? Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v) : value,
  ]);

  return {
    accountId: ctx.accountId,
    platform: ctx.platform || '',
    domain: ctx.domain,
    metric,
    value,
    values,
    metricId,
    bizDate,
    period,
    productId,
    extra,
    hash,
    importedAt: ctx.now,
    batchId: ctx.batchId,
  };
}

// ── 导入批次日志 ────────────────────────────────────────────────────────────

export function readImports(accountId) {
  const data = readJsonFile(importsPath(accountId), { version: 1, batches: [] });
  const batches = Array.isArray(data.batches) ? data.batches : [];
  return { version: 1, batches, error: data.__error || null };
}

function appendImportLog(accountId, batch) {
  const cur = readImports(accountId);
  const batches = [batch, ...cur.batches].slice(0, MAX_IMPORT_LOG);
  atomicWriteJson(importsPath(accountId), { version: 1, updatedAt: new Date().toISOString(), batches });
}

// ── 对外：plan ──────────────────────────────────────────────────────────────

/**
 * 采集计划：请求区间里每个域缺哪些天。
 * @returns {{status:'COLLECTION_REQUIRED'|'NO_COLLECTION_REQUIRED', requested:object, awaitCollect:Array}}
 */
export function planCollection({ accountId, platform = '', domains, start, end } = {}) {
  const id = requireAccountId(accountId);
  const win = normalizeWindow(start, end);
  let list = Array.isArray(domains) && domains.length ? domains.map((d) => String(d || '').trim()) : COLLECTION_DOMAINS.slice();
  list = [...new Set(list)];
  const bad = list.filter((d) => !isKnownDomain(d));
  if (bad.length) throw new Error(`未知采集域：${bad.join('、')}`);

  const targets = [];
  for (const domain of list) {
    const missing = coverageGaps(id, domain, fmtDay(win.start), fmtDay(win.end));
    if (!missing.length) continue;
    const missingDays = missing.reduce((n, r) => n + daySpan(parseDay(r.start), parseDay(r.end)), 0);
    targets.push({
      domain,
      label: COLLECTION_LABELS[domain] || domain,
      // 与 Accio 的 domain_id 同形（`<platform>-scheduler-<域>`），便于同一个 skill 两处通用
      domainId: collectDomainId(platform, domain),
      missing,
      missingDays,
    });
  }
  return {
    status: targets.length ? 'COLLECTION_REQUIRED' : 'NO_COLLECTION_REQUIRED',
    requested: { start: fmtDay(win.start), end: fmtDay(win.end), days: win.days, domains: list },
    awaitCollect: targets,
  };
}

// ── 对外：import ────────────────────────────────────────────────────────────

/**
 * 导入采集结果。
 * @param {object} opts
 * @param {string} opts.accountId
 * @param {string} opts.platform
 * @param {string} opts.domain       采集域（白名单内）
 * @param {Array}  opts.items        记录数组；**允许为空**（合法空结果 == 那天确实没数据）
 * @param {string} [opts.coverageStart] 本次已采范围（含头），与 coverageEnd 成对
 * @param {string} [opts.coverageEnd]
 * @param {string} [opts.period]     h/d/w/m/y，默认 d
 * @param {string} [opts.by]         谁采的（agent / skill 名）
 * @param {string} [opts.note]
 */
export function importRecords({
  accountId, platform = '', domain, items, coverageStart, coverageEnd,
  period = 'd', by = 'agent', note = '',
} = {}) {
  const id = requireAccountId(accountId);
  if (!isKnownDomain(domain)) throw new Error(`未知采集域：${domain || '(空)'}（可选：${DOMAIN_HINT}）`);
  if (!Array.isArray(items)) throw new Error('items 必须是数组（没有数据就传空数组 + 覆盖区间）');
  if (items.length > MAX_IMPORT_ITEMS) throw new Error(`一次最多导入 ${MAX_IMPORT_ITEMS} 条，这次 ${items.length} 条`);

  let win = null;
  if (coverageStart !== undefined || coverageEnd !== undefined) {
    if (!coverageStart || !coverageEnd) throw new Error('coverageStart 与 coverageEnd 必须成对给出');
    win = normalizeWindow(coverageStart, coverageEnd);
  }
  // 空结果必须带覆盖区间：否则"什么都没写"和"确实没数据"无法区分，台账就永远推不动
  if (!items.length && !win) {
    throw new Error('空导入必须给出覆盖区间（coverageStart/coverageEnd）：只记台账、不写记录 —— 否则下次还会重采同一段');
  }

  const now = new Date().toISOString();
  const batchId = `imp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const index = loadHashIndex(id);
  const ctx = { accountId: id, platform: String(platform || ''), domain, period, now, batchId };

  const lines = [];
  const rejected = [];
  let duplicates = 0;
  for (let i = 0; i < items.length; i += 1) {
    let rec;
    try {
      rec = normalizeRecord(items[i], ctx);
    } catch (err) {
      rejected.push({ index: i, reason: String((err && err.message) || err) });
      continue;
    }
    if (index.set.has(rec.hash)) { duplicates += 1; continue; }
    index.set.add(rec.hash);
    lines.push(JSON.stringify(rec));
  }

  if (lines.length) appendRecords(id, lines);
  const coverageRanges = win ? recordCoverage(id, {
    domain, start: fmtDay(win.start), end: fmtDay(win.end), by, importId: batchId,
  }) : null;

  // 全被拒、又没有覆盖区间：什么都别记，直接报错（别让调用方以为自己采成功了）
  if (!lines.length && !win && rejected.length) {
    return {
      ok: false,
      error: `所有记录都没通过校验（${rejected.length} 条），也没有给出覆盖区间`,
      imported: 0, duplicates, rejected, coverageRecorded: false, batchId,
    };
  }

  const batch = {
    id: batchId,
    at: now,
    domain,
    imported: lines.length,
    duplicates,
    rejected: rejected.length,
    coverage: win ? { start: fmtDay(win.start), end: fmtDay(win.end) } : null,
    by: String(by || 'agent').slice(0, 80),
    note: String(note || '').slice(0, 300),
  };
  appendImportLog(id, batch);
  return {
    ok: true,
    batchId,
    imported: lines.length,
    duplicates,
    rejected,
    coverageRecorded: Boolean(win),
    coverage: coverageRanges,
  };
}

// ── 对外：query ─────────────────────────────────────────────────────────────

/**
 * 查已采集的数据。不带 start/end 就查全部（但受 limit 限制）。
 * 过滤：domain / metric（单指标记录匹配 metric，多指标记录匹配 values 里的键）/ 日期窗。
 */
export function queryRecords({ accountId, domain, metric, metricId, start, end, limit = 500 } = {}) {
  const id = requireAccountId(accountId);
  const maxLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 500, 1), 5000);
  if (domain !== undefined && domain !== null && domain !== '' && !isKnownDomain(domain)) {
    throw new Error(`未知采集域：${domain}`);
  }
  let win = null;
  if (start || end) {
    if (!start || !end) throw new Error('start 与 end 必须成对给出');
    win = normalizeWindow(start, end);
  }
  const metricKey = metric === undefined || metric === null || String(metric).trim() === '' ? '' : String(metric).trim();
  const metricIdKey = metricId === undefined || metricId === null || String(metricId).trim() === '' ? '' : String(metricId).trim();

  const all = readRecords(id);
  const filtered = [];
  for (const rec of all) {
    if (domain && rec.domain !== domain) continue;
    if (metricIdKey && rec.metricId !== metricIdKey) continue;
    if (win) {
      let t;
      try { t = parseDay(rec.bizDate); } catch { continue; }
      if (t < win.start || t > win.end) continue;
    }
    if (metricKey) {
      const hit = rec.metric === metricKey
        || (rec.values && Object.prototype.hasOwnProperty.call(rec.values, metricKey));
      if (!hit) continue;
    }
    filtered.push(rec);
  }
  filtered.sort((a, b) => (a.bizDate === b.bizDate
    ? String(a.metric || '').localeCompare(String(b.metric || ''))
    : (a.bizDate < b.bizDate ? -1 : 1)));

  // 按指标给个概要：调用方（agent）常常只需要知道"有哪些指标、各多少天"
  const byMetric = {};
  for (const rec of filtered) {
    const keys = rec.values ? Object.keys(rec.values) : [rec.metric];
    for (const k of keys) {
      const m = byMetric[k] || (byMetric[k] = { metric: k, count: 0, first: rec.bizDate, last: rec.bizDate });
      m.count += 1;
      if (rec.bizDate < m.first) m.first = rec.bizDate;
      if (rec.bizDate > m.last) m.last = rec.bizDate;
    }
  }

  const rows = filtered.slice(0, maxLimit).map((rec) => ({
    domain: rec.domain,
    metric: rec.metric || '',
    metricId: rec.metricId || '',
    value: rec.value === undefined ? null : rec.value,
    values: rec.values || null,
    bizDate: rec.bizDate,
    period: rec.period,
    productId: rec.productId || '',
    extra: rec.extra || null,
    importedAt: rec.importedAt,
  }));
  return {
    count: filtered.length,
    returned: rows.length,
    truncated: filtered.length > rows.length,
    metrics: Object.values(byMetric).sort((a, b) => b.count - a.count),
    rows,
  };
}

// ── 对外：给界面/state 用的概要 ──────────────────────────────────────────────

/**
 * 某账号的采集概览：最近 30 天的窗口里，每个域覆盖了几天、缺几天、有多少条记录。
 * 给 /state 和界面用，**不做任何采集**，只读本地文件。
 */
export function collectionSummary(account, now = new Date()) {
  const a = account || {};
  const cfg = a.collection || {};
  const domains = Array.isArray(cfg.domains) && cfg.domains.length ? cfg.domains : [];
  const range = collectionRangeText(now);
  const id = String(a.id || '');
  const out = { window: { start: range.start, end: range.end, days: range.days }, domains: [], records: 0, lastImportAt: null, available: false };
  if (!validAccountId(id)) return out;

  let storeExists = true;
  try { storeExists = fs.existsSync(collectionStoreDir(id)); } catch { storeExists = false; }
  out.available = storeExists;
  if (!storeExists) return out;

  for (const domain of domains) {
    if (!isKnownDomain(domain)) continue;
    let gaps = [];
    try { gaps = coverageGaps(id, domain, range.start, range.end); } catch { gaps = []; }
    const missingDays = gaps.reduce((n, r) => n + daySpan(parseDay(r.start), parseDay(r.end)), 0);
    out.domains.push({
      domain,
      label: COLLECTION_LABELS[domain] || domain,
      coveredDays: Math.max(0, range.days - missingDays),
      missingDays,
      missing: gaps.slice(0, 5),
      ranges: (readCoverage(id).domains[domain] || []).slice(-5),
    });
  }
  const index = loadHashIndex(id);
  out.records = index.count;
  const imports = readImports(id).batches;
  out.lastImportAt = imports.length ? imports[0].at : null;
  out.lastImport = imports.length ? imports[0] : null;
  return out;
}
