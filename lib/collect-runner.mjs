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

export const JOB_VERSION = 1;
/** 每批最多几项：每店一个浏览器，一次别派太多（5 项），失败面小、回执也简单。 */
export const MAX_TASKS_PER_BATCH = 5;
/** 任务状态。 */
export const TASK_STATES = ['pending', 'dispatched', 'ok', 'empty', 'failed'];

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
  if (!/^job_[a-z0-9_]{4,40}$/.test(id)) throw new Error(`job id 不合法：${id || '(空)'}`);
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
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = jobDirFor(accountId, jobId);
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

  const job = {
    version: JOB_VERSION,
    jobId,
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
        job_id: jobId, job_dir: dir, revision: job.revision,
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
      job_id: jobId,
      job_dir: dir,
      revision: job.revision,
      request_file: path.join(dir, 'job.json'),
      next_action: 'native_calls',
      plan: job.plan,
      parallel: true,
      batch: { batchId: job.batches[0].batchId, index: 0, total: job.batches.length },
      tasks: batches[0].map(publicTask),
      advance_call: { accountId, jobId, revision: job.revision, batchId: job.batches[0].batchId },
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
