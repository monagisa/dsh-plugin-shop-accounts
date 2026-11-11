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
import { flattenRows, writeXlsx } from './xlsx.mjs';
import { dslItemFileSafe, dslItemName, jobItemsLabel, sheetNameSafe } from './dsl-names.mjs';

export const JOB_VERSION = 1;
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

function writeTaskSheets(jobDir, job, stamp) {
  const files = [];
  for (const t of job.tasks || []) {
    if (!t || t.state !== 'ok') continue;
    if ((t.artifacts || []).some((a) => a && a.present && a.filePath)) continue; // 下载型配方平台已经给了表格，不再重复生成
    const rows = [];
    let labels = ['指标', '今日值', '昨日值'];
    for (const a of t.artifacts || []) {
      if (!a || !a.records || !a.records.values) continue;
      const spec = (t.declaredArtifacts || []).find((d) => String((d && (d.output_key || d.outputKey)) || '') === String(a.outputKey || ''));
      const metrics = (spec && spec.metrics) || [];
      for (const id of Object.keys(a.records.values)) {
        const label = String((metrics.find((m) => String(m && m.id) === id) || {}).label || id);
        rows.push([label, a.records.values[id], a.records.yesterday && a.records.yesterday[id] !== undefined ? a.records.yesterday[id] : '']);
      }
    }
    if (!rows.length) {
      // 这一轮没解析出指标（页面没有数据、或登录态过期）—— 仍然给一份表，写清楚状态与现场。
      labels = ['字段', '值'];
      rows.push(['状态', '没有解析出指标']);
      if (t.code) rows.push(['错误码', String(t.code)]);
      if (t.error) rows.push(['错误', String(t.error).slice(0, 400)]);
      if (t.finalUrl) rows.push(['页面', String(t.finalUrl)]);
      for (const key of Object.keys(t.outputs || {})) {
        let parsed = null;
        try { parsed = JSON.parse(String(t.outputs[key])); } catch { parsed = null; }
        if (parsed && typeof parsed === 'object') {
          for (const row of flattenRows(parsed, { maxRows: 200 })) rows.push([row[0], String(row[1] === undefined ? '' : row[1]).slice(0, 400)]);
        } else {
          const text = String(t.outputs[key] || '').trim();
          if (text) rows.push([String(key), text.slice(0, 400)]);
        }
      }
    }
    if (!rows.length) continue;
    const dir = path.join(jobDir, 'artifacts', String(t.taskId || 'task'));
    const file = path.join(dir, dslItemFileSafe(t.dslId) + '_' + stamp + '_表格.xlsx');
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeXlsx(file, [labels].concat(rows), { sheetName: sheetNameSafe(t.dslId) });
      files.push({ taskId: t.taskId, dslId: t.dslId, item: dslItemName(t.dslId), kind: 'xlsx', fileName: path.basename(file), bytes: fs.statSync(file).size });
    } catch { /* 表格写不出来不影响交付 */ }
  }
  return files;
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
      const prefix = dslItemFileSafe(t.dslId) + '_' + stamp + '_';
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
    for (const item of writeTaskSheets(jobDir, job, stampForJob(job))) files.push(item);
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
    naming: '<采集项>_<YYYYMMDD-HHmm>_<原始文件名>',
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
      const compiled = compile(raw, {
        start: window.start,
        end: window.end,
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
    const label = jobItemsLabel(tasks.map((t) => t.dslId));
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
