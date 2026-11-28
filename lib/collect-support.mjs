import path from 'node:path';
import { backendFor, egoRpa } from './ego.mjs';
import { egoSpaceName } from './ego-lifecycle.mjs';
import { browserUp } from './cdp.mjs';
import { advanceJob, prepareJob, driveBatch } from './collect-runner.mjs';
import { collectArtifacts, compileExecution, runOps, makeCdpDriver, artifactStatus } from './rpa.mjs';
import { listDsls, loadDsl } from './dsls.mjs';
import { fetchProductIds, productParamSupported } from './product-params.mjs';
import { quickLoginState } from './identity/login-state.mjs';
import { autoLogin } from './autologin.mjs';
import { getPassword, hasPassword } from './vault.mjs';
import { allowedDomains } from './domains.mjs';
import { ensureDir, dataDir, readConfig } from './store.mjs';
import { ensureCollectionDir } from './collection-dir.mjs';
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
  const dlDir = path.join(ensureCollectionDir(account), 'raw', compiled.dslId || dslId, `dl-${Date.now().toString(36)}`);
  let result;
  if (backend === 'egolite') {
    const inner = await egoRpa({ account, space: egoSpaceName(account), spaceId: Number(account.egoSpaceId) || 0, profileId: String(account.egoProfile || '') }, compiled, {
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
    const dir = path.join(ensureCollectionDir(account), 'raw', compiled.dslId || dslId);
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
/**
 * v0.20.37：按「店铺勾选的采集域 + 配方元信息」挑配方（纯函数，方便自检）。
 * 规则顺序：平台 → 是否含下载 → 引擎是否支持 → 是否需要业务参数 → 是否已校准 → 域交集。
 * body：includeDownload / includeUnverified / allowNeedsParams / autoParams。
 * v0.20.41：需要商品 ID 的配方不再一律跳过 —— 平台支持自动抓商品 ID 时（淘宝 / 拼多多 / 抖音）默认放行，
 * 由 prepareJobForAccount 在采集前把 ID 抓出来；传 autoParams:false 可以回到旧行为。
 */
export function selectRecipesForAccount(account, inventory, body = {}) {
  const accountDomains = Array.isArray(account && account.collection && account.collection.domains)
    && account.collection.domains.length
    ? account.collection.domains.map((d) => String(d || '').trim()).filter(Boolean)
    : allowedDomains(account && account.platform);
  const autoParams = body.autoParams !== false && productParamSupported(account && account.platform);
  const skipped = { domain: [], needsParams: [], download: [], noDownload: [], otherPlatform: [], unsupported: [], unverified: [], disabled: [] };
  const pickedIds = [];
  for (const meta of Array.isArray(inventory) ? inventory : []) {
    if (meta.platform !== account.platform) { skipped.otherPlatform.push(meta.id); continue; }
    // v0.20.63：显式停用的配方一律不挑（真机跑不通/会卡死的那些，先停用再修）。
    if (meta.disabled === true) { skipped.disabled.push(meta.id); continue; }
    if (!body.includeDownload && meta.hasDownload) { skipped.download.push(meta.id); continue; }
    // v0.20.59：声明了下载型产物、配方里却没有下载步骤 —— 一定等不到文件，直接跳过并给出原因。
    if (meta.declaresDownload === true && meta.hasDownload !== true) { skipped.noDownload.push(meta.id); continue; }
    if (meta.unsupported === true) { skipped.unsupported.push(meta.id); continue; }
    if (meta.needsParams === true && body.allowNeedsParams !== true && !autoParams) { skipped.needsParams.push(meta.id); continue; }
    // 新移植进来、还没真机校准的配方默认不跑：定时采集照旧只跑已校准的那几份，
    // 免得每天多出一堆「准备失败/采到空数据」的噪音；要试可以指定 dslIds 或传 includeUnverified。
    if (meta.verified !== true && body.includeUnverified !== true) { skipped.unverified.push(meta.id); continue; }
    const recipeDomains = Array.isArray(meta.domains) ? meta.domains : [];
    if (recipeDomains.length && !recipeDomains.some((d) => accountDomains.includes(d))) {
      skipped.domain.push(meta.id);
      continue;
    }
    pickedIds.push(meta.id);
  }
  return { accountDomains, pickedIds, skipped };
}

export async function prepareJobForAccount(account, body = {}) {
  // v0.20.56：采集前先确认登录态，过期就用已保存的密码自动代填一次。
  // 为什么需要这一步：以前定时/批量采集直接开跑，登录半夜失效时整轮每个任务都要先撞一次
  // LOGIN_REQUIRED 才失败（用户看到的是「采了 6 分钟什么都没拿到」）；登录能自动恢复时
  // 应该先恢复再采，恢复不了就立刻报错，不浪费一轮时间。
  let loginBootstrap = null;
  if (!isBuyerAccount(account) && body.relogin === true) {
    const state = await quickLoginState(account).catch(() => null);
    if (state && state.loggedIn === false) {
      if (hasPassword(account.id)) {
        const relog = await autoLogin(account, {
          password: getPassword(account.id),
          backend: 'egolite',
        }).catch((e) => ({ code: 'AUTOLOGIN_FAILED', error: String((e && e.message) || e) }));
        loginBootstrap = {
          attempted: true,
          ok: Boolean(relog && (relog.code === 'AUTOLOGIN_OK' || relog.loggedIn === true)),
          code: String((relog && relog.code) || ''),
          error: String((relog && relog.error) || ''),
        };
        if (!loginBootstrap.ok) {
          return {
            success: false,
            code: 'RELOGIN_FAILED',
            error: '登录态已过期，自动代填也没成功：' + (loginBootstrap.error || loginBootstrap.code || '未知原因'),
            errors: [{ code: 'RELOGIN_FAILED', message: '登录态已过期，自动代填也没成功' }],
            data: { loginBootstrap },
          };
        }
      } else {
        loginBootstrap = { attempted: false, ok: false, code: 'NO_PASSWORD', error: '这个店铺没有保存密码，需要手动登录一次' };
      }
    } else {
      loginBootstrap = { attempted: false, ok: true, loggedIn: Boolean(state && state.loggedIn) };
    }
  }

  const want = Array.isArray(body.dslIds) ? body.dslIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const inventory = listDsls().items;
  const picked = [];
  if (want.length) {
    for (const id of want) {
      const one = loadDsl(id);
            if (!one) continue;
            // v0.20.63：停用配方只能显式复测时跑（allowDisabled），免得调试脚本误触发坏配方。
            if (one.meta && one.meta.disabled === true && body.allowDisabled !== true) continue;
            picked.push({ id, raw: one.raw, meta: one.meta });
    }
  } else {
    // v0.20.37：按店铺勾选的采集域挑配方（以前勾了域也只跑该平台全部配方，域只影响台账/提示）
    const filtered = selectRecipesForAccount(account, inventory, body);
    for (const id of filtered.pickedIds) {
      const one = loadDsl(id);
      if (one) picked.push({ id, raw: one.raw, meta: one.meta });
    }
    const preparedHint = { accountDomains: filtered.accountDomains, skipped: filtered.skipped, unverifiedCount: filtered.skipped.unverified.length };
    if (!picked.length) {
      // 域交集为空 ⇒ 说明是「这个域没有配方」；否则是配方本身不满足条件（未校准/需参数/仅下载）。
      const runnableForPlatform = inventory.filter((m) => m.platform === account.platform
        && m.verified === true && m.needsParams !== true && m.unsupported !== true && m.hasDownload !== true).length;
      const byDomain = filtered.skipped.domain.length > 0 && runnableForPlatform > 0;
      const code = byDomain ? 'NO_DSL_FOR_DOMAINS' : 'no_dsl_selected';
      const message = byDomain
        ? `这个店铺勾选的采集域（${filtered.accountDomains.join(' / ')}）目前没有已校准、可直接跑的采集配方`
        : '这个店铺暂时没有可跑的采集配方（其余配方还没校准或需要业务参数，可指定 dslId 单独试跑）';
      return {
        success: false,
        ok: false,
        httpStatus: 400,
        code,
        error: message,
        // 路由层按 errors 数组回给界面（老格式），这里同时保留 code/error 方便直接调用与自检。
        errors: [{ code, message }],
        data: { collection: preparedHint },
      };
    }
    // 带上筛选结论，界面/作业报告能说明「为什么只跑了这几份」。
    body.__collectionHint = preparedHint;
  }

  // v0.20.41：要商品 ID 的配方，采集前先去店铺商品列表页把 ID 抓出来自动填进参数。
  // 抓不到就把这些配方从这一轮里摘掉（记在 collection.skipped.paramAuto），不要变成一堆「准备失败」。
  const params = Object.assign({}, body.params || {});
  const needsAny = picked.some((one) => one.meta && one.meta.needsParams === true);
  let autoParamsInfo = null;
  if (needsAny && body.autoParams !== false && productParamSupported(account.platform) && !params.productIds && !params.productId) {
    const auto = await fetchProductIds(account, { limit: Number(body.productIdLimit) || 10 });
    if (auto.ok) {
      const ids = auto.ids.slice(0, Math.max(1, Math.min(10, Number(body.productIdLimit) || 10)));
      params.productIdsLines = ids.join('\n');
      params.productIds = ids.join('\n');
      params.productId = ids[0];
      autoParamsInfo = { count: ids.length, cached: Boolean(auto.cached), page: auto.page || '' };
      if (body.__collectionHint) body.__collectionHint.autoParams = autoParamsInfo;
    } else {
      const dropped = [];
      for (let i = picked.length - 1; i >= 0; i -= 1) {
        if (picked[i].meta && picked[i].meta.needsParams === true) {
          dropped.unshift(picked[i].id);
          picked.splice(i, 1);
        }
      }
      if (body.__collectionHint) {
        body.__collectionHint.autoParams = { error: String(auto.error || auto.code || '').slice(0, 160), dropped };
        body.__collectionHint.skipped.paramAuto = dropped;
      }
      if (!picked.length) {
        const code = 'PRODUCT_IDS_UNAVAILABLE';
        const message = `采集前需要先取到商品 ID，但没能从店铺的商品列表页读到（${String(auto.error || auto.code || '').slice(0, 80)}）`;
        return {
          success: false,
          ok: false,
          httpStatus: 400,
          code,
          error: message,
          errors: [{ code, message }],
          data: { collection: body.__collectionHint || {} },
        };
      }
    }
  } else if (params.productIds && !params.productId) {
    const list = String(params.productIds).split(/[\s,，]+/).filter(Boolean);
    if (list.length) params.productId = list[0];
    autoParamsInfo = { count: list.length, manual: true };
    if (body.__collectionHint) body.__collectionHint.autoParams = autoParamsInfo;
  }

  const prepared = prepareJob({
    account,
    dsls: picked,
    start: body.start,
    end: body.end,
    params,
    skipCovered: body.skipCovered !== false,
  }, compileExecution);

  if (!prepared.success) return prepared;
  // v0.20.37：把「按域挑配方」的筛选结论一起返回，作业报告/界面能说明为什么只跑了几份。
  if (body.__collectionHint && prepared.data && typeof prepared.data === 'object') {
    body.__collectionHint.loginBootstrap = loginBootstrap;
    prepared.data.collection = body.__collectionHint;
  }
  if (body.drive !== true) return prepared;

  // 插件自己跑：prepare → 逐批执行 → advance，直到交付
  let data = prepared.data;
  const jobId = data.job_id;
  for (let guard = 0; guard < 40; guard += 1) {
    if (data.next_action !== 'native_calls') break;
    const results = await driveBatch(data, async (task) => {
      const one = loadDsl(task.dslId);
      if (!one) return { ok: false, code: 'DSL_NOT_FOUND', error: `没有这份 DSL：${task.dslId}` };
      // v0.20.57：下载型配方要等报表生成，正常就要 80-300 秒；纯读接口的给 150 秒就够。
      // 注意产物声明可能只在配方原文里（作业里的 declaredArtifacts 有时是空的），判定必须两边都看，
      // 否则下载型会按 150 秒被砍断（真机上就是「每份都踩 150 秒超时」）。
      const declaredForBudget = Array.isArray(task.declaredArtifacts) && task.declaredArtifacts.length
        ? task.declaredArtifacts
        : (((one.raw || {}).collection || {}).artifacts || []);
      const isDownloadTask = declaredForBudget.some((x) => String((x || {}).kind || '') === 'download_ref')
        || (Array.isArray(task.ops) && task.ops.some((o) => {
          const kind = String((o && o.op) || '').toLowerCase();
          return kind === 'download' || kind === 'downloadfile' || kind === 'fetchfile';
        }));
      const perTask = Math.max(30000, Number(body.taskTimeoutMs) || (isDownloadTask ? 300000 : 150000));
      // v0.20.59：对齐 上游 的重试分层 —— 默认 1 次；核心日报（store_core_daily）隔离重试 3 次；
      // 推广类与下载类 2 次。只重试「页面/下载/ego 层面」的抖动，登录失效与不支持类不重试。
      const dslIdLower = String(task.dslId || '').toLowerCase();
      const isCoreDaily = /store_core_daily|core_daily_tpl/.test(dslIdLower);
      const isAdsTask = /ads_marketing|ads_scene|tb_ads_|alimama/.test(dslIdLower);
      const maxAttempts = isCoreDaily ? 3 : ((isDownloadTask || isAdsTask) ? 2 : 1);
      const retryable = new Set([
        'STEP_TIMEOUT', 'TARGET_NOT_AVAILABLE', 'EGO_RPA_FAILED', 'EGO_NOT_RUNNING',
        'EGO_TIMEOUT', 'DOWNLOAD_TIMEOUT', 'BROWSER_NOT_RUNNING', 'TIMEOUT',
      ]);
      const attempts = [];
      let res = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // v0.21.3：任务级硬看门狗。引擎里的 await（尤其 ego 的 page.cdp / 下载事件）
        // 有可能永远不返回，而 executeOps 的 deadline 只在 op 之间检查 —— 卡在某个 await 里
        // 就再也不会检查了（真机：淘宝整店跑 28 分钟零进展，最后只能 kill 进程）。
        // 这里在批次层再掐一次表：超时按 TIMEOUT 记账，让重试/交付逻辑照常往下走。
        const watchdogMs = perTask + 30000;
        const runTask = executeOps(account, task.ops, task.downloadDir, {
          dslId: task.dslId,
          declaredArtifacts: task.declaredArtifacts,
          postprocess: Array.isArray(task.postprocess) && task.postprocess.length
            ? task.postprocess
            : (((one.raw || {}).collection || {}).capabilities || {}).after || [],
        }, { timeoutMs: perTask });
        res = await Promise.race([
          runTask,
          new Promise((resolve) => setTimeout(() => resolve({
            ok: false,
            code: 'TIMEOUT',
            error: `任务执行超时（看门狗 ${Math.round(watchdogMs / 1000)} 秒）：${task.dslId}`,
            outputs: {},
            steps: [],
            watchdog: true,
          }), watchdogMs)),
        ]);
        attempts.push({ attempt, ok: Boolean(res && res.ok), code: String((res && res.code) || ''), error: String((res && res.error) || '') });
        if (res && res.ok) break;
        if (!retryable.has(String((res && res.code) || ''))) break;
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1500));
      }
      if (res && attempts.length > 1) res = { ...res, attempts };
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
export async function executeOps(account, ops, downloadDir, compiledInfo = {}, opts = {}) {
  // v0.20.56：单任务硬超时。批量链路以前固定 300 秒一份，一份卡住整轮就挂着；
  // 现在按调用方给的预算走（默认 150 秒），超时立刻判这一份失败、继续下一份。
  const timeoutMs = Math.max(30000, Number(opts.timeoutMs) || 150000);
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
      const inner = await egoRpa({ account, space: egoSpaceName(account), spaceId: Number(account.egoSpaceId) || 0, profileId: String(account.egoProfile || '') }, info, { timeoutMs, downloadDir });
      if (!inner) return { ok: false, code: 'EGO_RPA_FAILED', error: 'ego 执行失败' };
      return { ok: Boolean(inner.ok), code: inner.code || '', error: inner.error || '', outputs: inner.outputs || {}, steps: inner.steps || [], finalUrl: inner.finalUrl || '', artifacts: inner.artifacts || [], postprocess: inner.postprocess };
    }
    const port = Number(account.port) || 0;
    const up = port ? await browserUp(port, 700).catch(() => false) : false;
    if (!up) return { ok: false, code: 'BROWSER_NOT_RUNNING', error: '这个店铺的浏览器没在运行（需要先打开店铺）' };
    const driver = makeCdpDriver({ port });
    return await runOps(info, driver, { timeoutMs, downloadDir });
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
