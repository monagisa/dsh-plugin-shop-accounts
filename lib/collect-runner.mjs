/**
 * collect-runner.mjs —— 采集编排层（v0.14.0）。
 *
 * 契约是「准备 → 执行 → 推进 → 收尾」四段式，状态全部落盘：
 *
 *   阶段                                    实现
 *   ─────────────────────────────────────  ──────────────────────────────────────
 *   prepare：读完整请求 → fresh plan         prepareJob()：算窗口/挑配方/查覆盖 → 生成 job 与首批
 *            → 批量填参 → 比较任务
 *   data.next_action = native_calls         → {next_action:'native_calls', tasks:[{taskId,ops,...}]}
 *   调用方并发执行 tasks                     → 插件也能自己跑：driveBatch
 *   advance：收本批回执 → 下一批/末批收尾     advanceJob()：记结果 → 失败重试一次 → 下一批或交付
 *   status：只读查状态，绝不重发              statusJob()：只读快照
 *   job 目录 + revision + 锁                 job.json + revision 校验（乐观并发）
 *   failed 且没采到业务数据 → 统一重试一次    → 同样：只重试「没拿到业务产物」的
 *   空 outputs/空数组 = 业务无数据，不重试     → artifactStatus().reason === 'empty_business_data'
 *
 * 为什么要这一层：单跑一份 DSL（collect-run）适合"试一下"，但真采集是**一批**任务，
 * 要处理「哪些还没采过」「哪些失败要重试」「重试完把产物和回执攒在一起交付」。
 * 没有编排层，这些状态就只能塞进 agent 的对话里 —— 一断线就全丢。
 */

import fs from 'node:fs';
import path from 'node:path';

import { dataDir, ensureDir, validAccountId } from './store.mjs';
import { trailingWindow } from './rpa.mjs';
import { flattenRows, writeWorkbook, writeXlsx } from './xlsx.mjs';
import { readTableFile } from './sheet-read.mjs';
import { dslItemFileSafe, dslItemName, jobItemsLabel, sheetNameSafe, shopNameSafe } from './dsl-names.mjs';
import { listDsls } from './dsls.mjs';

export const JOB_VERSION = 1;
/** 店名在文件名里的前缀（v0.20.51）：`<店名>_`，没有店名就空串。 */
function shopFileSeg(job) {
  const s = shopNameSafe(job && job.accountName);
  return s ? s + '_' : '';
}

/** 每批最多几项：每店一个浏览器，一次别派太多（5 项），失败面小、回执也简单。 */
export const MAX_TASKS_PER_BATCH = 5;
/** 任务状态。 */
export const TASK_STATES = ['pending', 'dispatched', 'ok', 'empty', 'failed'];

// v0.20.18：采集数据的命名约定 —— 作业目录、产物文件名里都带上时间与配方 id。
//   jobs/job_<YYYYMMDD-HHmm>_<随机 6 位>_<采集项>  一次采集一行，看目录名就知道什么时候、采了什么
//   artifacts/<采集项>_<YYYYMMDD-HHmm>_<原始文件名>
//   artifacts/manifest.json                 这次采集交付了哪些文件、各多少字节
const JOB_ID_RE = /^job_[^\\/:*?"<>|]{4,120}$/;
const JOB_ID_READABLE_RE = /^job_\d{8}-\d{4}_[a-z0-9]{3,12}(?:_[^\\/:*?"<>|]+)?$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间的紧凑时间戳，用来拼目录与文件名：20261111-1230。 */
export function runStamp(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
}

export function readableJobId(date, tail, label) {
  const t = String(tail || Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'abc123';
  const base = 'job_' + runStamp(date) + '_' + t;
  const tag = String(label == null ? '' : label).trim();
  return tag ? base + '_' + tag : base;
}

/**
 * v0.20.20：指标型配方（把页面文字 / JSON 解析成指标）也落一份 xlsx。
 * 用户看数据只需要表格：下载型配方本来就有平台导出的 xlsx，指标型以前只有 JSON。
 */
function stampForJob(job) {
  const id = String((job && job.jobId) || '');
  const hit = /^job_(\d{8}-\d{4})_/.exec(id);
  if (hit) return hit[1];
  const created = new Date(String((job && job.createdAt) || ''));
  return Number.isNaN(created.getTime()) ? runStamp(new Date()) : runStamp(created);
}

/** v0.20.32：本地日期 YYYY-MM-DD；拿不到就用运行时间。 */
function dayOf(value) {
  const d = new Date(String(value || ''));
  const at = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n) => String(n).padStart(2, '0');
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate());
}

/** v0.20.32：前一天（YYYY-MM-DD 进、出）。 */
function dayBefore(day) {
  const d = new Date(String(day || '') + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

let dslDomainCache = null;

/** 读配方 id → 采集域集合（listDsls() 返回的是 { items }）。 */
function buildDslDomainCache() {
  try {
    const list = listDsls();
    const items = Array.isArray(list) ? list : ((list && list.items) || []);
    return new Map(items.map((d) => [String((d && d.id) || ''), ((d && d.domains) || []).slice()]));
  } catch { return new Map(); }
}

function dslDomainOf(dslId) {
  const id = String(dslId || '');
  if (!dslDomainCache) dslDomainCache = buildDslDomainCache();
  if (!dslDomainCache.has(id)) dslDomainCache = buildDslDomainCache();
  const domains = dslDomainCache.get(id) || [];
  return String(domains[0] || '');
}

function taskCells(t, job) {
  if (!t || t.state !== 'ok') return null;
  if ((t.artifacts || []).some((a) => a && a.present && a.filePath)) return null; // 下载型配方平台已经给了表格，不再重复生成
  const cells = []; // [{ date, label, value }]
  let series = null;
  let asOf = '';
  let prevDate = '';
  for (const a of t.artifacts || []) {
    if (!a || !a.records || !a.records.values) continue;
    const spec = (t.declaredArtifacts || []).find((d) => String((d && (d.output_key || d.outputKey)) || '') === String(a.outputKey || ''));
    const metrics = (spec && spec.metrics) || [];
    const labelOf = (id) => String((metrics.find((m) => String(m && m.id) === id) || {}).label || id);
    if (!series && a.records.series && Array.isArray(a.records.series.dates) && a.records.series.dates.length > 1) series = a.records.series;
    if (a.records.asOf) {
      asOf = a.records.asOf;
      prevDate = a.records.prevDate || '';
    }
    for (const id of Object.keys(a.records.values)) {
      cells.push({ date: asOf || dayOf(job.createdAt), label: labelOf(id), value: a.records.values[id] });
    }
    if (a.records.yesterday) {
      const prior = prevDate || dayBefore(asOf || dayOf(job.createdAt));
      for (const id of Object.keys(a.records.yesterday)) {
        const value = a.records.yesterday[id];
        if (value === undefined || value === null || value === '') continue;
        cells.push({ date: prior, label: labelOf(id), value });
      }
    }
  }
  if (series) {
    for (const col of Object.keys(series.columns)) {
      for (let i = 0; i < series.dates.length; i += 1) {
        const value = series.columns[col][i];
        if (value === undefined || value === null || value === '') continue;
        cells.push({ date: String(series.dates[i]), label: String(col), value });
      }
    }
  }
  return { domain: dslDomainOf(t.dslId) || '采集数据', cells };
}

const ISSUE_SHEET = '采集情况';

function sheetFromTasks(built) {
  const labels = [];
  const dates = [];
  const values = new Map();
  for (const b of built) {
    for (const c of b.cells) {
      const key = c.date + '|' + c.label;
      if (!values.has(key)) {
        values.set(key, c.value);
        labels.push(c.label);
        dates.push(c.date);
      }
    }
  }
  const labelList = Array.from(new Set(labels));
  const dateList = Array.from(new Set(dates)).sort();
  const header = ['日期'].concat(labelList);
  const rows = dateList.map((d) => {
    const row = [d];
    for (const label of labelList) {
      const hit = values.get(d + '|' + label);
      row.push(hit === undefined ? '' : hit);
    }
    return row;
  });
  return { name: '', header, rows };
}

/** 工作簿里各域工作表的固定顺序（v0.20.60）。 */
const DOMAIN_SHEET_ORDER = ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约'];

function dayKeyOf(at) {
  try { return runStamp(new Date(at)).slice(0, 8); } catch { return ''; }
}

/**
 * 读回一份作业里「下载型配方」拿到的表格（v0.20.60）。
 * 平台导出的 xlsx/csv 按域归到工作表；读不回来的（老式 .xls、内容不是表格）直接跳过，
 * 原始文件照常交付，不影响工作簿生成。
 */
function tableSheetsOfJob(job) {
  const out = [];
  for (const t of (job && job.tasks) || []) {
    if (t.state !== 'ok' && t.state !== 'empty') continue;
    const domain = dslDomainOf(t.dslId) || '采集数据';
    for (const a of (t.artifacts || [])) {
      if (!a || !a.present || !a.filePath) continue;
      let read;
      try {
        read = readTableFile(a.filePath);
      } catch {
        continue;
      }
      if (!read.sheets || !read.sheets.length) continue;
      const many = read.sheets.length > 1;
      for (const s of read.sheets) {
        const rows = (s.rows || []).map((r) => (r || []).map((v) => (v === undefined || v === null ? '' : v)));
        if (!rows.length) continue;
        out.push({ domain, name: many ? domain + '-' + String(s.name || '') : domain, rows, source: path.basename(String(a.filePath)) });
      }
    }
  }
  return out;
}

/** 同店同一天的其它作业（v0.20.60：「同一天五个域分几次跑，最后并进同一份工作簿」）。 */
function siblingJobsOf(job) {
  const others = [];
  try {
    const root = jobRoot(job.accountId);
    const names = fs.readdirSync(root).filter((n) => n !== job.jobId && JOB_ID_RE.test(n));
    for (const name of names.slice(-30)) {
      try {
        const other = readJob(job.accountId, name);
        if (!other || !other.jobId || other.jobId === job.jobId) continue;
        if (dayKeyOf(other.createdAt) !== dayKeyOf(job.createdAt)) continue;
        others.push(other);
      } catch { /* 坏作业跳过 */ }
    }
  } catch { /* 没有作业目录就只出本次 */ }
  others.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return others;
}

/** 一份作业一个文件：按采集域分表（五项域各一个工作表），同店同天的其它作业按域补齐。 */
export function writeJobWorkbook(jobDir, job, stamp) {
  const groups = new Map();
  const issues = [];
  for (const t of job.tasks || []) {
    const built = taskCells(t, job);
    if (!built) continue;
    if (!built.cells.length) {
      issues.push([dslItemName(t.dslId) + '（' + built.domain + '）', '没有解析出指标']);
      if (t.code) issues.push([dslItemName(t.dslId) + ' 错误码', String(t.code)]);
      if (t.error) issues.push([dslItemName(t.dslId) + ' 错误', String(t.error).slice(0, 300)]);
      if (t.finalUrl) issues.push([dslItemName(t.dslId) + ' 页面', String(t.finalUrl)]);
      continue;
    }
    const key = built.domain;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(built);
  }
  const metricSheets = new Map();
  for (const [domain, built] of groups) {
    const sheet = sheetFromTasks(built);
    if (sheet.rows.length) metricSheets.set(domain, sheet);
  }

  // 下载型配方：把平台导出的表格读回成工作表；本作业没有的域，去同店同天的其它作业补。
  const tables = new Map();
  for (const t of tableSheetsOfJob(job)) if (!tables.has(t.domain)) tables.set(t.domain, t);
  for (const other of siblingJobsOf(job)) {
    for (const t of tableSheetsOfJob(other)) {
      if (tables.has(t.domain)) continue;
      tables.set(t.domain, t);
      issues.push(['并入同一天的其它作业', t.domain + ' · ' + other.jobId + ' · ' + t.source]);
    }
  }

  const sheets = [];
  const usedNames = new Set();
  const takeName = (want) => {
    let name = sheetNameSafe(want);
    let i = 2;
    while (usedNames.has(name)) {
      const suffix = '(' + i + ')';
      name = sheetNameSafe(String(want).slice(0, 31 - suffix.length) + suffix);
      i += 1;
    }
    usedNames.add(name);
    return name;
  };
  const domains = DOMAIN_SHEET_ORDER.filter((d) => metricSheets.has(d) || tables.has(d))
    .concat(Array.from(tables.keys()).filter((d) => !DOMAIN_SHEET_ORDER.includes(d)))
    .concat(Array.from(metricSheets.keys()).filter((d) => !DOMAIN_SHEET_ORDER.includes(d) && !tables.has(d)));
  for (const domain of domains) {
    if (tables.has(domain)) {
      const t = tables.get(domain);
      sheets.push({ name: takeName(t.name), header: t.rows[0], rows: t.rows.slice(1) });
      continue;
    }
    const s = metricSheets.get(domain);
    sheets.push({ name: takeName(s.name || domain), header: s.header, rows: s.rows });
  }
  if (issues.length) sheets.push({ name: takeName(ISSUE_SHEET), header: ['采集项', '情况'], rows: issues });
  if (!sheets.length) return null;
  const dir = path.join(jobDir, 'artifacts');
  const shopSeg = shopFileSeg(job).replace(/_$/, '');
  const file = path.join(dir, '采集数据_' + stamp + (shopSeg ? '_' + shopSeg : '') + '.xlsx');
  fs.mkdirSync(dir, { recursive: true });
  writeWorkbook(file, sheets.map((s) => ({ name: s.name, rows: [s.header].concat(s.rows) })));
  const size = fs.statSync(file).size;
  return { kind: 'xlsx', fileName: path.basename(file), bytes: size, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })) };
}

/** 把本次作业的下载产物按「配方_时间_原名」改名，并写一份 manifest.json。 */
export function organizeArtifacts(jobDir, job) {
  const artRoot = path.join(jobDir, 'artifacts');
  ensureDir(artRoot);
  const created = job && job.createdAt ? new Date(job.createdAt) : new Date();
  const stamp = runStamp(created);
  const files = [];
  for (const t of (job && job.tasks) || []) {
    for (const a of t.artifacts || []) {
      if (!a || !a.present || !a.filePath) continue;
      const src = String(a.filePath);
      try {
        const st = fs.statSync(src);
        if (!st || st.size <= 0) continue;
      } catch {
        continue;
      }
      const orig = path.basename(src);
      const prefix = dslItemFileSafe(t.dslId) + '_' + stamp + '_' + shopFileSeg(job);
      if (!orig.startsWith(prefix)) {
        const next = path.join(path.dirname(src), prefix + orig);
        try {
          fs.renameSync(src, next);
          a.filePath = next;
        } catch { /* 改名失败就保留原名，不影响交付 */ }
      }
      a.fileName = path.basename(a.filePath);
      files.push({ taskId: t.taskId, dslId: t.dslId, item: dslItemName(t.dslId), state: t.state, fileName: a.fileName, bytes: Number(a.bytes) || 0 });
    }
  }
  try {
    const book = writeJobWorkbook(jobDir, job, stampForJob(job));
    if (book) files.push(book);
  } catch { /* ignore */ }
  const manifest = {
    version: 1,
    jobId: job.jobId,
    accountId: job.accountId,
    accountName: job.accountName,
    platform: job.platform,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || '',
    window: (job.plan && job.plan.window) || null,
    naming: shopFileSeg(job)
      ? '<采集项>_<YYYYMMDD-HHmm>_<店名>_<原始文件名>'
      : '<采集项>_<YYYYMMDD-HHmm>_<原始文件名>',
    files,
    items: (job.tasks || []).map((t) => ({ taskId: t.taskId, dslId: t.dslId, name: dslItemName(t.dslId), state: t.state })),
    tasks: (job.tasks || []).map((t) => ({ taskId: t.taskId, dslId: t.dslId, state: t.state })),
  };
  try {
    fs.writeFileSync(path.join(artRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch { /* ignore */ }
  return manifest;
}

/**
 * v0.20.18：作业目录不会无限涨 —— 每个账号保留最近的若干次。
 * 采到了数据（至少一项 ok）保留最近 20 个；只有失败/空数据的保留最近 3 个。
 */
export function pruneJobs(accountId, opts = {}) {
  const keepOk = Number(opts.keepOk) || 20;
  const keepFailed = Number(opts.keepFailed) || 3;
  const keepPerDay = Number(opts.keepPerDay) || 2;
  const dedupe = opts.dedupe !== false;
  const id = requireAccount(accountId);
  let names = [];
  try {
    names = fs.readdirSync(jobRoot(id));
  } catch {
    return { removed: 0, kept: 0 };
  }
  const metas = names.map((name) => {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobRoot(id), name, 'job.json'), 'utf8'));
      return { name, job };
    } catch {
      return { name, job: null };
    }
  });
  metas.sort((a, b) => String((b.job && b.job.createdAt) || '').localeCompare(String((a.job && a.job.createdAt) || '')));

  /** v0.20.19：同一次采集（同样配方 + 同样窗口）留最新那份，旧的视为重复。 */
  const signatureOf = (job) => {
    const dsls = (job.tasks || []).map((t) => String(t.dslId || '')).filter(Boolean).sort().join('+') || String(job.jobId || '');
    const win = (job.plan && job.plan.window) || {};
    return dsls + '|' + String(win.start || '') + '..' + String(win.end || '');
  };
  const dayOf = (job) => {
    const when = new Date(String(job.createdAt || ''));
    if (Number.isNaN(when.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return String(when.getFullYear()) + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate());
  };

  const seenSignature = new Set();
  const perDay = new Map();
  let ok = 0;
  let failed = 0;
  let removed = 0;
  let kept = 0;
  for (const m of metas) {
    if (!m.job || !m.job.finished) continue;
    const hasOk = (m.job.tasks || []).some((t) => t.state === 'ok');
    if (hasOk) {
      ok += 1;
      const sig = signatureOf(m.job);
      const day = dayOf(m.job);
      const dayCount = (perDay.get(day) || 0) + 1;
      perDay.set(day, dayCount);
      const duplicate = dedupe && seenSignature.has(sig);
      seenSignature.add(sig);
      if (duplicate || dayCount > keepPerDay || ok > keepOk) {
        try {
          fs.rmSync(path.join(jobRoot(id), m.name), { recursive: true, force: true });
          removed += 1;
        } catch { /* ignore */ }
        continue;
      }
      kept += 1;
      continue;
    }
    failed += 1;
    if (failed > keepFailed) {
      try {
        fs.rmSync(path.join(jobRoot(id), m.name), { recursive: true, force: true });
        removed += 1;
      } catch { /* ignore */ }
      continue;
    }
    kept += 1;
  }
  return { removed, kept };
}
function jobRoot(accountId) {
  return path.join(dataDir(), 'collection', requireAccount(accountId), 'jobs');
}

function requireAccount(accountId) {
  const id = String(accountId || '').trim();
  if (!validAccountId(id)) throw new Error(`账号 id 不合法：${id || '(空)'}`);
  return id;
}

export function jobDirFor(accountId, jobId) {
  const id = String(jobId || '').trim();
  if (!JOB_ID_RE.test(id)) throw new Error(`job id 不合法：${id || '(空)'}`);
  return path.join(jobRoot(accountId), id);
}

function nowIso() { return new Date().toISOString(); }

function readJob(accountId, jobId) {
  const file = path.join(jobDirFor(accountId, jobId), 'job.json');
  if (!fs.existsSync(file)) throw Object.assign(new Error(`没有这个采集作业：${jobId}`), { code: 'JOB_NOT_FOUND' });
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!job || job.version !== JOB_VERSION) throw Object.assign(new Error('作业文件版本不认识'), { code: 'JOB_CORRUPT' });
  return job;
}

function writeJob(accountId, job) {
  const dir = jobDirFor(accountId, job.jobId);
  ensureDir(dir);
  job.updatedAt = nowIso();
  job.revision += 1;
  const tmp = path.join(dir, `job.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(dir, 'job.json'));
  return job;
}

/** 一份配方在某账号上"采过没"的粗粒度台账（DSL 维度；指标级的覆盖走 datastore 的 coverage）。 */
function coverageFile(accountId) {
  return path.join(dataDir(), 'collection', requireAccount(accountId), 'dsl-coverage.json');
}

function readDslCoverage(accountId) {
  try {
    const raw = JSON.parse(fs.readFileSync(coverageFile(accountId), 'utf8'));
    return raw && typeof raw === 'object' && raw.items ? raw : { version: 1, items: {} };
  } catch { return { version: 1, items: {} }; }
}

function markDslCovered(accountId, dslId, window) {
  const data = readDslCoverage(accountId);
  const key = String(dslId);
  const prev = Array.isArray(data.items[key]) ? data.items[key] : [];
  prev.push({ start: window.start, end: window.end, at: nowIso() });
  // 只留最近 50 条，避免无限增长
  data.items[key] = prev.slice(-50);
  try {
    ensureDir(path.dirname(coverageFile(accountId)));
    fs.writeFileSync(coverageFile(accountId), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 台账写失败不影响主流程 */ }
}

/** 这个 DSL 在窗口内是否已经采过（同 start/end 完全一致才算）。 */
export function dslCovered(accountId, dslId, window) {
  const data = readDslCoverage(accountId);
  const list = Array.isArray(data.items[String(dslId)]) ? data.items[String(dslId)] : [];
  return list.some((r) => r && r.start === window.start && r.end === window.end);
}

function batchOf(tasks) {
  const out = [];
  for (let i = 0; i < tasks.length; i += MAX_TASKS_PER_BATCH) {
    out.push(tasks.slice(i, i + MAX_TASKS_PER_BATCH));
  }
  return out;
}

function publicTask(t) {
  return {
    taskId: t.taskId,
    dslId: t.dslId,
    name: t.name || dslItemName(t.dslId),
    platform: t.platform,
    url: t.url || '',
    downloadDir: t.downloadDir || '',
    ops: t.ops,
  };
}

/**
 * 准备作业（prepare 阶段）。
 *
 * @param {object} opts
 * @param {object} opts.account       账号对象（要 id / platform / name）
 * @param {Array}  opts.dsls          要跑的配方：[{id, raw, meta}]（由调用方用 dsls.loadDsl 取好）
 * @param {string} [opts.start]       覆盖窗口开始（默认最近 30 个完整自然日）
 * @param {string} [opts.end]
 * @param {object} [opts.params]      配方需要的业务参数
 * @param {boolean}[opts.skipCovered] 已采过的配方是否跳过（默认 true）
 * @param {Function}[opts.compile]    注入 compileExecution（便于测试/避免循环依赖）
 * @returns {{success:boolean, data?:object, errors?:Array}}
 */
export function prepareJob(opts = {}, compile) {
  const account = opts.account || {};
  const accountId = requireAccount(account.id);
  const window = opts.start && opts.end
    ? { start: String(opts.start), end: String(opts.end) }
    : (() => { const w = trailingWindow(new Date(), 30); return { start: w.start, end: w.end }; })();
  const list = Array.isArray(opts.dsls) ? opts.dsls : [];
  if (!list.length) {
    return { success: false, errors: [{ code: 'no_dsl_selected', message: '没有选中任何采集配方（用 GET /rpa/dsls 查可用的）' }] };
  }
  const skipCovered = opts.skipCovered !== false;
  // v0.20.18：job id 带上本地时间；v0.20.23：任务确定后再把采集项写进目录名
  const jobId = readableJobId(new Date());
  let dir = jobDirFor(accountId, jobId);
  ensureDir(dir);

  const tasks = [];
  const skipped = [];
  const failedToPrepare = [];
  for (const item of list) {
    const id = String(item && (item.id || (item.meta && item.meta.id)) || '').trim();
    const raw = item && item.raw;
    if (!id || !raw) { failedToPrepare.push({ dslId: id || '(空)', reason: 'dsl_missing' }); continue; }
    const platform = String((item.meta && item.meta.platform) || raw.platform || '');
    if (platform && platform !== String(account.platform)) {
      failedToPrepare.push({ dslId: id, reason: `platform_mismatch:${platform}` });
      continue;
    }
    if (skipCovered && dslCovered(accountId, id, window)) {
      skipped.push({ dslId: id, reason: 'already_covered' });
      continue;
    }
    try {
      // v0.20.63：没有显式 start/end 时不要硬塞统一窗口 —— 有归档延迟的配方（退款类 T+2）
      // 靠自己的 collection.schedule.t_minus 决定窗口，硬塞会把截止日塞成「还没归档」的那天，只能得到空表。
      const compiled = compile(raw, {
        start: opts.start || undefined,
        end: opts.end || undefined,
        params: opts.params || {},
        runId: `${jobId}_${id}`,
      });
      tasks.push({
        taskId: `t_${String(tasks.length + 1).padStart(3, '0')}`,
        dslId: id,
        name: dslItemName(id),
        platform,
        url: (compiled.ops.find((o) => o.op === 'goto') || {}).url || '',
        downloadDir: path.join(dir, 'artifacts', `t_${String(tasks.length + 1).padStart(3, '0')}`),
        ops: compiled.ops,
        declaredArtifacts: compiled.declaredArtifacts || [],
        postprocess: compiled.postprocess || [],
        state: 'pending',
        attempts: 0,
        window,
      });
    } catch (err) {
      failedToPrepare.push({
        dslId: id,
        reason: (err && err.code) || 'compile_failed',
        message: String((err && err.message) || err),
        unresolved: (err && err.unresolved) || [],
      });
    }
  }

  // v0.20.23：任务确定后把采集项写进目录名 —— job_<时间>_<随机>_<采集项1>+<采集项2>
  // 目录里这会儿还没有产物，改名不影响任何文件；失败就保持原 id，采集照常。
  let finalId = jobId;
  if (tasks.length) {
    const shopPart = shopNameSafe(account.name);
    const label = [shopPart, jobItemsLabel(tasks.map((t) => t.dslId))].filter(Boolean).join('_');
    if (label) {
      const nextId = jobId + '_' + label;
      try {
        const nextDir = jobDirFor(accountId, nextId);
        fs.renameSync(dir, nextDir);
        dir = nextDir;
        finalId = nextId;
        for (const t of tasks) t.downloadDir = path.join(dir, 'artifacts', t.taskId);
      } catch { /* 改名失败不影响采集 */ }
    }
  }

  const job = {
    version: JOB_VERSION,
    jobId: finalId,
    accountId,
    platform: account.platform,
    accountName: String(account.name || ''),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    revision: 1,
    request: { dslIds: list.map((d) => String((d && (d.id || (d.meta && d.meta.id))) || '')), start: window.start, end: window.end, params: opts.params || {} },
    plan: { window, total: list.length, prepared: tasks.length, skipped, failedToPrepare },
    tasks,
    batches: [],
    dispatched: 0,
    finished: false,
  };

  if (!tasks.length) {
    job.finished = true;
    writeJob(accountId, job);
    // 「一条都没准备好，而且也不是因为已采过」= 真失败，要带错误码，别让上层当成「今天已采过」（v0.16.7）
    const nothingPrepared = failedToPrepare.length > 0 && skipped.length === 0;
    return {
      success: !nothingPrepared,
      errors: nothingPrepared
        ? failedToPrepare.map((f) => ({ code: String(f.reason || 'COMPILE_FAILED'), message: String(f.message || ''), dslId: f.dslId }))
        : undefined,
      data: {
        job_id: job.jobId, job_dir: dir, revision: job.revision,
        next_action: 'done',
        plan: job.plan,
        summary: { prepared: 0, skipped: skipped.length, failedToPrepare: failedToPrepare.length },
        message: failedToPrepare.length
          ? '全部配方都没准备好：看 failedToPrepare 里的原因（平台不匹配 / 缺业务参数 / 缺后处理能力 / 已采过）'
          : '这些配方在窗口内都已采过，无需重复采集',
      },
    };
  }

  const batches = batchOf(tasks);
  job.batches = batches.map((b, i) => ({ batchId: `b_${i + 1}`, taskIds: b.map((t) => t.taskId), settled: false }));
  writeJob(accountId, job);
  return {
    success: true,
    data: {
      job_id: job.jobId,
      job_dir: dir,
      revision: job.revision,
      request_file: path.join(dir, 'job.json'),
      next_action: 'native_calls',
      plan: job.plan,
      parallel: true,
      batch: { batchId: job.batches[0].batchId, index: 0, total: job.batches.length },
      tasks: batches[0].map(publicTask),
      advance_call: { accountId, jobId: job.jobId, revision: job.revision, batchId: job.batches[0].batchId },
      hint: `本批 ${batches[0].length} 项，全部返回后调用 advance（共 ${job.batches.length} 批）；不要自己拆批或补项`,
    },
  };
}

/**
 * 推进作业（advance 阶段）：记本批结果 → 失败重试一次 → 下一批或交付。
 *
 * results: `[{taskId, ok, code, outputs, artifacts, steps, finalUrl}]`
 * 只消费本批 taskId；已 settled 的不会被重新投递（对应他的「不重发已发调用」）。
 */
export function advanceJob(opts = {}, artifactStatus) {
  const accountId = requireAccount(opts.accountId);
  const job = readJob(accountId, opts.jobId);
  if (Number(opts.revision) !== job.revision) {
    return {
      success: false,
      errors: [{ code: 'revision_mismatch', message: `revision 不对（当前 ${job.revision}），用返回的最新 revision` }],
      data: { job_id: job.jobId, revision: job.revision, next_action: 'status' },
    };
  }
  const batchId = String(opts.batchId || (job.batches.find((b) => !b.settled) || {}).batchId || '');
  const batch = job.batches.find((b) => b.batchId === batchId);
  if (!batch) return { success: false, errors: [{ code: 'batch_not_found', message: `没有这批：${batchId}` }] };

  const incoming = new Map();
  for (const r of Array.isArray(opts.results) ? opts.results : []) {
    if (r && r.taskId) incoming.set(String(r.taskId), r);
  }
  const byId = new Map(job.tasks.map((t) => [t.taskId, t]));
  const settledNow = [];
  for (const tid of batch.taskIds) {
    const t = byId.get(tid);
    if (!t) continue;
    if (t.state === 'ok' || t.state === 'empty') { settledNow.push(tid); continue; }
    const r = incoming.get(tid);
    if (!r) continue; // 回执没到：保留 pending，不猜
    t.attempts += 1;
    t.code = String(r.code || (r.ok ? '' : 'STEP_FAILED'));
    t.error = String(r.error || '');
    t.outputs = r.outputs && typeof r.outputs === 'object' ? r.outputs : {};
    t.artifacts = Array.isArray(r.artifacts) ? r.artifacts : [];
    t.steps = Array.isArray(r.steps) ? r.steps : [];
    t.finalUrl = String(r.finalUrl || '');
    if (r.ok) {
      const st = typeof artifactStatus === 'function' ? artifactStatus({ artifacts: t.artifacts }) : { ok: true };
      t.state = st.ok ? 'ok' : 'empty';
      t.businessData = st.reason || 'ok';
    } else if (t.code === 'UNSUPPORTED_ACTION' || t.code === 'NO_DRIVER' || t.code === 'DSL_NEEDS_DOWNLOAD') {
      t.state = 'failed';
      t.retryable = false;
    } else {
      t.state = 'failed';
      t.retryable = true;
    }
    settledNow.push(tid);
  }
  batch.settled = true;
  job.dispatched += 1;

  // 落产物：把下载文件/JSON 产物登记到作业目录，成功项记 DSL 覆盖台账
  for (const tid of settledNow) {
    const t = byId.get(tid);
    if (!t) continue;
    if (t.state === 'ok' || t.state === 'empty') {
      try {
        const artDir = path.join(jobDirFor(accountId, job.jobId), 'artifacts');
        ensureDir(artDir);
        fs.writeFileSync(path.join(artDir, `${tid}.json`), JSON.stringify({
          taskId: tid, dslId: t.dslId, state: t.state, code: t.code || '',
          artifacts: t.artifacts, outputs: t.outputs, steps: t.steps, finalUrl: t.finalUrl,
        }, null, 2), 'utf8');
      } catch { /* ignore */ }
      if (t.state === 'ok') markDslCovered(accountId, t.dslId, t.window || job.plan.window);
    }
  }

  // 失败重试一次（只重试"没采到业务数据"的；UNSUPPORTED/NO_DRIVER 不重试）
  const retry = job.tasks.filter((t) => t.state === 'failed' && t.retryable && t.attempts < 2);
  const pendingOrDispatched = job.tasks.filter((t) => t.state === 'pending' || t.state === 'dispatched');
  const nextBatch = job.batches.find((b) => !b.settled);

  let nextAction = 'done';
  let nextTasks = [];
  if (retry.length && !nextBatch) {
    for (const t of retry) t.state = 'pending';
    for (const b of job.batches) b.settled = true;
    const rb = batchOf(retry);
    job.batches.push(...rb.map((b) => ({ batchId: `r_${job.batches.length + 1}`, taskIds: b.map((t) => t.taskId), settled: false, retry: true })));
    nextAction = 'native_calls';
    nextTasks = rb[0].map((t) => byId.get(t.taskId)).filter(Boolean);
  } else if (nextBatch) {
    nextAction = 'native_calls';
    nextTasks = nextBatch.taskIds.map((tid) => byId.get(tid)).filter(Boolean);
  }

  if (nextAction === 'done') {
    job.finished = true;
    job.finishedAt = nowIso();
    // v0.20.18：产物按命名约定改名 + 落 manifest.json，再按保留上限清理更早的作业
    try { organizeArtifacts(jobDirFor(accountId, job.jobId), job); } catch { /* 清单失败不影响结果 */ }
    try { pruneJobs(accountId); } catch { /* 清理失败也不影响结果 */ }
  }
  writeJob(accountId, job);

  const counts = countStates(job.tasks);
  const out = {
    job_id: job.jobId,
    job_dir: jobDirFor(accountId, job.jobId),
    revision: job.revision,
    next_action: nextAction,
    counts,
    plan: job.plan,
    tasks: nextTasks.map(publicTask),
    advance_call: nextAction === 'native_calls'
      ? { accountId, jobId: job.jobId, revision: job.revision, batchId: (job.batches.find((b) => !b.settled) || {}).batchId }
      : undefined,
  };
  if (nextAction === 'done') {
    out.delivery = buildDelivery(accountId, job);
  }
  return { success: true, data: out };
}

function countStates(tasks) {
  const c = { total: tasks.length, ok: 0, empty: 0, failed: 0, pending: 0 };
  for (const t of tasks) {
    if (t.state === 'ok') c.ok += 1;
    else if (t.state === 'empty') c.empty += 1;
    else if (t.state === 'failed') c.failed += 1;
    else c.pending += 1;
  }
  return c;
}

/** 交付清单：成功产物路径 + 未完成项与原因（对应他的 delivery/summary/limitations）。 */
function buildDelivery(accountId, job) {
  const artifacts = [];
  const incomplete = [];
  for (const t of job.tasks) {
    if (t.state === 'ok') {
      for (const a of t.artifacts || []) {
        if (a && a.present) artifacts.push({ taskId: t.taskId, dslId: t.dslId, kind: a.kind, outputKey: a.outputKey, bytes: a.bytes, filePath: a.filePath || '' });
      }
    } else if (t.state === 'empty') {
      incomplete.push({ dslId: t.dslId, state: 'empty', reason: '业务无数据（不是失败，别重采）' });
    } else if (t.state === 'failed') {
      incomplete.push({ dslId: t.dslId, state: 'failed', code: t.code || '', reason: t.error || '', attempts: t.attempts });
    } else {
      incomplete.push({ dslId: t.dslId, state: t.state, reason: '回执没到，保留未决（别盲目重发）' });
    }
  }
  return {
    jobId: job.jobId,
    window: job.plan.window,
    counts: countStates(job.tasks),
    artifacts,
    incomplete,
    jobJson: path.join(jobDirFor(accountId, job.jobId), 'job.json'),
    hint: artifacts.length
      ? '产物已归集；归一化成指标后用 collect-import 落库（带覆盖区间）'
      : '没有拿到业务产物，看 incomplete 的原因',
  };
}

/** 只读状态（status 阶段：绝不重发任何调用）。 */
export function statusJob({ accountId, jobId } = {}) {
  const id = requireAccount(accountId);
  const job = readJob(id, jobId);
  return {
    success: true,
    data: {
      job_id: job.jobId,
      revision: job.revision,
      finished: Boolean(job.finished),
      plan: job.plan,
      counts: countStates(job.tasks),
      batches: job.batches.map((b) => ({ batchId: b.batchId, settled: b.settled, retry: Boolean(b.retry), count: b.taskIds.length })),
      tasks: job.tasks.map((t) => ({ taskId: t.taskId, dslId: t.dslId, state: t.state, attempts: t.attempts, code: t.code || '', error: t.error || '' })),
    },
  };
}

/**
 * v0.20.21：最近一次作业采了哪些采集项 —— 界面「上次采集」用它标出中文名（抖店-成交分析）。
 */
export function lastJobItems(accountId) {
  const empty = { jobId: '', at: '', finishedAt: '', items: [] };
  try {
    const id = requireAccount(accountId);
    const names = fs.readdirSync(jobRoot(id)).filter((n) => JOB_ID_RE.test(n));
    const jobs = [];
    for (const n of names) {
      try { jobs.push(readJob(id, n)); } catch { /* 坏作业跳过 */ }
    }
    jobs.sort((a, b) => String((a && a.createdAt) || '').localeCompare(String((b && b.createdAt) || '')));
    const job = jobs[0];
    if (!job) return empty;
    return {
      jobId: job.jobId,
      at: job.createdAt || '',
      finishedAt: job.finishedAt || '',
      items: (job.tasks || []).map((t) => ({ dslId: t.dslId, name: t.name || dslItemName(t.dslId), state: t.state })),
    };
  } catch { return empty; }
}

/** 列出这个账号的作业（按时间倒序，最多 20 个）。 */
export function listJobs(accountId) {
  const id = requireAccount(accountId);
  let names = [];
  try { names = fs.readdirSync(jobRoot(id)); } catch { return { success: true, data: { jobs: [] } }; }
  const jobs = [];
  for (const n of names.slice(-50)) {
    try {
      const job = readJob(id, n);
      jobs.push({ jobId: job.jobId, createdAt: job.createdAt, finished: Boolean(job.finished), counts: countStates(job.tasks), window: job.plan.window });
    } catch { /* 坏作业跳过 */ }
  }
  jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { success: true, data: { jobs: jobs.slice(0, 20) } };
}

/**
 * 自己跑一批（插件内执行，不依赖调用方）。
 * 用注入的 executor 执行每个 task；executor(task) → {ok, code, outputs, artifacts, steps, finalUrl}
 */
export async function driveBatch(jobData, executor) {
  if (!jobData || !Array.isArray(jobData.tasks)) throw new Error('driveBatch 需要 prepare 返回的 data');
  const results = [];
  for (const task of jobData.tasks) {
    let r;
    try {
      r = await executor(task);
    } catch (err) {
      r = { ok: false, code: (err && err.code) || 'STEP_FAILED', error: String((err && err.message) || err) };
    }
    results.push({ taskId: task.taskId, ...r });
  }
  return results;
}
