import path from 'node:path';
import { backendFor, egoRpa } from './ego.mjs';
import { egoSpaceName } from './ego-backend.mjs';
import { browserUp } from './cdp.mjs';
import { advanceJob, prepareJob, driveBatch } from './collect-runner.mjs';
import { collectArtifacts, compileExecution, runOps, makeCdpDriver, artifactStatus } from './rpa.mjs';
import { listDsls, loadDsl } from './dsls.mjs';
import { allowedDomains } from './domains.mjs';
import { ensureDir, dataDir, readConfig } from './store.mjs';
import { looksLikeLoginPage, normalizeAccountType, platformOf } from './platforms.mjs';

/**
 * v0.18.11：买家（C 端）账号不做数据采集。
 * 采集读的是商家后台的报表页面（千牛 / 抖店后台 / 京麦 / mms），C 端买家没有这些页面 ——
 * 给买家账号勾采集域只会让定时任务到点失败，所以：
 *   1. /state 里把买家账号的采集配置强制成空、collectionReady 恒为 false；
 *   2. 采集相关接口（改配置 / 取提示词 / 发作业）一律拒绝，错误码 COLLECTION_UNSUPPORTED_BUYER；
 *   3. 定时任务对买家账号只会做静默登录检测，不会去跑采集。
 */
export function isBuyerAccount(a) {
  try { return normalizeAccountType(a && a.accountType) === 'buyer'; } catch { return false; }
}
export const BUYER_COLLECT_UNSUPPORTED = '买家账号不做数据采集：采集读的是商家后台的报表（千牛 / 抖店后台 / 京麦 / mms），C 端买家没有这些页面。要采集请用这个平台的卖家账号。';

// ── v0.13.0 采集 DSL 执行 ────────────────────────────────────────────────────

/**
 * 跑一份采集 DSL。
 * 分工：引擎只负责「按配方把页面走完、把产物取回来」，
 * **不猜指标映射**；原始产物落盘留证，归一化+落库仍走 collect-import。
 */
export async function runCollectionDsl(account, body = {}) {
  const dslId = String(body.dslId || body.id || '').trim();
  if (!dslId) return { ok: false, httpStatus: 400, code: 'DSL_ID_REQUIRED', error: '需要 dslId（用 GET /rpa/dsls 查有哪些）' };
  const found = loadDsl(dslId);
  if (!found) return { ok: false, httpStatus: 404, code: 'DSL_NOT_FOUND', error: `没有这份 DSL：${dslId}` };
  const meta = found.meta || {};
  if (meta.platform && String(meta.platform) !== String(account.platform)) {
    return {
      ok: false, httpStatus: 400, code: 'DSL_PLATFORM_MISMATCH',
      error: `这份 DSL 是 ${meta.platform} 的，这个店铺是 ${account.platform}`,
    };
  }
  // 下载型配方不再拒绝：引擎会设置浏览器下载目录、轮询落盘文件（v0.14.0）

  let compiled;
  try {
    compiled = compileExecution(found.raw, {
      start: String(body.start || '') || undefined,
      end: String(body.end || '') || undefined,
      params: body.params && typeof body.params === 'object' ? body.params : {},
      runId: body.runId || undefined,
    });
  } catch (err) {
    return {
      ok: false, httpStatus: 400, code: (err && err.code) || 'DSL_INVALID',
      error: String((err && err.message) || err), unresolved: (err && err.unresolved) || [],
    };
  }

  const cfg = readConfig();
  const backend = backendFor(cfg);
  // 下载落盘目录：每次执行一个独立子目录，产物和 raw 留档放一起
  const dlDir = path.join(dataDir(), 'collection', account.id, 'raw', compiled.dslId || dslId, `dl-${Date.now().toString(36)}`);
  let result;
  if (backend === 'egolite') {
    const inner = await egoRpa({ account, space: egoSpaceName(account) }, compiled, {
      timeoutMs: Number(body.timeoutMs) || 300000,
      downloadDir: dlDir,
    });
    if (!inner || inner.ok === false) {
      return {
        ok: false,
        httpStatus: inner && inner.code === 'ego_not_running' ? 409 : 400,
        code: (inner && inner.code) || 'EGO_RPA_FAILED',
        error: (inner && inner.error) || 'ego 执行失败',
        hint: 'ego 后端要求这个店铺先打开过（有任务空间）且 ego 正在运行',
        steps: (inner && inner.steps) || [],
      };
    }
    result = {
      ok: true, code: '', dslId: compiled.dslId, outputs: inner.outputs || {},
      steps: inner.steps || [], finalUrl: inner.finalUrl || '', window: compiled.window,
    };
  } else {
    const port = Number(account.port) || 0;
    const up = port ? await browserUp(port, 700).catch(() => false) : false;
    if (!up) {
      return { ok: false, httpStatus: 409, code: 'BROWSER_NOT_RUNNING', error: '这个店铺的浏览器没在运行（需要先打开店铺）' };
    }
    const driver = makeCdpDriver({ port });
    result = await runOps(compiled, driver, { timeoutMs: Number(body.timeoutMs) || 300000, log: () => {}, downloadDir: dlDir });
  }

  // 原始产物留档（失败也存，便于排查配方问题）
  let savedPath = '';
  try {
    const dir = path.join(dataDir(), 'collection', account.id, 'raw', compiled.dslId || dslId);
    ensureDir(dir);
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({
      dslId: compiled.dslId || dslId, platform: account.platform, accountId: account.id,
      window: compiled.window, ok: Boolean(result.ok), code: result.code || '',
      steps: result.steps || [], outputs: result.outputs || {}, finalUrl: result.finalUrl || '',
    }, null, 2), 'utf8');
    savedPath = file;
  } catch { /* 留档失败不影响结果 */ }

  const arts = collectArtifacts({ collection: { artifacts: compiled.declaredArtifacts || [] } }, result.outputs || {});
  const status = artifactStatus({ artifacts: arts });
  return {
    ok: Boolean(result.ok),
    code: result.code || '',
    error: result.error || '',
    account: account.name,
    accountId: account.id,
    platform: account.platform,
    dslId: compiled.dslId || dslId,
    window: compiled.window,
    artifacts: arts,
    businessData: status,
    outputs: result.outputs || {},
    steps: result.steps || [],
    finalUrl: result.finalUrl || '',
    rawPath: savedPath,
    hint: status.ok
      ? '产物已取到；归一化成指标后用 collect-import 落库（记得带 coverageStart/coverageEnd）'
      : '没有取到业务数据：先看 steps 里失败在哪一步（LOGIN_REQUIRED 就是需要重新登录）',
  };
}

/**
 * 准备一个采集作业（v0.14.0 编排层）。
 * body:
 *   dslIds: string[]  指定配方（不给就取这个平台全部"能跑"的配方）
 *   start/end         窗口（默认最近 30 个完整自然日）
 *   params            配方业务参数
 *   includeDownload   是否包含依赖下载的配方（默认 true）
 *   skipCovered       已采过的是否跳过（默认 true）
 *   drive: true       **插件自己跑完**（不等调用方逐个执行），返回最终交付
 */
export async function prepareJobForAccount(account, body = {}) {
  const want = Array.isArray(body.dslIds) ? body.dslIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const inventory = listDsls().items;
  const picked = [];
  if (want.length) {
    for (const id of want) {
      const one = loadDsl(id);
      if (one) picked.push({ id, raw: one.raw, meta: one.meta });
    }
  } else {
    for (const meta of inventory) {
      if (meta.platform !== account.platform) continue;
      if (!body.includeDownload && meta.hasDownload) continue;
      const one = loadDsl(meta.id);
      if (one) picked.push({ id: meta.id, raw: one.raw, meta: one.meta });
    }
  }
  const prepared = prepareJob({
    account,
    dsls: picked,
    start: body.start,
    end: body.end,
    params: body.params,
    skipCovered: body.skipCovered !== false,
  }, compileExecution);

  if (!prepared.success) return prepared;
  if (body.drive !== true) return prepared;

  // 插件自己跑：prepare → 逐批执行 → advance，直到交付
  let data = prepared.data;
  const jobId = data.job_id;
  for (let guard = 0; guard < 40; guard += 1) {
    if (data.next_action !== 'native_calls') break;
    const results = await driveBatch(data, async (task) => {
      const one = loadDsl(task.dslId);
      if (!one) return { ok: false, code: 'DSL_NOT_FOUND', error: `没有这份 DSL：${task.dslId}` };
      const res = await executeOps(account, task.ops, task.downloadDir, {
        dslId: task.dslId,
        declaredArtifacts: task.declaredArtifacts,
        postprocess: Array.isArray(task.postprocess) && task.postprocess.length
          ? task.postprocess
          : (((one.raw || {}).collection || {}).capabilities || {}).after || [],
      });
      // v0.16.7：产物判定必须按「这条配方声明了哪些产物 + 实际拿到的 outputs」算。
      // （以前 ego 后端这里返回写死的空数组，导致**采到数据也判成「业务无数据」**。）
      const declared = Array.isArray(task.declaredArtifacts) && task.declaredArtifacts.length
        ? task.declaredArtifacts
        : (((one.raw || {}).collection || {}).artifacts || []);
      return { ...res, artifacts: collectArtifacts({ collection: { artifacts: declared } }, res.outputs || {}) };
    });
    const advanced = advanceJob({
      accountId: account.id,
      jobId,
      revision: data.revision,
      batchId: (data.batch && data.batch.batchId) || (data.advance_call && data.advance_call.batchId),
      results,
    }, artifactStatus);
    if (!advanced.success) return advanced;
    data = advanced.data;
  }
  return { success: true, data };
}

/**
 * 用当前后端执行一批编译好的 ops，并统一做「登录态兜底判定」（v0.16.9）。
 *
 * 为什么要兜底：配方里的登录守卫是「命中登录框 → 断言它必须不可见（必然失败）」这种写法，
 * 但只有部分配方写了守卫；抖音、京东这类配方没写守卫时，登录过期只会表现为某个选择器等不到
 * （STEP_FAILED / STEP_TIMEOUT / TARGET_NOT_AVAILABLE），从外面看起来像「站点没数据」。
 * 这里补一层：失败时看**最终停留的 URL 是不是登录页**（判据来自平台定义里的 loginUrlHints），
 * 是就统一报 LOGIN_REQUIRED，好让「登录过期自动代填」那条路能接上。
 */
export async function executeOps(account, ops, downloadDir, compiledInfo = {}) {
  const cfg = readConfig();
  const backend = backendFor(cfg);
  const info = {
    ops,
    dslId: String(compiledInfo.dslId || ''),
    declaredArtifacts: compiledInfo.declaredArtifacts || [],
    postprocess: compiledInfo.postprocess || [],
  };
  const res = await (async () => {
    if (backend === 'egolite') {
      const inner = await egoRpa({ account, space: egoSpaceName(account) }, info, { timeoutMs: 300000, downloadDir });
      if (!inner) return { ok: false, code: 'EGO_RPA_FAILED', error: 'ego 执行失败' };
      return { ok: Boolean(inner.ok), code: inner.code || '', error: inner.error || '', outputs: inner.outputs || {}, steps: inner.steps || [], finalUrl: inner.finalUrl || '', artifacts: inner.artifacts || [], postprocess: inner.postprocess };
    }
    const port = Number(account.port) || 0;
    const up = port ? await browserUp(port, 700).catch(() => false) : false;
    if (!up) return { ok: false, code: 'BROWSER_NOT_RUNNING', error: '这个店铺的浏览器没在运行（需要先打开店铺）' };
    const driver = makeCdpDriver({ port });
    return await runOps(info, driver, { timeoutMs: 300000, downloadDir });
  })();
  if (!res || res.ok) return res;
  const code = String(res.code || '');
  const generic = !code || code === 'STEP_FAILED' || code === 'STEP_TIMEOUT' || code === 'TARGET_NOT_AVAILABLE';
  if (!generic) return res;
  let onLoginPage = false;
  try {
    const platformDef = platformOf(account.platform);
    onLoginPage = Boolean(res.finalUrl) && Boolean(platformDef)
      && looksLikeLoginPage(res.finalUrl, platformDef, normalizeAccountType(account.accountType));
  } catch { onLoginPage = false; }
  if (!onLoginPage) return res;
  return {
    ...res,
    code: 'LOGIN_REQUIRED',
    error: '登录态已过期：页面停在登录页，配方里的步骤走不下去 —— 先登录（详情页「重新登录（代填）」，或者手动打开店铺登录一次）',
    loginUrl: res.finalUrl,
  };
}

/**
 * 域是否属于这个平台（v0.12.0 目录层）：淘宝/天猫有「竞争洞察」，其余平台没有。
 * 返回错误文案；合法返回 null。
 */
export function domainErrorFor(platformId, domain) {
  const d = String(domain || '').trim();
  if (!d) return null;
  const allow = allowedDomains(platformId);
  return allow.includes(d) ? null : `「${d}」不是这个平台的采集域（可选：${allow.join(' / ')}）`;
}
