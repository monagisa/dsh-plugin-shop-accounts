// 数据看板：把「已经采集到的工作簿」聚合成看板卡片。
//
// 设计原则：
// 1. 不重新采集 —— 只看本地已有产物（每个店铺最近若干作业的成品工作簿）。
// 2. 每个指标独立找来源：同一份工作簿里挑「维度列最少」且表头命中该指标的表，
//    这样能避开「载体构成」「终端构成」这类带维度的明细表（它们会把数据重复多算）。
// 3. 口径拿不准就不显示数字：卡片状态是「数据不完整」而不是 0，和上游产品的占位态一致。
// 4. 多店铺合并：金额/人数类直接相加；客单价、转化率按分子分母重算，不平均。

import fs from 'node:fs';
import path from 'node:path';
import { readTableFile } from './sheet-read.mjs';
import { collectionDirOf } from './collection-dir.mjs';
import { fmtDay, parseDay } from './datastore.mjs';

const JOB_PREFIX = 'job_';

// 维度列：这些列的值不是「全部/不限/整体」时，那一行是明细行，不能进店铺级汇总。
const DIM_COLUMNS = ['载体类型', '投放时段', '终端类型', '售卖类型', '自营/合作', '账号/渠道', '抖音号'];
const DIM_TOTAL = {
  '载体类型': ['全部', '不限'],
  '投放时段': ['不限', '全部'],
  '终端类型': ['整体', '全部'],
  '售卖类型': ['全部', '整体'],
  '自营/合作': ['自营', '全部', '整体'],
};
// 商品/场景/人群维度：一旦出现，整张表是明细，不能用来算店铺级指标。
const DETAIL_COLUMNS = ['商品ID', '商品名称', '场景ID', '场景名字', '人群名称', '来源名称', '来源层级'];

const METRICS = [
  {
    key: 'gmv', label: '成交金额', unit: 'money', kind: 'sum',
    aliases: ['成交金额', '支付金额', '用户支付金额', '支付金额(元)'],
  },
  {
    key: 'refund', label: '退款金额', unit: 'money', kind: 'sum',
    aliases: ['成功退款金额', '退款金额', '退款金额（支付时间）', '成交退款金额（支付时间）', '退款金额(元)'],
  },
  {
    key: 'adCost', label: '推广花费', unit: 'money', kind: 'sum',
    aliases: ['推广花费', '全站推广花费', '总营销花费', '营销花费', '花费', '花费(元)'],
  },
  {
    // 销售收入 = 成交金额 - 退款金额（平台报表没有统一的“销售收入”列，按口径推导）
    key: 'income', label: '销售收入', unit: 'money', kind: 'derived', of: ['gmv', 'refund'],
    aliases: ['销售收入', '净成交金额', '结算金额', '净交易额', '净支付金额'],
  },
  {
    key: 'aov', label: '客单价', unit: 'money', kind: 'ratio', num: 'gmv', den: 'buyers',
    aliases: ['客单价', '客单价(按买家)', '客单价（按买家）', '客单价(按支付买家)'],
  },
  {
    key: 'visitors', label: '访客数', unit: 'count', kind: 'sum',
    aliases: ['访客数', '店铺访客数', '商品访客数', 'uv'],
  },
  {
    key: 'buyers', label: '支付买家数', unit: 'count', kind: 'sum',
    aliases: ['支付买家数', '成交买家数', '成交人数', '支付人数'],
  },
  {
    key: 'convRate', label: '成交转化率', unit: 'percent', kind: 'ratio', num: 'buyers', den: 'visitors',
    aliases: ['成交转化率', '支付转化率', '成交转化率（%）'],
  },
];

const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

// 日期列在不同平台/报表里叫法不同（淘宝是「统计日期」）。
const DATE_ALIASES = ['日期', '统计日期', '日期(天)', '日期（天）', '日期(日)'];

function dateColumnOf(header) {
  for (const alias of DATE_ALIASES) {
    const i = headerIndex(header, alias);
    if (i >= 0) return i;
  }
  return -1;
}

function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s || s === '-' || s === '--' || s === 'NULL' || s === 'null') return null;
  s = s.replace(/,/g, '').replace(/¥/g, '').replace(/元/g, '').trim();
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 日期列常见三种写法：2026-11-24 / 20261124 / 2026/11/24。
export function normalizeBizDate(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function headerIndex(header, column) {
  const want = String(column).trim();
  for (let i = 0; i < header.length; i += 1) if (String(header[i] === null || header[i] === undefined ? '' : header[i]).trim() === want) return i;
  return -1;
}

function metricIndex(header) {
  const idx = new Map();
  for (const metric of METRICS) {
    for (const alias of metric.aliases) {
      const i = headerIndex(header, alias);
      if (i >= 0) { idx.set(metric.key, i); break; }
    }
  }
  return idx;
}

function dimColumnsOf(header) {
  return DIM_COLUMNS.filter((c) => headerIndex(header, c) >= 0);
}

function rowIsStoreLevel(row, header, dims) {
  for (const col of dims) {
    const value = String(row[headerIndex(header, col)] === null || row[headerIndex(header, col)] === undefined ? '' : row[headerIndex(header, col)]).trim();
    const allowed = DIM_TOTAL[col];
    if (!allowed) return false;
    if (!allowed.includes(value)) return false;
  }
  return true;
}

function sheetUsable(header) {
  if (!header || header.length < 2) return false;
  if (dateColumnOf(header) < 0) return false;
  if (DETAIL_COLUMNS.some((c) => headerIndex(header, c) >= 0)) return false;
  return true;
}

function readWorkbook(pathname) {
  try {
    return readTableFile(pathname);
  } catch {
    return null;
  }
}

function candidateWorkbooks(account) {
  let dir = '';
  try {
    dir = path.join(collectionDirOf(account), 'jobs');
  } catch {
    return [];
  }
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((n) => n.startsWith(JOB_PREFIX)).sort().reverse();
  const books = [];
  for (const name of names.slice(0, 6)) {
    const artDir = path.join(dir, name, 'artifacts');
    if (!fs.existsSync(artDir)) continue;
    for (const file of fs.readdirSync(artDir)) {
      if (!file.endsWith('.xlsx') || file.startsWith('~')) continue;
      if (!file.startsWith('采集数据')) continue;
      books.push({ jobId: name, filePath: path.join(artDir, file), mtime: fs.statSync(path.join(artDir, file)).mtimeMs });
    }
  }
  return books;
}

// 返回 { days: Map<'YYYY-MM-DD', {metric: value}>, notes: string[] }
export function storeSeries(account) {
  const days = new Map();
  const notes = [];
  const books = candidateWorkbooks(account);
  if (!books.length) notes.push('还没有成品工作簿');
  const used = new Map(); // metric -> source sheet name
  for (const book of books) {
    const table = readWorkbook(book.filePath);
    if (!table || !table.sheets) continue;
    for (const sheet of table.sheets) {
      if (sheet.name === '采集情况') continue;
      const rows = sheet.rows || [];
      if (rows.length < 2) continue;
      const header = rows[0] || [];
      if (!sheetUsable(header)) continue;
      const idx = metricIndex(header);
      if (!idx.size) continue;
      const dateCol = dateColumnOf(header);
      const dims = dimColumnsOf(header);
      for (let r = 1; r < rows.length; r += 1) {
        const row = rows[r] || [];
        if (!rowIsStoreLevel(row, header, dims)) continue;
        const date = normalizeBizDate(row[dateCol]);
        if (!date) continue;
        let cell = days.get(date);
        if (!cell) { cell = {}; days.set(date, cell); }
        for (const [key, col] of idx.entries()) {
          if (cell[key] !== undefined) continue; // 先到先得：排在前面的工作簿/表优先
          const n = toNumber(row[col]);
          if (n === null) continue;
          cell[key] = n;
          if (!used.has(key)) used.set(key, sheet.name);
        }
      }
    }
    if (days.size) break; // 一本工作簿覆盖五域，后面的更旧，不再重复读
  }
  if (days.size && used.size) notes.push('数据来源：' + Array.from(new Set(Array.from(used.values()))).join('、'));
  return { days, notes, metrics: Array.from(used.keys()) };
}

function dayList(from, to) {
  const out = [];
  const end = parseDay(to);
  for (let ms = parseDay(from); ms <= end; ms += 86400000) out.push(fmtDay(ms));
  return out;
}

function shiftRange(from, to) {
  const startMs = parseDay(from);
  const endMs = parseDay(to);
  const span = Math.round((endMs - startMs) / 86400000) + 1;
  const prevEndMs = startMs - 86400000;
  const prevStartMs = prevEndMs - (span - 1) * 86400000;
  return { start: fmtDay(prevStartMs), end: fmtDay(prevEndMs) };
}

function sumMetric(days, dates, key) {
  let total = null;
  let count = 0;
  for (const date of dates) {
    const cell = days.get(date);
    if (!cell) continue;
    const v = cell[key];
    if (v === undefined || v === null || !Number.isFinite(Number(v))) continue;
    total = (total === null ? 0 : total) + Number(v);
    count += 1;
  }
  return count ? { total, count } : null;
}

// 多店铺合并：金额/计数直接相加，比率按分子分母重算。
function aggregate(daysList, dates, metric, mode) {
  if (metric.kind === 'sum') {
    let total = 0;
    let has = false;
    for (const days of daysList) {
      const r = sumMetric(days, dates, metric.key);
      if (r) { total += r.total; has = true; }
    }
    return has ? { value: total } : null;
  }
  if (metric.kind === 'derived') {
    const parts = (metric.of || []).map((k) => aggregate(daysList, dates, METRIC_BY_KEY.get(k), 'sum'));
    const base = parts[0];
    if (!base) return null;
    let value = base.value;
    for (let i = 1; i < parts.length; i += 1) if (parts[i]) value -= parts[i].value;
    return { value };
  }
  // 比率一律用分子/分母重算（单店、多店口径一致）
  const num = aggregate(daysList, dates, METRIC_BY_KEY.get(metric.num || 'gmv'), 'sum');
  const den = aggregate(daysList, dates, METRIC_BY_KEY.get(metric.den || 'buyers'), 'sum');
  if (!num || !den || !den.value) return null;
  return { value: num.value / den.value };
}

function seriesOf(days, metric, dates) {
  const out = [];
  for (const date of dates) {
    const cell = days.get(date);
    if (!cell) { out.push(null); continue; }
    if (metric.kind === 'ratio') {
      const n = cell[metric.num || 'gmv'];
      const d = cell[metric.den || 'buyers'];
      out.push(Number.isFinite(n) && Number.isFinite(d) && d ? n / d : null);
      continue;
    }
    const v = cell[metric.key];
    out.push(v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
  }
  return out;
}

function fmtValue(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  if (unit === 'money') return '¥' + value.toFixed(2);
  // 比率内部统一是小数（0.0293），展示成百分数。
  if (unit === 'percent') return (value * 100).toFixed(2) + '%';
  return String(Math.round(value));
}

function fmtDelta(value, prev) {
  if (value === null || prev === null || prev === undefined || !Number.isFinite(prev) || prev === 0) return '';
  const pct = ((value - prev) / Math.abs(prev)) * 100;
  const sign = pct > 0 ? '+' : '';
  return '较上期 ' + sign + pct.toFixed(1) + '%';
}

/**
 * 生成看板数据。
 * @param {{ accounts: any[], store?: string, days?: number, from?: string, to?: string, now?: Date }} opts
 */
export function buildDashboard(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const wanted = Array.isArray(opts.accounts) ? opts.accounts : [];
  const sellers = wanted.filter((a) => a && a.accountType !== 'buyer' && a.platform);
  const store = String(opts.store || 'all');
  const picked = store && store !== 'all' ? sellers.filter((a) => a.id === store) : sellers;
  const span = Math.max(1, Math.min(365, Number(opts.days) > 0 ? Math.floor(Number(opts.days)) : 7));
  let to = String(opts.to || '');
  let from = String(opts.from || '');
  if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    // 默认截止到「昨天」：当天的数据平台一般还没出全。
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    to = fmtDay(d.getTime());
  }
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || parseDay(from) > parseDay(to)) {
    const endMs = parseDay(to);
    from = fmtDay(endMs - (span - 1) * 86400000);
  }
  const dates = dayList(from, to);
  const prev = shiftRange(from, to);

  const stores = picked.map((account) => {
    const s = storeSeries(account);
    return { account, days: s.days, notes: s.notes };
  });

  const cards = METRICS.map((metric) => {
    const mode = stores.length > 1 ? 'aggregate' : 'value';
    const cur = aggregate(stores.map((s) => s.days), dates, metric, mode);
    const before = aggregate(stores.map((s) => s.days), dayList(prev.start, prev.end), metric, mode);
    // 走势：单店铺看自己的天；多店铺按天加总（比率按分子分母逐日重算）
    const series = dates.map((date) => {
      const cells = stores.map((s) => s.days.get(date)).filter(Boolean);
      if (!cells.length) return null;
      if (metric.kind === 'ratio') {
        const numKey = metric.num || 'gmv';
        const denKey = metric.den || 'buyers';
        let n = 0;
        let d = 0;
        for (const cell of cells) {
          if (Number.isFinite(cell[numKey]) && Number.isFinite(cell[denKey])) { n += cell[numKey]; d += cell[denKey]; }
        }
        return d ? n / d : null;
      }
      if (metric.kind === 'derived') {
        const of = metric.of || [];
        let value = 0;
        let has = false;
        for (const cell of cells) {
          if (Number.isFinite(cell[of[0]])) { value += cell[of[0]]; has = true; }
          for (let i = 1; i < of.length; i += 1) if (Number.isFinite(cell[of[i]])) value -= cell[of[i]];
        }
        return has ? value : null;
      }
      let total = 0;
      let has = false;
      for (const cell of cells) {
        const v = cell[metric.key];
        if (v !== undefined && v !== null && Number.isFinite(Number(v))) { total += Number(v); has = true; }
      }
      return has ? total : null;
    });
    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      value: cur ? cur.value : null,
      prev: before ? before.value : null,
      valueText: cur ? fmtValue(cur.value, metric.unit) : '',
      deltaText: cur && before ? fmtDelta(cur.value, before.value) : '',
      complete: Boolean(cur),
      series,
    };
  });

  const withData = stores.filter((s) => s.days.size > 0);
  const notes = [];
  if (!sellers.length) notes.push('还没有卖家店铺账号');
  else if (!picked.length) notes.push('没有找到这家店铺');
  if (sellers.length && !withData.length) notes.push('还没有可用的采集产物，请先跑一次采集');
  for (const s of stores) if (!s.days.size) notes.push(`${s.account.name}：${s.notes[0] || '没有可用产物'}`);

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    range: { start: from, end: to, days: dates.length, label: from + ' — ' + to },
    prevRange: { start: prev.start, end: prev.end },
    store: store || 'all',
    stores: picked.map((a) => ({ id: a.id, name: a.name, platform: a.platform, days: stores.find((s) => s.account.id === a.id) ? stores.find((s) => s.account.id === a.id).days.size : 0 })),
    cards,
    notes,
  };
}
