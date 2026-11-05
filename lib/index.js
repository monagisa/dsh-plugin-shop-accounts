// dsh-plugin-shop-accounts —— DSH 工具插件：电商平台店铺账号管理
//
// 一句话：**一个账号一份 Chrome 档案**，登录一次就留着，以后上架直接复用。
//
// 宿主半身做三件事：
//   1. 在自己名下挂一组 HTTP 路由（`/shop-accounts/...`），给设置页那个前端半身用；
//   2. 起 / 停 / 检测每个账号的 Chrome（每个账号一份 `--user-data-dir` + 一个固定调试端口）；
//   3. 把一个 agent 工具 `shop_accounts` 注册进去，让上架流程能"挑一个店铺"拿到
//      `{ port, cdpUrl, profileDir, platform }` —— 这就是"后续上架直接复用、不用重新登录"的接口面。
//
// 设计上刻意**不碰凭据**：不存密码、不代填账密、不代扫码，全部由用户在真实 Chrome 窗口里手动完成。
// 本插件保存的是"这个档案已经登录过了"这个事实（靠 CDP `Network.getAllCookies` 读身份 cookie 判定），
// 以及那个档案本身的磁盘位置。
//
// 安装（桌面端 profile 由 Electron 应用独占，必须从 UI 装 —— CLI 会拒绝 `--profile desktop`）：
//   设置 → 插件 → 从本地安装 → 选本目录（或打好包的 .tgz）
// 源码开发：把它放/链到 profile 的 node_modules 下即可（新插件由客户端 HMR 挂载）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ACCOUNT_TYPES, PLATFORMS, accountTypeLabel, accountTypeSupport, accountTypesFor, capabilitiesOf,
  isValidAccountType, loginMethodsOf, normalizeAccountType, platformOf, platformList, judgeLogin,
  supportsPasswordLogin, tokenExpiryOf, looksLikeLoginPage, domainMatches, variantOf,
} from './platforms.mjs';
import {
  accountsPath, configPath, dataDir, ensureDir, newAccountId,
  profileDirFor, readAccounts, readConfig, readRuntime, setRuntime, writeAccounts, writeConfig,
  isInsideProfileRoot, normalizeImportedProfileDir, validAccountId,
} from './store.mjs';
import {
  chromeOwnerOfPort, isPortFree, launchBrowser, killChromeForProfile, pickPort, removeProfileDir,
  resolveBrowserPath, waitForCdp, waitPortGone, safeNavUrl,
} from './chrome.mjs';
import { browserUp, closeBrowser, closePage, evaluateOn, getAllCookies, listPages, newPage, setCookies } from './cdp.mjs';
import {
  backendFor, egoAppRunning, egoAppRunningInvalidate, egoClose, egoHandOff, egoLaunchApp, egoList,
  egoOfflineCookies, egoOpen, egoProbe, egoReset, egoRpa, egoStatus, egoUserDataDir, spaceNameFor,
  normalizeEgoProfileId, normalizeEgoSpace,
} from './ego.mjs';
import { sessionKey, sealCookieJar, openCookieJar, dpapiAvailable } from './secret.mjs';
import {
  SCHEDULE_DEFAULTS, dueRows, groupSizeFor, markRan, nextRun, normalizeSchedule, planSchedule,
} from './schedule.mjs';
import {
  vaultAvailable, vaultInfo, getPassword, hasPassword, passwordUpdatedAt, setPassword, clearPassword,
  removeAccountSecret, normalizePassword,
} from './vault.mjs';
import { autoLogin } from './autologin.mjs';
import * as osPlatform from './platform/index.mjs';
import {
  COLLECTION_DOMAINS, COLLECTION_LABELS, applyCollectionResult, collectDomainId, collectionPrompt,
  collectionRangeText, collectionReady, dueCollections, domainList, isCollectionDue, normalizeCollection,
} from './collection.mjs';
import {
  catalogDomains, catalogDomainIds, catalogInfo, catalogMetric, catalogMetrics, unknownMetricIds,
} from './catalog.mjs';
import {
  collectionSummary, importRecords, planCollection, queryRecords, removeCollectionStore,
} from './datastore.mjs';
import {
  artifactStatus, collectArtifacts, compileExecution, makeCdpDriver, runOps, RPA_CODES,
} from './rpa.mjs';
import { listDsls, loadDsl } from './dsls.mjs';
import {
  advanceJob, driveBatch, listJobs, prepareJob, statusJob,
} from './collect-runner.mjs';

/**
 * 某平台允许的采集域（v0.12.0 目录层）：淘宝/天猫多一个「竞争洞察」，其余平台 5 域。
 * 目录不可用时 catalogDomainIds 会退回默认 5 域，行为与 v0.11.0 一致。
 */
function allowedDomains(platformId) {
  try { return catalogDomainIds(platformId); } catch { return COLLECTION_DOMAINS.slice(); }
}

/** 某平台的域清单（带指标数），给界面/提示词用。 */
function domainOptions(platformId) {
  try {
    const list = catalogDomains(platformId);
    return list.length ? list : domainList();
  } catch { return domainList(); }
}

// ── v0.13.0 采集 DSL 执行 ────────────────────────────────────────────────────

/**
 * 跑一份采集 DSL。
 * 分工：引擎只负责「按配方把页面走完、把产物取回来」，
 * **不猜指标映射**；原始产物落盘留证，归一化+落库仍走 collect-import。
 */
async function runCollectionDsl(account, body = {}) {
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
async function prepareJobForAccount(account, body = {}) {
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
async function executeOps(account, ops, downloadDir, compiledInfo = {}) {
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
function domainErrorFor(platformId, domain) {
  const d = String(domain || '').trim();
  if (!d) return null;
  const allow = allowedDomains(platformId);
  return allow.includes(d) ? null : `「${d}」不是这个平台的采集域（可选：${allow.join(' / ')}）`;
}

export const name = 'dsh-plugin-shop-accounts';

/** 等一会儿（保活停留用）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 真机诊断日志 ─────────────────────────────────────────────────────────────
// 客户端的坑越来越依赖「当时现场」：千牛那次就是「登录→打开工作台→关窗→检测」四步里
// 某一步把身份 cookie 弄丢了，靠聊天问不出来。所以每个关键动作都把当时的 URL + 关键 cookie
// （只记名字/域/到期，**不记值**）追加到 <数据目录>/debug.log，出问题时直接看这条时间线。
// 纯诊断，写不进去也绝不影响业务。
const DEBUG_LOG_MAX = 512 * 1024;

function appendDebug(tag, payload) {
  try {
    const file = path.join(dataDir(), 'debug.log');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 还没有日志 */ }
    if (size > DEBUG_LOG_MAX) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), tag, ...payload }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 抓这个账号端口上「跟登录有关的那几个 cookie」的快照（值不落盘）。 */
async function snapshotAccount(account, platform) {
  const port = Number(account && account.port) || 0;
  if (!port) return { up: false, url: '', cookies: [] };
  if (!(await browserUp(port, 600))) return { up: false, url: '', cookies: [] };
  // 端口上不一定是这个店铺的浏览器：不是我们的就只记"跳过"，不读它的 cookie
  if (!(await ourBrowserOnPort(account, port, accountProfileDir(account, readConfig())))) {
    return { up: true, url: '', cookies: [], skipped: '端口归属不是这个店铺' };
  }
  try {
    const got = await getAllCookies(port);
    if (!got) return { up: true, url: '', cookies: [] };
    const names = new Set([
      ...((platform && platform.sessionCookies) || []),
      ...((platform && platform.identityCookies) || []),
      'QNWORKBENCH_SESSION', 'QNWORKBENCH_SESSION.sig',
    ]);
    return {
      up: true,
      url: got.url || '',
      total: got.cookies.length,
      cookies: got.cookies
        .filter((c) => names.has(c.name))
        .map((c) => ({ name: c.name, domain: c.domain, expires: c.expires })),
    };
  } catch (err) {
    return { up: true, url: '', cookies: [], error: err && err.message ? err.message : String(err) };
  }
}

// ── 会话 cookie 的本地备份（「点 X 关窗」会丢会话级 cookie）────────────────────
// 实测（2026-10-19 千牛）：用插件自己的关闭（CDP Browser.close）时 `unb` 能落盘、重开还登录；
// 但用户直接点窗口红叉后，档案里只剩下 42 个 cookie、`unb` 没了 → 重开就被按回登录页。
// 会话级 cookie 本来就「不该」跨浏览器退出存活，但我们需要它 ——
// 所以保存登录态时把整罐 cookie 存到档案目录（只在本机），下次启动先用 CDP 网络层补回去。
function sessionCookieFile(account) {
  try {
    return path.join(accountProfileDir(account, readConfig()), 'dsh-session-cookies.json');
  } catch { return ''; }
}

/** 保存登录态时把 cookie 罐记到档案目录（只在本机，且**加密**）。 */
export function saveSessionCookies(account, cookies) {
  const cfg = readConfig();
  // 只给"插件自己管的档案"做 cookie 备份：导入的目录可能在 C:\Users\Public 这类位置，
  // 把带值的 cookie 写进去等于扩大泄露面（2026-10-31 二次审查）。
  if (!isInsideProfileRoot(accountProfileDir(account, cfg), cfg)) {
    // 顺手清掉 v0.8.3 可能在导入目录里留下的**明文**备份（不再读、也不再写）。
    try {
      const stray = sessionCookieFile(account);
      if (stray && fs.existsSync(stray)) {
        const raw = JSON.parse(fs.readFileSync(stray, 'utf8'));
        if (!raw || !raw.enc) fs.rmSync(stray, { force: true });
      }
    } catch { /* 清不掉就算了 */ }
    return false;
  }
  const file = sessionCookieFile(account);
  if (!file) return false;
  // 只存「这个平台域下的」cookie：finish 时拿到的是整罐，把别的站点（甚至其它平台的登录态）
  // 一起抄到磁盘上既没必要也扩大泄露面（2026-10-31 安全审查）。
  const platform = platformOf(account && account.platform);
  const domains = (platform && Array.isArray(platform.cookieDomains)) ? platform.cookieDomains : [];
  const keep = (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && typeof c.name === 'string' && c.value != null)
    .filter((c) => !domains.length || domainMatches(c.domain, domains));
  if (!keep.length) return false;
  try {
    ensureDir(path.dirname(file));
    // DPAPI 信封 + AES-256-GCM 加密（见 lib/secret.mjs）；不可用时自动退明文格式，功能不受影响
    const payload = { savedAt: new Date().toISOString(), platform: account.platform, total: keep.length, cookies: keep };
    const key = sessionKey(dataDir());
    const { sealed } = sealCookieJar(payload, key);
    fs.writeFileSync(file, JSON.stringify(sealed), 'utf8');
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 上基本是 no-op，失败不影响功能 */ }
    return true;
  } catch { return false; }
}

function loadSessionCookies(account) {
  const cfg = readConfig();
  if (!isInsideProfileRoot(accountProfileDir(account, cfg), cfg)) return null;
  const file = sessionCookieFile(account);
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return openCookieJar(raw, sessionKey(dataDir()));
  } catch { return null; }
}

/**
 * 把上次存的 cookie 罐补回这个端口上的浏览器。返回 `{ok, count, savedAt}`。
 *
 * **只补档案里现在缺的那些**（按 `名字@域` 比）：档案里已经有同名 cookie 说明它比备份新
 * （或者站点刚重新种过），拿旧的盖掉反而会坏事。所以这里是「填空」，不是「覆盖」。
 */
export async function restoreSessionCookies(port, account) {
  const payload = loadSessionCookies(account);
  const cookies = payload && Array.isArray(payload.cookies) ? payload.cookies : null;
  if (!cookies || !cookies.length) return { ok: false, count: 0, savedAt: '' };
  const savedAt = String(payload.savedAt || '');
  let existing = [];
  try {
    const got = await getAllCookies(port);
    existing = (got && got.cookies) || [];
  } catch { /* 读不到就当全缺 */ }
  const have = new Set(existing.map((c) => `${c.name}@${c.domain}`));
  const missing = cookies.filter((c) => !have.has(`${c.name}@${c.domain}`));
  if (!missing.length) return { ok: true, count: 0, savedAt, skipped: cookies.length };
  try {
    await setCookies(port, missing);
    return { ok: true, count: missing.length, skipped: cookies.length - missing.length, savedAt };
  } catch (err) {
    return { ok: false, count: 0, error: err && err.message ? err.message : String(err) };
  }
}

/** 浏览器开着且已登录时，把当前 cookie 罐（含刚轮换过的值）存一份。 */
async function rememberLiveCookies(account) {
  const port = Number(account.port) || 0;
  if (!port) return false;
  if (!(await browserUp(port, 500))) return false;
  // 只读自己那只浏览器的 cookie：端口可能被别的进程（或用户自己开的 Chrome）占着，
  // 读它的 cookie 再存起来 = 把别人的会话写进这个店铺的备份（2026-10-31 二次审查）。
  const cfg = readConfig();
  if (!(await ourBrowserOnPort(account, port, accountProfileDir(account, cfg)))) return false;
  try {
    const got = await getAllCookies(port);
    if (!got || !got.cookies || !got.cookies.length) return false;
    return saveSessionCookies(account, got.cookies);
  } catch { return false; }
}


/** 路由是硬需求；`tools` 走可选注入（见下方 apply）—— 没有工具服务也不该拖垮设置页。 */
export const inject = ['webServer'];

// 导出给自检用：同一家店的 ego 动作必须串行（路由/定时检测/agent 工具共用这把锁）。
// 放在这里而不是只给内部用，是因为锁的「等待-重检查」顺序很容易写错，需要有真并发的回归测试绑住。
export { acquireAccountLock, withAccountLock };

const PLUGIN = 'shop-accounts';
/** 本插件 HTTP 面的路径前缀（客户端半身里的 BASE 必须与之一致）。 */
const BASE = '/shop-accounts';
/**
 * 只允许本插件自己的界面调用这几个路由：客户端每一个请求都带这个头。
 * 跨站请求想带自定义头就必须先过 CORS 预检，而本服务从不回 ACAO —— 预检必失败。
 * 宿主的 renderer token 门禁是第一道，这一道是插件自己的第二道（宿主策略变了也不会裸奔）。
 */
const REQ_HEADER = 'x-dsh-shop-accounts';
/** 请求体上限：本插件最大的请求是"改配置"那几个字段，256 KB 已经是三个数量级的余量。 */
const BODY_LIMIT = 256 * 1024;

// ── 日志 ────────────────────────────────────────────────────────────────────

function makeLog(ctx) {
  let logger = null;
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger(PLUGIN) : ctx.logger;
  } catch { /* 宿主没给 logger 也不影响功能 */ }
  const write = (level, text) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level]('[shop-accounts] ' + text);
      else if (level === 'error') console.error('[shop-accounts] ' + text);
    } catch { /* 日志失败不许影响业务 */ }
  };
  return {
    info: (t) => write('info', t),
    warn: (t) => write('warn', t),
    error: (t) => write('error', t),
  };
}

// ── 客户端报错落盘（v0.17.9）────────────────────────────────────────────────
//
// 客户端半月在渲染进程里跑，它的 console.error / 未捕获异常进不了宿主日志；
// 而设置页的条目一旦抛异常，宿主会用 SlotErrorBoundary 兜住并渲染一个空 div ——
// 界面上只剩一片空白，看不出原因。所以页面侧把异常 POST 回来，这里落成文本。
//
// 只保留最近 N 条、每条一行，避免被刷爆：客户端本身有去重（同一条只报一次）。

const CLIENT_ERROR_LOG = 'client-errors.log';
const CLIENT_ERROR_KEEP = 200;

function clientErrorPath() {
  return path.join(dataDir(), CLIENT_ERROR_LOG);
}

function recordClientError(input) {
  try {
    const at = new Date().toISOString();
    const source = capStr(String((input && input.source) || 'client'), 64);
    const message = capStr(String((input && input.message) || ''), 400);
    const stack = capStr(String((input && input.stack) || ''), 4000);
    const where = capStr(String((input && input.where) || ''), 200);
    if (!message && !stack) return '';
    const line = JSON.stringify({ at, source, where, message, stack });
    const file = clientErrorPath();
    ensureDir(dataDir());
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 还没有文件 */ }
    const lines = prev.split('\n').filter(Boolean);
    lines.push(line);
    while (lines.length > CLIENT_ERROR_KEEP) lines.shift();
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return line;
  } catch {
    return '';
  }
}

function readClientErrors(limit = 50) {
  try {
    const file = clientErrorPath();
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean).slice(-Math.max(1, limit));
    return lines.map((line) => {
      try { return JSON.parse(line); } catch { return { message: line }; }
    });
  } catch {
    return [];
  }
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

/**
 * 把错误文本里的凭据打码：git 的 stderr 会把远端 URL 原样带出来，
 * 而 `https://user:TOKEN@github.com/...` 这种 URL 一旦进界面/日志就是一次泄露。
 */
export function maskSecrets(text) {
  return String(text == null ? '' : text)
    // URL 里的 user:password@
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
    // 只有 userinfo、没有冒号的（https://<token>@host）
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    // Authorization: Bearer xxx
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    // query 里的 token / key / secret / password
    .replace(/([?&](?:access_token|refresh_token|token|api[_-]?key|apikey|secret|password|sig|signature)=)[^&\s"']+/gi, '$1***')
    // 常见 token 形状
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})\b/g, '***');
}

/** 字符串字段的统一限长（防止有人往账号表里塞几十 KB 的字段把 /state 撑爆）。 */
function capStr(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

/** 登录方式的界面文案（v0.16.6：拼多多 C 端只有验证码/扫码，密码库用不上）。 */
function loginMethodLabel(m) {
  const k = String(m || '');
  if (k === 'password') return '账号密码';
  if (k === 'sms') return '手机验证码';
  if (k === 'qrcode') return '扫码';
  return k || '手动';
}

// ── v0.17.0：登录方式（账号密码代填 / 扫码或手动登录）─────────────────────────
// 记不住登录账号密码的用户不一定要存密码：把这家店铺改成「扫码或手动登录」，
// 打开窗口登录一次，登录态就落在这份独立的本地档案里（跟以前那套账号工具的做法一样）。
const LOGIN_MODES = [
  { id: 'password', label: '账号密码代填' },
  { id: 'qrcode', label: '扫码或手动登录' },
];
export { LOGIN_MODES };

/** 登录方式归一化：认不出来的值一律当「账号密码代填」（默认行为，与历史数据一致）。 */
export function normalizeLoginMode(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'qrcode' || s === 'qr' || s === 'scan' || s === 'manual') return 'qrcode';
  return 'password';
}

function loginModeLabelOf(mode) {
  return normalizeLoginMode(mode) === 'qrcode' ? '扫码或手动登录' : '账号密码代填';
}

/** 这条店铺记录的登录方式（历史数据没有这个字段 → 账号密码代填）。 */
export function loginModeOf(account) {
  return normalizeLoginMode(account && account.loginMode);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    // 客户端中途断开（关面板 / 刷新页面 / 代理超时）时 Node 只发 aborted/close，不发 error ——
    // 不兜底的话这个 Promise 永远 pending：路由层拿着账号锁一直不释放，那个店铺后面所有动作都卡死（v0.8.1 修）。
    const bail = (why, status) => {
      if (done) return;
      done = true;
      const err = new Error(why);
      err.status = status || 400;
      reject(err);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        bail('请求体过大', 413);
        try { req.destroy(); } catch { /* 已经断了 */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        done = true;
        return resolve({});
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        bail('请求体不是合法 JSON：' + err.message, 400);
        return;
      }
      // 只收 JSON 对象：数组/字符串/null 会让下游 `body.xxx` 静默取到 undefined，
      // 变成"看着成功其实没改"的隐蔽状态。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        bail('请求体必须是 JSON 对象', 400);
        return;
      }
      done = true;
      resolve(parsed);
    });
    req.on('error', (err) => bail('读请求体出错：' + (err && err.message ? err.message : String(err)), 400));
    req.on('aborted', () => bail('请求被客户端中断', 400));
    req.on('close', () => bail('连接已关闭', 400));
  });
}

// ── 自更新（检测 GitHub 上的新版本 / 一键拉取）────────────────────────────────
//
// 这个插件在 profile 里是**一份拷贝**（`node_modules/dsh-plugin-shop-accounts`），真正的
// 源码在别处一个 git 仓库里。所以「更新」= 在源码仓库 `git fetch` → 快进合并 →
// 把 lib/ package.json README.md test/ 覆盖到这份拷贝。
// 覆盖完必须重启宿主才生效：宿主启动时就把插件代码读进内存了，换文件不会热更新。

/** 本插件安装目录（含 package.json 的那一层）。 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 某个安装目录里的版本号（默认 = 现在跑着的这份）。 */
function versionOfDir(dir = PKG_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch { return ''; }
}

/** 当前跑着的这份代码的版本号。 */
function ownVersion() { return versionOfDir(PKG_ROOT); }

/**
 * **本次启动真正加载进来的**版本号（模块加载那一刻记下来）。
 *
 * 为什么单独记一个：`ownVersion()` 每次读的是磁盘上的 package.json ——「更新到最新」把文件覆盖了、
 * 却没重启 DSH Desktop 的时候，它会显示新版本号，但内存里跑的还是旧代码。
 * 用户看到「版本已经是 0.6.7 了怎么还是老毛病」，就是被这个骗了（2026-10-19 千牛那次）。
 * 所以把加载时的版本固定下来，界面上一比就知道「文件更新了、但还没重启」。
 */
const LOADED_VERSION = ownVersion();


/**
 * 跑一次 git（同步、带超时、绝不抛）。
 *
 * 加固项：
 *   · `GIT_TERMINAL_PROMPT=0`：凭据缺失时宁可失败也不要挂住；
 *   · `-c protocol.ext.allow=never`：禁掉 `ext::` 传输；
 *   · `-c core.fsmonitor=` / `-c core.sshCommand=ssh`：仓库自己的 `.git/config` 里
 *     这两个键会在 `status`/`fetch` 时执行命令 —— 更新源目录不可全信，一律覆盖成安全值；
 *   · 输出里的凭据打码（远端 URL 可能内嵌 token）。
 */
function runGit(dir, args, timeoutMs = 30000) {
  try {
    const r = spawnSync('git', [
      '-c', 'protocol.ext.allow=never',
      '-c', 'core.fsmonitor=',
      '-c', 'core.sshCommand=ssh',
      '-c', 'core.hooksPath=',
      '-C', dir,
      ...args,
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return {
      ok: r.status === 0,
      out: maskSecrets(String(r.stdout || '').trim()),
      err: maskSecrets(String(r.stderr || '').trim() || (r.error ? String(r.error.message || r.error) : '')),
    };
  } catch (err) {
    return { ok: false, out: '', err: maskSecrets(err && err.message ? err.message : String(err)) };
  }
}

/**
 * 源码目录在哪：优先用设置里手填的；否则按「自己是不是 git 仓库」→「profile 的
 * `file:` / `link:` 依赖」两步猜。猜不到就返回 ''，让界面提示去填。
 */
function detectUpdateDir() {
  const configured = String(readConfig().updateDir || '').trim();
  if (configured) {
    const abs = path.resolve(configured);
    // 更新源目录不可全信：它会被 `git` 读写、里面还有 `.git/config`。只接受绝对路径的目录。
    if (!path.isAbsolute(configured)) return '';
    return abs;
  }
  if (fs.existsSync(path.join(PKG_ROOT, '.git'))) return PKG_ROOT;
  try {
    const profileRoot = path.resolve(PKG_ROOT, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(profileRoot, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const m = /^(?:file|link):(.+)$/.exec(String(deps[name] || ''));
    if (m) {
      const dir = path.resolve(profileRoot, m[1]);
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    }
  } catch { /* 猜不到就交给用户填 */ }
  return '';
}

/** 比版本号（0.4.0 / 0.3.10 这种）；a>b 返回正数。 */
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 上游分支名（origin/main 之类）。 */
function upstreamOf(dir) {
  const r = runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (r.ok && r.out) return r.out;
  const head = runGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out) return head.out;
  return 'origin/main';
}

/**
 * 查 GitHub 上有没有新版本（只 fetch + 比较，不动工作区）。
 * 返回 `{ ok, localVersion, remoteVersion, localHead, remoteHead, upstream, behind, upToDate, updateDir }`。
 */
export async function checkUpdate(opts = {}) {
  const target = path.resolve(opts.target || PKG_ROOT);
  const localVersion = versionOfDir(target);
  let dir;
  try {
    dir = opts.updateDir ? validateUpdateDir(opts.updateDir) : detectUpdateDir();
    if (dir) dir = validateUpdateDir(dir);
  } catch (err) {
    return { ok: false, localVersion, updateDir: '', error: String((err && err.message) || err) };
  }
  if (!dir) {
    return {
      ok: false,
      localVersion,
      updateDir: '',
      error: '找不到本插件的 git 源码目录 —— 在下面「更新源目录」里填一下（例如 D:\\plugins\\dsh-plugin-shop-accounts）',
    };
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { ok: false, localVersion, updateDir: dir, error: '更新源目录不是 git 仓库：' + dir };
  }
  const fetched = runGit(dir, ['fetch', '--prune', 'origin'], 45000);
  if (!fetched.ok) {
    return { ok: false, localVersion, updateDir: dir, error: 'git fetch 失败：' + (fetched.err || '未知原因') };
  }
  const upstream = upstreamOf(dir);
  const localHead = runGit(dir, ['rev-parse', '--short', 'HEAD']);
  const remoteHead = runGit(dir, ['rev-parse', '--short', upstream]);
  const behind = parseInt(runGit(dir, ['rev-list', '--count', `HEAD..${upstream}`]).out, 10) || 0;
  const ahead = parseInt(runGit(dir, ['rev-list', '--count', `${upstream}..HEAD`]).out, 10) || 0;
  const verOf = (ref) => {
    try { return String(JSON.parse(runGit(dir, ['show', `${ref}:package.json`]).out).version || ''); } catch { return ''; }
  };
  const sourceVersion = verOf('HEAD');
  const remoteVersion = verOf(upstream);
  // 「要不要更新」不能只看 git 落后几个提交：源码仓库可能领先 GitHub（本地已改未推），
  // 而真正跑着的是 profile 里那份**拷贝**（localVersion），它可能比源码还旧。
  const needsUpdate = behind > 0
    || cmpVersion(sourceVersion, localVersion) > 0
    || cmpVersion(remoteVersion, localVersion) > 0;
  return {
    ok: true,
    localVersion,
    sourceVersion,
    remoteVersion,
    localHead: localHead.out,
    remoteHead: remoteHead.out,
    upstream,
    behind,
    ahead,
    needsUpdate,
    upToDate: !needsUpdate,
    updateDir: dir,
  };
}

/**
 * 把源码目录里**已校验 commit** 的运行文件覆盖到目标目录。
 *
 * 为什么不再直接拷工作区（v0.8.3 修）：工作区可以被任何本机进程改脏，
 * 「更新」等于把未经验证的内容部署进插件目录（重启即执行）。
 * 现在先用 `git archive <ref>` 导出到一个临时目录，校验版本号与远端一致，再落盘。
 * 源码目录 == 目标时跳过。
 */
export function syncFromSource(dir, target = PKG_ROOT, opts = {}) {
  const dst = path.resolve(target);
  if (path.resolve(dir) === dst) return { copied: 0, target: dst, sameDir: true };
  const items = ['lib', 'test', 'package.json', 'README.md', 'CHANGELOG.md'];
  const ref = String(opts.ref || '').trim();
  const expectVersion = String(opts.expectVersion || '').trim();
  let srcRoot = dir;
  let stage = '';
  try {
    if (ref) {
      stage = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-sync-'));
      const tarball = path.join(stage, 'src.tar');
      const arch = runGit(dir, ['archive', '--format=tar', '-o', tarball, ref], 60000);
      if (!arch.ok) return { copied: 0, target: dst, sameDir: false, error: 'git archive 失败：' + (arch.err || '未知原因') };
      const ex = spawnSync('tar', ['-xf', tarball, '-C', stage], { windowsHide: true, timeout: 60000 });
      if (ex.status !== 0) {
        return { copied: 0, target: dst, sameDir: false, error: '解包 commit 内容失败：' + maskSecrets(String(ex.stderr || ex.error || '').trim()) };
      }
      srcRoot = stage;
      // 版本校验必须**无条件**成立：取不到版本（package.json 被删/没有 version）时不能"跳过校验照拷"，
      // 否则一个能改 commit 内容的人只要顺手删掉 package.json 就能绕过（2026-10-31 二次审查）。
      const stagedVersion = versionOfDir(stage);
      if (!expectVersion) {
        return { copied: 0, target: dst, sameDir: false, error: '上游 package.json 里没有 version，拒绝自动更新（无法校验版本）' };
      }
      if (!stagedVersion) {
        return { copied: 0, target: dst, sameDir: false, error: '这个 commit 里没有 package.json 的 version 字段，拒绝自动更新' };
      }
      if (stagedVersion !== expectVersion) {
        return {
          copied: 0, target: dst, sameDir: false,
          error: `commit 里的版本(${stagedVersion})和远端版本(${expectVersion})不一致，已中止（不覆盖工作目录）`,
        };
      }
    }
    let copied = 0;
    for (const item of items) {
      const src = path.join(srcRoot, item);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(dst, item), { recursive: true, force: true });
      copied += 1;
    }
    return { copied, target: dst, sameDir: false, sourceVersion: versionOfDir(srcRoot), fromCommit: Boolean(ref) };
  } catch (err) {
    return { copied: 0, target: dst, sameDir: false, error: maskSecrets(err && err.message ? err.message : String(err)) };
  } finally {
    if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 留给系统清理 */ } }
  }
}

/** 一键更新：快进合并 + 按已校验 commit 覆盖安装拷贝。返回最终状态（含 `updated` / `restartRequired`）。 */
export async function applyUpdate(opts = {}) {
  const target = path.resolve(opts.target || PKG_ROOT);
  const info = await checkUpdate(opts);
  if (!info.ok) return info;
  const dir = info.updateDir;
  if (!info.needsUpdate) {
    return { ...info, updated: false, copied: 0, restartRequired: false };
  }
  // 脏检查**无条件**做：以前只在 behind>0 时查，于是"源码已和远端同步但工作区被改过"会绕过检查，
  // 把未提交的内容当新版本部署（2026-10-31 安全审查）。
  const dirty = runGit(dir, ['status', '--porcelain']);
  if (!dirty.ok) return { ...info, ok: false, updated: false, error: '检查源码目录状态失败：' + (dirty.err || '未知原因') };
  if (dirty.out) {
    return { ...info, ok: false, updated: false, error: '源码目录里有未提交的改动，先处理干净再更新：' + dir };
  }
  let merged = false;
  if (info.behind > 0) {
    const m = runGit(dir, ['merge', '--ff-only', info.upstream], 60000);
    if (!m.ok) {
      return { ...info, ok: false, updated: false, error: '快进合并失败：' + (m.err || m.out || '未知原因') };
    }
    merged = true;
  }
  // 只部署「校验过的那个 commit」的内容，不碰工作区
  const pinned = runGit(dir, ['rev-parse', info.upstream]);
  if (!pinned.ok || !pinned.out) {
    return { ...info, ok: false, updated: false, error: '解析上游 commit 失败：' + (pinned.err || '未知原因') };
  }
  const synced = syncFromSource(dir, target, { ref: pinned.out, expectVersion: info.remoteVersion });
  if (synced.error) return { ...info, ok: false, updated: false, error: synced.error };
  // 拷贝已经把新的 package.json 落进安装目录了，重读才拿得到「更新后」的版本号；
  // 合并之后的 head/behind 也顺手重算，别把合并前的旧值回给界面。
  const afterVersion = versionOfDir(target);
  const afterHead = runGit(dir, ['rev-parse', '--short', 'HEAD']).out;
  const behindAfter = parseInt(runGit(dir, ['rev-list', '--count', `HEAD..${info.upstream}`]).out, 10) || 0;
  return {
    ...info,
    updated: true,
    merged,
    localHead: afterHead || info.localHead,
    behind: behindAfter,
    needsUpdate: false,
    upToDate: true,
    ...synced,
    localVersion: afterVersion || info.sourceVersion || info.localVersion,
    restartRequired: synced.copied > 0,
  };
}

// ── 账号表（读写的一层薄封装）───────────────────────────────────────────────

function loadAccounts() { return readAccounts().accounts; }
function saveAccounts(list) { return writeAccounts(list); }

function findAccount(id) {
  // 账号 id 只可能是插件自己生成的形状；坏 id（含 `/`、`..` 之类）一律当"不存在"，
  // 不让它有机会参与后面的路径拼接。
  if (!validAccountId(id)) return null;
  return loadAccounts().find((a) => a.id === id) || null;
}

function patchAccount(id, patch) {
  const list = loadAccounts();
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, id: list[i].id, updatedAt: new Date().toISOString() };
  saveAccounts(list);
  return list[i];
}

// ── 登录账号查重（v0.10.1）──────────────────────────────────────────────────
// 登录账号唯一性：同一个平台 + 同一个账号 = 同一个人，建两条只会让「代填哪个密码、采集算谁的」对不上。
// 比较前先做 NFC 归一化，
// 这里多折叠一次大小写 —— 手机号/邮箱大小写不同是同一个账号，正是最容易重复建号的情形。

function loginNameKey(value) {
  return String(value == null ? '' : value).normalize('NFC').trim().toLowerCase();
}

/** 在给定列表里找同平台 + 同登录账号的记录（excludeId 用于编辑时排除自己）；空账号不参与查重。 */
function findDuplicateInList(list, platform, loginName, excludeId) {
  const key = loginNameKey(loginName);
  if (!key) return null;
  return (list || []).find(
    (a) => a.id !== excludeId && a.platform === platform && loginNameKey(a.loginName) === key,
  ) || null;
}

function findDuplicateLoginName(platform, loginName, excludeId) {
  return findDuplicateInList(loadAccounts(), platform, loginName, excludeId);
}

// ── 店铺配置导出 / 导入（v0.10.1）───────────────────────────────────────────
// 目的：换机器（尤其 Windows → mac）时不用一条条重填。**只搬配置，不搬秘密**：
// 密码永不出现在导出文件里（它在密码库/钥匙串里、且被本机密钥绑定，搬过去也解不开），
// 登录态（浏览器档案、cookie 罐）、端口、运行时状态同样不进包 —— 这些都是"这台机器上的东西"。

const EXPORT_FORMAT = 'dsh-shop-accounts/stores';
const EXPORT_VERSION = 1;
const EXPORT_MAX_ACCOUNTS = 500;

function exportStores() {
  const accounts = loadAccounts().map((a) => ({
    platform: a.platform,
    accountType: a.accountType || 'seller',
    name: String(a.name || '').trim(),
    url: String(a.url || '').trim(),
    loginName: String(a.loginName || '').trim(),
    note: String(a.note || ''),
    egoProfile: String(a.egoProfile || ''),
    collection: a.collection || null,
  }));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    pluginVersion: ownVersion(),
    count: accounts.length,
    // 明确写在文件里，免得以后有人以为"导出漏了密码"是 bug：
    note: '本文件只含店铺配置，不含密码与登录态；在新机器导入后请在每家的详情页重新设置密码。',
    accounts,
  };
}

/**
 * 导入店铺配置。逐条校验、能建就建、建不了就跳过并说明原因 —— 一次导入里有一条坏数据，
 * 不该把好的那些也一起废掉。
 * @returns {{imported:number, skipped:Array<{name:string,reason:string}>, accounts:Array<object>}}
 */
function importStores(payload) {
  const raw = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.accounts) ? payload.accounts : null);
  if (!raw) throw new Error(`导入文件里没有 accounts 数组（应该是本插件「导出店铺配置」生成的 ${EXPORT_FORMAT} 文件）`);
  if (raw.length > EXPORT_MAX_ACCOUNTS) throw new Error(`一次最多导入 ${EXPORT_MAX_ACCOUNTS} 条，这个文件里有 ${raw.length} 条`);

  const cfg = readConfig();
  const egoMode = backendFor(cfg) === 'egolite';
  const next = loadAccounts().slice();
  const imported = [];
  const skipped = [];

  for (const item of raw) {
    const obj = item && typeof item === 'object' ? item : {};
    const platform = platformOf(String(obj.platform || ''));
    const loginName = String(obj.loginName || '').trim();
    const label = capStr(String(obj.name || '').trim(), 80) || loginName || '(未命名)';
    if (!platform) {
      skipped.push({ name: label, reason: `平台「${String(obj.platform || '')}」不认识` });
      continue;
    }
    if (!loginName) {
      skipped.push({ name: label, reason: '缺登录账号（导出文件里 loginName 为空，无法对应到人）' });
      continue;
    }
    if (findDuplicateInList(next, platform.id, loginName, '')) {
      skipped.push({ name: label, reason: `${platform.label} 上已有同一登录账号「${loginName}」的记录` });
      continue;
    }
    let collection = null;
    try { collection = normalizeCollection(obj.collection || {}, {}, { allow: allowedDomains(platform.id) }); } catch { collection = { enabled: false, domains: [], time: '09:00' }; }
    // URL 走同一个白名单（只收 http/https）：导入的文件是外部输入，不能直接进 Chrome 命令行。
    let url = '';
    try { url = String(obj.url || '').trim() ? safeNavUrl(obj.url) : ''; } catch { url = ''; }
    let egoProfile = '';
    try { egoProfile = normalizeEgoProfileId(obj.egoProfile); } catch { egoProfile = ''; }

    let name = label;
    // ego 后端下店铺名就是 TaskSpace 名，重名会串台 —— 自动往后排号而不是整条丢掉。
    if (egoMode) {
      let seq = 2;
      const base = name;
      while (next.some((a) => String(a.name || '').trim() === name)) {
        name = `${base} (${seq})`;
        seq += 1;
        if (seq > 99) break;
      }
    }
    const id = newAccountId(platform.id);
    const account = {
      id,
      platform: platform.id,
      name,
      note: String(obj.note || '').trim(),
      url,
      loginName,
      accountType: normalizeAccountType(obj.accountType),
      collection,
      // 档案目录一律本机重新派生：导出包里的路径是另一台机器的，不能拿来做路径拼接。
      profileDir: profileDirFor(id, cfg),
      port: 0,
      egoProfile,
      egoSpace: '',
      imported: false,
      pendingLogin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCheck: null,
      lastCheckAt: null,
      lastLoginAt: null,
    };
    next.push(account);
    imported.push({ id, name, platform: platform.id, platformLabel: platform.label, loginName });
  }

  if (imported.length) saveAccounts(next);
  return { imported: imported.length, skipped, accounts: imported };
}

/** 档案目录：优先用账号上记的（可能是"导入已有目录"），否则按 id 推。 */
function accountProfileDir(account, cfg) {
  if (account && account.profileDir && String(account.profileDir).trim()) return String(account.profileDir);
  return profileDirFor(account.id, cfg);
}

/**
 * **可被递归删除**的档案目录：必须同时满足
 *   · 在档案根目录之内（`isInsideProfileRoot`，含 realpath 解 junction）；
 *   · 目录名正好是这个账号的 id（插件自己派生的形状 `<root>/<id>`）。
 *
 * 只判"在根目录下"不够：`profileRoot` 本身能被 `PUT /config` 改，攻击者把根设成
 * `C:\Users\<某人>` 就能删同级目录；加上"名字必须是账号 id"之后，可删的目标只剩
 * `profiles/acc_xxx` 这一种形状，误删/滥用都没有落脚点。
 */
function deletableProfileDir(account, cfg) {
  if (!account || !account.id) return null;
  const dir = accountProfileDir(account, cfg);
  if (!isInsideProfileRoot(dir, cfg)) return null;
  let base = '';
  try { base = path.basename(path.resolve(dir)); } catch { return null; }
  if (base.toLowerCase() !== String(account.id).toLowerCase()) return null;
  return dir;
}

/**
 * 档案根目录的写入校验：必须是绝对路径，且不能是盘根/家目录/系统目录/程序目录。
 * 它是删除动作的信任锚之一，不能由接口随便指到危险位置（2026-10-31 二次审查）。
 */
function normalizeProfileRoot(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (!path.isAbsolute(s)) throw new Error('档案根目录必须是绝对路径：' + s);
  const abs = path.resolve(s);
  const norm = (p) => String(p || '').toLowerCase().replace(/[\\/]+$/, '');
  const root = path.parse(abs).root;
  if (norm(abs) === norm(root)) throw new Error('档案根目录不能是盘符根目录：' + abs);
  // 用户主目录本身不行（但**主目录里面**可以：很多人把档案放在 ~/shop-profiles）
  if (norm(abs) === norm(os.homedir())) throw new Error('档案根目录不能是用户主目录：' + abs);
  // 系统/程序目录（含其子目录）不行：那里不该写浏览器档案
  const systemDirs = [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter(Boolean).map(norm);
  if (systemDirs.some((d) => norm(abs) === d || norm(abs).startsWith(d + '\\'))) {
    throw new Error('档案根目录不能放在系统/程序目录里：' + abs);
  }
  return abs;
}

/** 可选目录配置（如 ego User Data）：留空表示"自动探测"；非空必须是已存在的目录。 */
function normalizeOptionalDir(value, label) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (!path.isAbsolute(s)) throw new Error(label + '必须是绝对路径：' + s);
  const abs = path.resolve(s);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(label + '不存在：' + abs); }
  if (!st.isDirectory()) throw new Error(label + '不是文件夹：' + abs);
  return abs;
}

/**
 * 反 DNS rebinding 用的 Host 白名单：只接受
 *   · localhost / localhost.；
 *   · IP 字面量（127.0.0.1、127.1、10.0.0.5、[::1]、[fe80::1%eth0]）；
 *   · 本机主机名（含 .local/.lan，方便用 `my-pc:43120` 打开）。
 * 域名（rebinding 后浏览器发来的 Host）一律不行。
 */
function hostHeaderAllowed(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return false;
  let host = raw;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return false;
    host = raw.slice(0, close + 1);
  } else {
    const last = raw.lastIndexOf(':');
    if (last >= 0 && /^\d+$/.test(raw.slice(last + 1))) host = raw.slice(0, last);
  }
  host = host.replace(/\.$/, '');
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){0,3}$/.test(host)) return true;
  if (/^\[[0-9a-f:.%a-z0-9]+\]$/i.test(host)) return true;
  const me = String(os.hostname() || '').toLowerCase();
  if (me && (host === me || host === me + '.local' || host === me + '.lan')) return true;
  return false;
}
/**
 * 可执行文件路径的写入校验：必须是绝对路径、存在，且文件名要在已知程序名里。
 * 这些路径会被 `spawn`，虽然"用户自己选 Chrome/ego 路径"是功能，但不该允许指向任意 exe
 * （`chrome-evil.exe` / `not-ego.exe` 这种前缀/子串骗法也要挡掉）。
 */
function normalizeExePath(value, kind) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const label = kind === 'ego' ? 'ego 程序' : '浏览器';
  if (!path.isAbsolute(s)) throw new Error(label + '路径必须是绝对路径：' + s);
  if (!fs.existsSync(s)) throw new Error(label + '路径不存在：' + s);
  const base = path.basename(s).toLowerCase();
  const ok = kind === 'ego'
    ? osPlatform.isEgoExecutable(base)
    : osPlatform.isBrowserExecutable(base);  if (!ok) throw new Error('这个文件名不在可用的' + label + '名单里：' + base);
  return s;
}

/**
 * 更新源目录的校验：必须是绝对路径、存在、是 git 仓库，且**仓库根 package.json 的 name 是本插件**。
 * 不加这条，`updateDir` 指向任意仓库时 `applyUpdate()` 会把它的 `lib/` 覆盖进插件安装目录
 * （只要版本号比当前大），等于任意代码执行（2026-10-31 二次审查）。
 */
function validateUpdateDir(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (!path.isAbsolute(raw)) throw new Error('更新源目录必须是绝对路径：' + raw);
  const abs = path.resolve(raw);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('更新源目录不存在：' + abs); }
  if (!st.isDirectory()) throw new Error('更新源目录不是文件夹：' + abs);
  if (!fs.existsSync(path.join(abs, '.git'))) throw new Error('更新源目录不是 git 仓库：' + abs);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')); } catch {
    throw new Error('更新源目录里读不到 package.json：' + abs);
  }
  if (String(pkg && pkg.name) !== 'dsh-plugin-shop-accounts') {
    throw new Error('更新源目录不是本插件的仓库（package.json name=' + String(pkg && pkg.name) + '）：' + abs);
  }
  // Windows 路径大小写不敏感；macOS 大小写敏感卷上大小写是有意义的，不能先折成小写再比
  const fold = osPlatform.id === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const norm = (p) => fold(String(p || '').replace(/[\\/]+$/, ''));
  const sysDirs = osPlatform.systemDirs().filter(Boolean).map(norm);
  if (sysDirs.some((d) => norm(abs) === d || norm(abs).startsWith(d + path.sep))) {
    throw new Error('更新源目录不能放在系统/程序目录里：' + abs);
  }
  return abs;
}

// ── ego lite 后端 ───────────────────────────────────────────────────────────
//
// 为什么有这一层：ego lite 天生「多 profile + TaskSpace」，登录态按 profile 隔离，
// 而且窗口对人和 agent 都友好 —— 装了 ego 就优先用它，没有才回退 Chrome
// （配置 `browser: auto|egolite|chrome`，auto = 装了 ego 就用 ego）。
//
// 对应关系：**一个店铺 = 一个 ego profile + 一个 TaskSpace**。
//   · profile 是登录态隔离的单位（相当于 Chrome 的 user-data-dir）；
//   · TaskSpace 是这个店铺的工作窗口（相当于"那个店铺的 Chrome 窗口"），关掉不丢登录态。
// ego 的 SDK 只能「列出/使用」已有 profile，不能新建 —— 所以新增店铺时如果 profile 用完了，
// 会明确报错让用户先在 ego 里建一个（或在设置里换回 Chrome）。

let egoInfoCache = { at: 0, data: null, pending: null };
const EGO_INFO_TTL = 30000;

function egoInfoStale() { return !egoInfoCache.at || Date.now() - egoInfoCache.at > EGO_INFO_TTL; }

/**
 * 读 ego 的 profile / TaskSpace 列表（带缓存；一次调用要起一次 ego CLI，别每次轮询都打）。
 * **ego 没在跑的时候绝不去起 CLI** —— 那会把整个浏览器拉起来（实测 5.7s、恢复几十个标签、3GB），
 * 用户明明关掉了 ego，一开面板又冒出来。没开就如实报 `running:false`。
 */
async function refreshEgoInfo(force) {
  if (egoInfoCache.pending) return egoInfoCache.pending;
  if (!force && !egoInfoStale() && egoInfoCache.data) return egoInfoCache.data;
  const cfg = readConfig();
  const st = egoStatus(cfg);
  if (!st.available) {
    egoInfoCache = { at: Date.now(), data: { available: false, running: false, cli: '', app: '', backend: 'chrome', profiles: [], spaces: [], error: '' } };
    return egoInfoCache.data;
  }
  egoInfoCache.pending = (async () => {
    const appRunning = await egoAppRunning().catch(() => true);
    if (!appRunning) {
      const data = {
        available: true, running: false, cli: st.cli, app: st.app, backend: backendFor(cfg),
        profiles: [], spaces: [], error: 'ego lite 没在运行',
      };
      egoInfoCache = { at: Date.now(), data };
      return data;
    }
    const r = await egoList({ egoliteCli: cfg.egoliteCli, timeoutMs: 60000 });
    const notRunning = Boolean(r && r.code === 'ego_not_running');
    const data = {
      available: true,
      running: !notRunning,
      cli: st.cli,
      app: st.app,
      backend: backendFor(cfg),
      profiles: (r && r.profiles) || [],
      spaces: (r && r.spaces) || [],
      error: r && r.ok === false ? String(r.error || '') : '',
    };
    egoInfoCache = { at: Date.now(), data };
    return data;
  })().finally(() => { egoInfoCache.pending = null; });
  return egoInfoCache.pending;
}

/** 同步拿一份（可能为空）—— 界面渲染用，不阻塞。 */
function egoInfoSync() {
  if (egoInfoCache.data) return egoInfoCache.data;
  const st = egoStatus(readConfig());
  return { available: st.available, running: false, cli: st.cli, app: st.app, backend: backendFor(readConfig()), profiles: [], spaces: [], error: '' };
}

function egoSpaceName(account) { return spaceNameFor(account); }

/**
 * 这个店铺的空间是不是开着（ego 里真有这个窗口）。
 * 先按名字认；名字被用户改过就按记下来的 id 认（id 为 0 是 ego 里用户自己建的空间，不算）。
 */
function egoSpaceExists(space, spaceId) {
  const name = String(space || '').trim();
  const spaces = (egoInfoCache.data && egoInfoCache.data.spaces) || [];
  if (name && spaces.some((s) => s && s.name === name)) return true;
  const id = Number(spaceId) || 0;
  if (id > 0) return spaces.some((s) => s && s.id && Number(s.id) === id);
  return false;
}

/**
 * ego 模式下「店铺名 = 空间名」，同名就会落到同一个窗口、登录态串台。
 * 新增/改名时挡过一次（v0.8.0），但 Chrome 模式下可以建同名店、之后再切到 ego，
 * 所以每个 ego 动作前再挡一次（v0.8.3）。
 */
function assertEgoSpaceUnique(account) {
  const space = spaceNameFor(account);
  const sameSpace = loadAccounts().find((a) => a.id !== account.id && spaceNameFor(a) === space);
  if (sameSpace) {
    throw new Error(
      `有另一个店铺（${sameSpace.name || sameSpace.id}）和「${account.name || account.id}」用了同一个 ego 空间名「${space}」。` +
      'ego 模式下一个空间只能对应一个店铺，请先给其中一个改名，否则两家的登录态会串在一起。',
    );
  }
}

// ── 每个店铺一把锁 ──────────────────────────────────────────────────────────
// 同一个店铺可能同时被「定时检测」和用户点「检测 / 打开 / 完成」撞上：两个 ego CLI 会同时对同一个
// 空间 takeOver / finish，轻则来回抢控制权，重则把用户正在用的窗口收掉。按账号串行化。
const accountLocks = new Map();

function accountBusy(id) { return accountLocks.has(String(id)); }

/**
 * 拿这把锁执行 fn。`wait:false` 时如果锁被占就立刻返回 `{ busy:true }`（定时检测用：
 * 宁可这一轮跳过，也不要排在用户手动操作后面把窗口再抢一遍）。
 */
async function withAccountLock(id, fn, opts = {}) {
  const release = await acquireAccountLock(id, opts);
  if (!release) return { busy: true, skipped: true };
  try { return await fn(); } finally { release(); }
}

/**
 * 手动取锁（路由层用：一整个动作里有多个 return 点，用 try/finally 最省事）。
 * 锁被占时：`wait:false` 立刻返回 null；默认排队等前一个动作做完。
 */
async function acquireAccountLock(id, opts = {}) {
  const key = String(id);
  // 循环抢：被占用就等它放，醒来后**重新检查**再抢。
  // （不能只 await 一次就往下走 —— 两个等待者会同时被唤醒，后一个必须在重新检查时看到前一个的锁。）
  for (;;) {
    const cur = accountLocks.get(key);
    if (!cur) break;
    if (opts.wait === false) return null;
    await cur.catch(() => {});
  }
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  accountLocks.set(key, gate);
  return () => {
    if (accountLocks.get(key) === gate) accountLocks.delete(key);
    release();
  };
}

function domainsOverlap(a, b) {
  const la = (a || []).map((x) => String(x).toLowerCase());
  const lb = (b || []).map((x) => String(x).toLowerCase());
  return la.some((d) => lb.some((e) => d === e || d.endsWith('.' + e) || e.endsWith('.' + d)));
}

/**
 * 这个店铺该用哪个 ego profile。
 *   · 账号上已经记了 → 就用它（用户可以在界面/接口里手动指定）；
 *   · 没记 → 挑一个"没被别的店铺占用"的 profile，写回账号（下次就不再挑）；
 *   · 全被占了 → 找 cookie 域不重叠的店铺共用一个（淘宝/天猫/1688 会打架，拼多多/抖音不会）；
 *   · 都不行 → 明确报错（ego 的 SDK 不能新建 profile，只能人去建）。
 */
async function ensureEgoProfile(account, opts = {}) {
  const explicit = String(account.egoProfile || '').trim();
  // 记着的 profile 不一定还活着：用户在 ego 里删过/重建过 profile，这里就得自愈，
  // 否则那个店铺永远打开失败、还只能去改配置（v0.8.0 修）。
  let info = await refreshEgoInfo(explicit ? true : false);
  if (!info || info.available === false) throw new Error('没有可用的 ego lite（找不到 ego-browser CLI）');
  if (info.running === false) {
    // 「打开 / 重置」是用户明确要开窗口的动作，允许顺手把 ego 拉起来（和 ego.mjs 的 LAUNCH_ALLOWED 一致）；
    // 只读动作（检测 / 关闭 / 列状态）绝不拉起浏览器（v0.8.1 修：之前这两个动作到不了白名单，直接报错）。
    if (!opts.launch) {
      throw new Error(String(info.error || 'ego lite 没在运行') + ' —— 先在 ego 里打开它，或点「启动 ego」');
    }
    const started = await ensureEgoApp(readConfig());
    if (started.ok === false) throw new Error(String(started.error || 'ego lite 没在运行') + ' —— 也可以手动打开 ego lite 再试');
    info = await refreshEgoInfo(true);
    if (!info || info.running === false) throw new Error('ego lite 启动了但读不到它的 profile 列表 —— 稍后再试一次');
  }
  const profiles = (info && info.profiles) || [];
  if (explicit) {
    if (profiles.some((p) => p && String(p.id) === explicit)) return explicit;
    // 记的那个已经不存在了：清掉，往下重新分配
    appendDebug('ego-profile-gone', { account: account.id, egoProfile: explicit });
    patchAccount(account.id, { egoProfile: '', egoSharedProfile: false });
    account = findAccount(account.id) || account;
  }
  if (!profiles.length) {
    throw new Error('ego 里还没有任何浏览器 profile —— 先在 ego 窗口里新建一个「用户配置」，再回来打开这个店铺');
  }
  const platform = platformOf(account.platform);
  const others = loadAccounts().filter((a) => a.id !== account.id && String(a.egoProfile || '').trim());
  const used = new Set(others.map((a) => String(a.egoProfile)));
  const free = profiles.filter((p) => !used.has(p.id));
  const pickFree = free.find((p) => !p.isDefault) || free[0];
  if (pickFree) {
    patchAccount(account.id, { egoProfile: pickFree.id });
    return pickFree.id;
  }
  // 没空闲的：允许和「cookie 域不重叠」的店铺共用一个 profile
  for (const other of others) {
    const otherPlatform = platformOf(other.platform);
    if (!domainsOverlap(platform && platform.cookieDomains, otherPlatform && otherPlatform.cookieDomains)) {
      patchAccount(account.id, { egoProfile: String(other.egoProfile), egoSharedProfile: true });
      return String(other.egoProfile);
    }
  }
  throw new Error(
    `ego 里的 ${profiles.length} 个 profile 都被别的店铺占用了，而且剩下的都不能安全共用（同一平台的 cookie 会串号）。` +
    '请先在 ego 里新建一个「用户配置」给这个店铺，或者在「浏览器设置」里把后端切回 chrome。',
  );
}

/**
 * 用户明确要开窗口的动作（打开 / 重置）可以把 ego 主程序拉起来。
 * 只读动作不许调用这里 —— 拉起来会把上次所有窗口一起恢复（实测 5.7s / 30 进程 / 3GB）。
 */
async function ensureEgoApp(cfg) {
  if (await egoAppRunning().catch(() => true)) return { ok: true, launched: false };
  const r = await egoLaunchApp(cfg && cfg.egoliteApp);
  if (r && r.ok === false) return { ok: false, error: r.error || '启动 ego lite 失败' };
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    egoAppRunningInvalidate();
    if (await egoAppRunning().catch(() => true)) return { ok: true, launched: true };
  }
  return { ok: false, error: 'ego lite 启动了但 12 秒内没就绪' };
}

/** 一个店铺跑 ego 动作需要的三样东西。 */
async function egoRunInfo(account, opts = {}) {
  const platform = platformOf(account.platform);
  if (!platform) throw new Error(`未知平台 ${account.platform}`);
  assertEgoSpaceUnique(account);
  const profileId = await ensureEgoProfile(account, opts);
  return { platform, profileId, space: egoSpaceName(account), cfg: readConfig() };
}

/** ego 后端的「打开」：建/复用 TaskSpace，把页面导到工作台或登录页。 */
async function egoOpenAccount(account, mode) {
  const { platform, profileId, space, cfg } = await egoRunInfo(account, { launch: true });
  const shopUrl = String(account.url || '').trim();
  const workUrl = shopUrl || platform.workUrl || platform.homeUrl;
  const urls = mode === 'login'
    ? [platform.loginUrl]
    : [workUrl].concat(cfg.openWorkTab && workUrl !== platform.homeUrl ? [platform.homeUrl] : []);
  const r = await egoOpen({ space, spaceId: account.egoSpaceId || 0, profileId, urls }, { egoliteCli: cfg.egoliteCli, timeoutMs: 120000 });
  if (r.ok === false) {
    // 「控制权在用户手里」不是故障，是 ego 新版的硬停策略 —— 直接把人话讲清楚，别把 ego 的英文原文抛给用户
    if (r.code === 'ego_user_in_control') throw new Error(r.error || 'ego 打开失败：这个窗口归你控制');
    throw new Error('ego 打开失败：' + (r.error || '未知原因'));
  }
  const st = egoStatus(cfg);
  patchAccount(account.id, {
    egoProfile: profileId,
    egoSpace: r.space || space,
    egoSpaceId: Number(r.spaceId) || 0,
    lastOpenAt: new Date().toISOString(),
    ...(mode === 'login' ? { pendingLogin: true } : {}),
  });
  setRuntime(account.id, { egoSpace: r.space || space, egoProfile: profileId, port: 0, pid: 0 });
  egoAppRunningInvalidate();
  refreshEgoInfo(true).catch(() => {});
  return {
    backend: 'egolite', port: 0, pid: 0, cdpUrl: '', profileDir: '',
    space: r.space || space, profileId, spaceId: r.spaceId || null, url: r.url || '', navErrors: r.navErrors || [],
    reused: !r.created, mode, browser: st.app || st.cli || 'ego lite', urls,
    ...(r.alternativeName
      ? { note: '原来那个窗口归你控制（ego 里任务已结束），已新开窗口「' + r.alternativeName + '」，登录态是同一份。' }
      : {}),
    ...(r.handOffError ? { handOffError: r.handOffError } : {}),
  };
}

/**
 * ego 后端的登录态检测：**另开一个临时空间**（同 profile）读 cookie，读完立刻收掉。
 *
 * 为什么不在用户那个开着的窗口里读：交给用户控制之后 ego 会把 agent 的浏览器命令硬停，
 * 想读就得 takeOver —— 那等于用户正在用的时候把控制权抢过来（界面闪「agent 调试中」、输入被打断）。
 * 实测同一个 profile 可以同时开两个 TaskSpace、cookie 罐是同一份，所以另开一个读完全等价，
 * 而且「店铺窗口开着」再也不会妨碍定时检测（v0.7.1 那个"开着的店铺被永久跳过"就是这么来的）。
 */
async function egoCheckAccount(account, opts = {}) {
  const cfg = readConfig();
  const platform = platformOf(account.platform);
  const checkedAt = new Date().toISOString();
  // 同名店铺在 ego 里会落到同一个空间/窗口 —— 检测前先挡，别把别家的登录态当自己的。
  try { assertEgoSpaceUnique(account); } catch (err) {
    return {
      ok: false, loggedIn: false, evidence: 'none', backend: 'egolite', running: false, stale: false, checkedAt,
      space: egoSpaceName(account), profileId: '', reason: String((err && err.message) || err),
    };
  }
  const space = egoSpaceName(account);
  let profileId = '';
  try { profileId = normalizeEgoProfileId(account.egoProfile); } catch (err) {
    return {
      ok: false, loggedIn: false, evidence: 'none', backend: 'egolite', running: false, stale: false, checkedAt,
      space, profileId: '', reason: '这个店铺记着的 ego profile 名称不合法：' + String((err && err.message) || err),
    };
  }
  // 记着的 profile 可能已经被用户在 ego 里删了：没在列表里就清掉，让下次「打开」重新分配，
  // 否则 Chrome 会用 --profile-directory 自动新建一个同名 profile，污染 ego 的 profile 列表。
  if (profileId) {
    const info = await refreshEgoInfo(false).catch(() => null);
    const profiles = (info && info.profiles) || [];
    if (profiles.length && !profiles.some((p) => p && String(p.id) === profileId)) {
      patchAccount(account.id, { egoProfile: '', egoSharedProfile: false });
      profileId = '';
      account = findAccount(account.id) || account;
    }
  }
  if (!profileId) {
    return {
      ok: true, loggedIn: false, evidence: 'none', backend: 'egolite', running: false, stale: false, checkedAt,
      space, profileId: '', reason: '这个店铺还没分配 ego profile —— 点「打开」让插件分配一个，然后在弹出的窗口里登录',
    };
  }
  // ego 关着**不再等于**"没法检测"：用同一份 User Data 起一个无窗口实例，后台读 cookie（v0.8.2）。
  // 不弹窗、不恢复上次的窗口，用户不需要先把 ego 打开 —— 这才是"后台检测"。
  if (!(await egoAppRunning().catch(() => true))) {
    const off = await egoOfflineCookies({
      profileId,
      domains: platform && platform.cookieDomains,
      appConfigured: cfg.egoliteApp,
      userDataConfigured: cfg.egoliteUserData,
    });
    if (off.ok) {
      const cookies = off.cookies;
      const judged = judgeLogin(cookies, '', platform, { cookieReadOk: true });
      const out = {
        ...judged, backend: 'egolite', space, profileId, running: false, headless: true,
        url: '', cookieCount: cookies.length, tokenExpiry: tokenExpiryOf(cookies, platform), checkedAt,
        elMs: off.elMs,
      };
      if (out.loggedIn === false && !cookies.length) {
        out.reason = '后台读到 0 个该平台的 cookie —— 可能还没登录过，或档案里没有这个平台的登录';
      }
      return out;
    }
    return {
      ok: false, loggedIn: false, evidence: 'none', backend: 'egolite', running: false, stale: false, checkedAt,
      space, profileId, code: off.code || '',
      reason: '后台检测没成功：' + (off.error || '未知原因'),
    };
  }
  // ego 开着：另开一个临时空间读 cookie（能顺带拿到当前页 URL，判登录页更准）
  const tempSpace = '检测-' + (account.id || 'shop');
  const r = await egoProbe({ space, spaceId: account.egoSpaceId || 0, profileId, url: platform.homeUrl, domains: platform.cookieDomains, tempSpace }, { egoliteCli: cfg.egoliteCli, timeoutMs: 120000 });
  if (r.ok === false) {
    const notRunning = r.code === 'ego_not_running';
    return {
      ok: false, loggedIn: false, evidence: 'none', backend: 'egolite', running: false, stale: false, checkedAt,
      space, profileId, code: r.code || '',
      reason: notRunning ? 'ego lite 没在运行（不会为了检测把整个浏览器拉起来）：点「启动 ego」或点店铺的「打开」' : 'ego 检测失败：' + (r.error || '未知原因'),
    };
  }
  const cookies = Array.isArray(r.cookies) ? r.cookies : [];
  const judged = judgeLogin(cookies, r.url || '', platform, { cookieReadOk: !r.cookieError });
  const tokenExpiry = tokenExpiryOf(cookies, platform);
  const out = {
    ...judged, backend: 'egolite', space, profileId, running: egoSpaceExists(space, account.egoSpaceId),
    url: r.url || '', cookieCount: cookies.length, tokenExpiry, checkedAt, probeSpace: r.temp || tempSpace,
    ...(r.cookieError ? { cookieError: String(r.cookieError) } : {}),
  };
  if (out.loggedIn === false && out.evidence === 'login-page') {
    out.reason = account.lastLoginAt ? '登录已失效，请重新登录' : '未登录，请前往登录页登录';
  }
  refreshEgoInfo(true).catch(() => {});
  return out;
}

/** ego 后端的「关闭」：收掉 TaskSpace（登录态留在 profile 里，不丢）。 */
async function egoCloseAccount(account, opts = {}) {
  const cfg = readConfig();
  const space = egoSpaceName(account);
  const r = await egoClose({ space, spaceId: account.egoSpaceId || 0 }, { egoliteCli: cfg.egoliteCli, timeoutMs: 90000 });
  if (opts.clearPending !== false) patchAccount(account.id, { pendingLogin: false });
  setRuntime(account.id, null);
  refreshEgoInfo(true).catch(() => {});
  return {
    closed: r.ok !== false, closedBy: 'ego', backend: 'egolite', space,
    alreadyClosed: Boolean(r.alreadyClosed || r.appNotRunning),
    ...(r.ok === false ? { error: String(r.error || '') } : {}),
  };
}

/**
 * ego 后端的「清空重登」：只清这个店铺**平台域名下的** cookie，再回登录页。
 * 为什么不整仓清：profile 不够时插件允许两个不同平台的店铺共用一个 profile（egoSharedProfile），
 * 整仓清会把同 profile 的另一个店铺也登出（v0.8.0 修）。
 */
async function egoResetAccount(account) {
  const { platform, profileId, space, cfg } = await egoRunInfo(account, { launch: true });
  const r = await egoReset({ space, spaceId: account.egoSpaceId || 0, profileId, url: platform.loginUrl, domains: platform.cookieDomains }, { egoliteCli: cfg.egoliteCli, timeoutMs: 120000 });
  if (r.ok === false) return { ok: false, backend: 'egolite', space, profileId, error: 'ego 重置失败：' + (r.error || '未知原因') };
  patchAccount(account.id, {
    egoProfile: profileId, egoSpace: r.space || space, egoSpaceId: Number(r.spaceId) || account.egoSpaceId || 0, port: 0,
    // 部分清掉时不抹掉上一次的检测结论：档案里可能还留着没删掉的 cookie，
    // 直接写"未登录"会让界面与真实档案状态不一致。
    ...(r.partial ? {} : { lastCheck: null, lastCheckAt: null, lastLoginAt: null }),
    pendingLogin: true,
  });
  egoAppRunningInvalidate();
  refreshEgoInfo(true).catch(() => {});
  return {
    ok: true, backend: 'egolite', space, profileId,
    cleared: Number(r.cleared) > 0 ? Number(r.cleared) : 0,
    wholeJar: Boolean(r.wholeJar), wholeJarSkipped: Boolean(r.wholeJarSkipped),
    clearError: r.clearError || null, url: r.url || '',
  };
}

/**
 * ego 后端的「完成并保存」：验一次登录 → 存状态。
 *
 * **故意不关 TaskSpace**（v0.7.1 起）：ego 的空间是独立窗口，留着不影响用户正常用浏览器，
 * 关掉再重开只会让登录态多一次「落盘 → 读回」的机会，没有必要（那套 `关闭→复核` 是 Chrome 时代
 * 为了确认会话级 cookie 真的写进档案才加的）。想收掉窗口请显式点「关闭」。
 */
async function egoFinishAccount(account) {
  const check = await egoCheckAccount(account, { silent: true });
  const patch = checkPatch(check);
  if (check.loggedIn) { patch.pendingLogin = false; }
  patchAccount(account.id, patch);
  appendDebug('finish', { account: account.id, platform: account.platform, backend: 'egolite', saved: Boolean(check.loggedIn), closed: false, keptSpace: true, result: { loggedIn: check.loggedIn, evidence: check.evidence, url: check.url, cookieCount: check.cookieCount } });
  refreshEgoInfo(true).catch(() => {});
  if (!check.loggedIn) {
    return { ok: true, saved: false, check, closed: false, keptSpace: true, backend: 'egolite', reason: check.reason || '还没登录成功，先在那个窗口里把登录走完再点保存' };
  }
  return { ok: true, saved: true, check, closed: false, keptSpace: true, backend: 'egolite', space: egoSpaceName(account) };
}

/**
 * 把一次检测结果变成要写回账号的 patch。
 *
 * **检测失败（ok:false）不覆盖上一次的结论**：ego 没在跑、CLI 超时、无头 Chrome 起不来都会返回
 * `ok:false, loggedIn:false`，直接写进 lastCheck 会让界面把「这次没测成」显示成「登录已失效」，
 * 真实登录态被一次偶发失败抹掉，用户被迫重扫码（v0.8.1 修）。失败只记 lastCheckError。
 */
function checkPatch(check, at = new Date().toISOString()) {
  if (check && check.ok === false) {
    return { lastCheckAt: at, lastCheckError: String(check.reason || check.error || '检测失败') };
  }
  return {
    lastCheck: check,
    lastCheckAt: at,
    lastCheckError: '',
    ...(check && check.loggedIn ? { lastLoginAt: at } : {}),
  };
}

// ── 登录态检测 ──────────────────────────────────────────────────────────────

/**
 * 检测一个账号的登录态。三种情形：
 *   · 浏览器在跑   → 读它的 cookie + 当前页 URL（最准）；
 *   · 不在跑、要静默 → 用**无头** Chrome 开同一个档案探一次（不弹窗，几秒），
 *                     探完就关 —— 这是"关着窗口也能显示登录状态"的唯一办法；
 *   · 都不行       → 返回上一次的检测结果并标注 stale。
 */
async function checkAccount(account, opts = {}) {
  const platform = platformOf(account.platform);
  const cfg = readConfig();
  if (!platform) {
    return { ok: false, loggedIn: false, evidence: 'none', reason: `未知平台 ${account.platform}`, stale: false };
  }
  // 装了 ego 就走 ego（每店一个 profile + TaskSpace），没有才用 Chrome 端口那套
  if (backendFor(cfg) === 'egolite') return egoCheckAccount(account, opts);
  const port = Number(account.port) || 0;
  const running = port ? await browserUp(port, 900) : false;

  if (running) {
    // 端口上跑着的可能不是这个账号的浏览器（用户自己开的 Chrome、别的插件起的、或者冒名顶替的假 CDP）。
    // 读它的 cookie 会把"别人的登录态"当成这个店铺的 → 先确认归属，不认就当成"没在跑"。
    const dir = accountProfileDir(account, cfg);
    if (!(await ourBrowserOnPort(account, port, dir))) {
      return {
        ok: false, loggedIn: false, evidence: 'none', running: false, stale: false,
        checkedAt: new Date().toISOString(),
        reason: `端口 ${port} 上不是这个店铺的浏览器（归属校验没通过），拒绝读取它的 cookie。点「打开」会重新分配端口。`,
      };
    }
    const live = await readLoginFrom(port, platform, await pickSiteUrl(port, platform));
    return { ok: true, ...live, running: true, stale: false, checkedAt: new Date().toISOString() };
  }

  if (opts.silent) {
    const exe = resolveBrowserPath(cfg.browserPath);
    if (!exe) {
      return { ok: false, loggedIn: false, evidence: 'none', reason: `找不到可用的浏览器（${osPlatform.label}），无法静默检测`, running: false, stale: false };
    }
    const taken = loadAccounts().filter((a) => a.id !== account.id).map((a) => Number(a.port)).filter(Boolean);
    const pinnedUsable = port && (await isPortFree(port));
    const probePort = port && pinnedUsable ? port : await pickPort(cfg.portBase || 9222, taken);
    if (!probePort) {
      return { ok: false, loggedIn: false, evidence: 'none', reason: '找不到空闲调试端口', running: false, stale: false };
    }
    const dir = accountProfileDir(account, cfg);
    ensureDir(dir);
    try {
      launchBrowser({
        exe,
        profileDir: dir,
        port: probePort,
        urls: [], // 见下面：标签页自己开，避免把 --restore-last-session 恢复出来的旧标签当成"当前页"
        headless: true,
      });
      // 先登记运行期信息：后面的归属校验只认"登记表 / 进程命令行"，刚起的这只属于我们。
      setRuntime(account.id, { port: probePort, profileDir: dir, pid: 0, probe: true });
      const up = await waitForCdp(probePort, 20000);
      if (!up) {
        setRuntime(account.id, null);
        return { ok: false, loggedIn: false, evidence: 'none', reason: '无头检测：调试端口没起来', running: false, stale: false };
      }
      if (!(await verifyFreshLaunch(probePort, dir))) {
        try { await closeBrowser(probePort); } catch { /* ignore */ }
        await killChromeForProfile(dir);
        setRuntime(account.id, null);
        return { ok: false, loggedIn: false, evidence: 'none', reason: '无头检测：调试端口被别的进程占了（归属校验没通过）', running: false, stale: false };
      }
      // `--restore-last-session`（让会话级 cookie 能跨重启存活）会把上次的标签页一并恢复出来，
      // 里面很可能就是上次停着的登录页 —— 那样 settlePage 可能挑中旧标签，判出假的「未登录」。
      // 所以自己开一个干净标签，再把别的页面目标全关掉，只留这一个。
      // 但「点 X 关窗」是另一回事：Chrome 不会落盘会话级 cookie（千牛的 unb 就是这种），
      // 重开后档案里根本没有它 —— 所以先用上次存下的 cookie 罐补回去，再打开页面。
      const restored = await restoreSessionCookies(probePort, account);
      if (restored.ok) appendDebug('restore', { account: account.id, platform: account.platform, count: restored.count, savedAt: restored.savedAt });
      const fresh = await newPage(probePort, platform.homeUrl);
      if (fresh && fresh.id) {
        for (const p of await listPages(probePort)) {
          if (String(p.id) !== String(fresh.id)) await closePage(probePort, p.id);
        }
      }
      const settled = await settlePage(probePort, platform, 12000, { targetId: fresh && fresh.id });
      let live = await readLoginFrom(probePort, platform, settled.url);
      // 保活：判定「已登录」后先别关浏览器，让页面自己再跑一会儿 ——
      // 商家后台的会话基本是"活跃即续期"，靠它自己的心跳 / XHR 轮询把会话当活跃。
      // 这里刻意**不 reload**：刚加载完就刷新更像脚本，也更容易被风控盯上。
      const keepaliveSec = Math.max(0, Math.min(120, Number(opts.keepaliveSec) || 0));
      let keptAliveSec = 0;
      if (keepaliveSec > 0 && live.loggedIn) {
        await sleep(keepaliveSec * 1000);
        const after = await readLoginFrom(probePort, platform, settled.url);
        keptAliveSec = keepaliveSec;
        // 保活期间反而掉线了（站点把会话踢了）就以新结果为准，绝不报假的「已登录」。
        live = after.loggedIn ? { ...after, keptAliveSec } : after;
      }
      if (live && live.loggedIn === false && live.evidence === 'login-page') {
        // 文案按「这家店以前登录过没有」来定：登过 = 掉线了；从没登过 = 还没登。
        // （不要拿 cookie 罐里有没有残留来猜：新档案首次打开，站点也可能种下 mms_b84d1838 这类 cookie。）
        live.reason = account.lastLoginAt ? '登录已失效，请重新登录' : '未登录，请前往登录页登录';
      }
      // 这次探出来的罐子是活的（站点刚认过 / 刚轮换过值）→ 存一份，下次启动先补回去。
      if (live && live.loggedIn) {
        try {
          const got = await getAllCookies(probePort);
          if (got && got.cookies && got.cookies.length) saveSessionCookies(account, got.cookies);
        } catch { /* 存不下不影响判定 */ }
      }
      await closeBrowser(probePort);
      if (!(await waitPortGone(probePort, 5000))) await killChromeForProfile(dir);
      setRuntime(account.id, null);
      return { ok: true, ...live, running: false, silent: true, stale: false, checkedAt: new Date().toISOString() };
    } catch (err) {
      try { await closeBrowser(probePort); } catch { /* ignore */ }
      try { await killChromeForProfile(dir); } catch { /* ignore */ }
      setRuntime(account.id, null);
      return { ok: false, loggedIn: false, evidence: 'none', reason: '无头检测失败：' + (err && err.message ? err.message : String(err)), running: false, stale: false };
    }
  }

  const last = account.lastCheck || null;
  return {
    ok: false,
    loggedIn: Boolean(last && last.loggedIn),
    evidence: last ? last.evidence : 'none',
    reason: last
      ? '浏览器未运行，显示上次检测结果：' + (last.reason || '')
      : '浏览器未运行，也没有检测记录 —— 点「检测」或「打开」后再看',
    running: false,
    stale: true,
    checkedAt: account.lastCheckAt || null,
  };
}

/**
 * 从跑着的端口读 cookie + URL 并判定。
 * `preferUrl`：调用方已经知道页面最终停在哪（静默检测先 settlePage 了），以它为准 ——
 * getAllCookies 挑的是"有 https URL 的那个 page 目标"，多标签页时不一定是我们等的那个。
 */
/**
 * 浏览器开着时，挑一个"最能代表当前登录态"的页面 URL 当判定依据。
 *
 * 为什么需要：`getAllCookies` 默认拿 /json/list 里**第一个 https 标签**的 URL，而 Chrome 用
 * `--restore-last-session` 会把上次停在登录页的标签也恢复出来 —— 那个登录页排在前面时，
 * 「登录页优先」的判据会把明明已登录的店铺判成掉线，逼用户重扫码（v0.8.1 修）。
 * 规则：优先「本平台域名 + 不像登录页」的页面，其次本平台任意页，最后空（让调用方退回默认行为）。
 */
async function pickSiteUrl(port, platform) {
  try {
    const pages = await listPages(port);
    const domains = (platform && Array.isArray(platform.cookieDomains)) ? platform.cookieDomains : [];
    const urls = pages.map((p) => String(p.url || '')).filter((u) => /^https?:/i.test(u));
    const inSite = urls.filter((u) => {
      const low = u.toLowerCase();
      return !domains.length || domains.some((d) => low.includes(String(d).toLowerCase()));
    });
    const good = inSite.filter((u) => !looksLikeLoginPage(u, platform));
    return good[0] || inSite[0] || '';
  } catch {
    return '';
  }
}

async function readLoginFrom(port, platform, preferUrl = '') {
  let cookies = null;
  let url = '';
  let cdpError = null;
  try {
    const got = await getAllCookies(port);
    if (got) {
      cookies = got.cookies;
      url = preferUrl || got.url || '';
    } else {
      cdpError = '没有可用的页面目标';
    }
  } catch (err) {
    cdpError = err && err.message ? err.message : String(err);
  }
  if (cookies === null) {
    // 读不到 cookie：退到 URL 弱判据（可能是浏览器不是本插件起的、没开 remote-allow-origins）
    const pages = await listPages(port);
    url = preferUrl || (pages[0] && pages[0].url) || url;
    const judged = judgeLogin([], url, platform, { cookieReadOk: false });
    return { ...judged, cookieError: cdpError, url, cookieCount: 0 };
  }
  const judged = judgeLogin(cookies, url, platform, { cookieReadOk: true });
  // 登录凭证 cookie 里最晚的到期时间 —— 只是「这张凭证纸面到哪天」，
  // **不等于会话还能用**（服务端会先把会话作废，见 README「为什么 cookie 还在却掉线」）。
  // 但它能提前提示用户：凭证哪天到底，别等到掉线才发现。
  const tokenExpiry = tokenExpiryOf(cookies, platform);
  return { ...judged, url, cookieCount: cookies.length, tokenExpiry };
}

/**
 * 让已经开着的窗口跳到某个地址（用来催站点把身份 cookie 种下来）。
 */
async function navigatePageTo(port, url) {
  const pages = await listPages(port);
  const page = pages.find((p) => /^https?:/i.test(p.url || '')) || pages[0];
  if (!page) return false;
  try {
    await evaluateOn(page.webSocketDebuggerUrl, 'document.location.href = ' + JSON.stringify(url), 4000, port);
    return true;
  } catch {
    return false;
  }
}

/**
 * 等「身份 cookie 全部到齐」再关窗。
 *
 * 为什么需要（2026-10-19 千牛第二次翻车，现场用 CDP 抓到的时间线）：
 * 工作台已经能看见店铺数据、用户就点了保存，但淘宝卖家侧的身份 cookie `unb` 是工作台
 * 自己再页内跳一次才种下的（比工作台晚几秒），而且它是**会话级** cookie —— 关窗就失效。
 * 关窗那一刻 unb 还没下来，下一秒打开当然就是未登录。
 * 所以关窗之前必须确认 identityCookies 全部命中：不齐就等（中途催一次工作台），
 * 等不到就如实说「没保存」，而不是骗用户说保存成功。
 *
 * readFn / now / sleepFn / nudge 都可注入，便于自检里用假时钟跑。
 */
export async function waitForIdentityCookies(readFn, platform, opts = {}) {
  const identity = Array.isArray(platform && platform.identityCookies) ? platform.identityCookies : [];
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 20000;
  const pollMs = opts.pollMs != null ? opts.pollMs : 1000;
  const sleepFn = opts.sleepFn || sleep;
  const now = opts.now || Date.now;
  let live = opts.first || (await readFn());
  const missingOf = (lv) => {
    const have = new Set((lv && lv.matched) || []);
    return identity.filter((n) => !have.has(n));
  };
  if (!identity.length) return { live, waitedMs: 0, ok: Boolean(live && live.loggedIn), identity, missing: [] };
  const start = now();
  let waitedMs = 0;
  let nudges = 0;
  while (live && live.loggedIn && now() - start < timeoutMs) {
    waitedMs = now() - start;
    const missing = missingOf(live);
    if (!missing.length) return { live, waitedMs, ok: true, identity, missing: [] };
    // 等 5 秒还没齐：催一次工作台（站内再跳一次，站点就会把身份 cookie 发下来），最多催两次
    if (typeof opts.nudge === 'function' && nudges < 2 && waitedMs >= (nudges + 1) * 5000) {
      nudges += 1;
      try { await opts.nudge(); } catch { /* 催不动就继续等 */ }
    }
    await sleepFn(pollMs);
    live = await readFn();
  }
  const missing = missingOf(live);
  return { live, waitedMs, ok: Boolean(live && live.loggedIn && !missing.length), identity, missing };
}

/**
 * 等页面**导航真正结束**，返回它最终停留的 URL。
 *
 * 为什么不能"看到平台域名就算稳"（v0.3.0 的 bug，2026-10-19 用真档案实测）：
 * 无头检测把 homeUrl 作为启动参数丢给 Chrome，页面目标**一上来**就停在
 * `https://mms.pinduoduo.com/home/`（+377ms 就能看到，CDP +358ms 起来），真正跳到
 * `/login/?redirectUrl=...` 要到 +632ms。旧实现一看到"平台域名"立刻返回，于是判的是
 * home URL + 档案里还没被清掉的 PASS_ID/SUB_PASS_ID cookie → 掉线了也报「已登录」，
 * **关着窗口时永远检测不出来登录掉了**。
 *
 * 现在只认"导航结束"：文档 `readyState === 'complete'` 且 URL 连续 quietMs 不再变化；
 * 万一带的页面资源一直不结束（readyState 卡在 interactive），URL 稳定 interactiveGraceMs
 * 也认。返回值里的 url 就是判定依据，调用方别再自己问一次（再问可能又变了）。
 * 注：只覆盖"跳到登录页"这一类掉线；若平台是在同一个 URL 里渲染登录框（SPA），
 * URL 判据本就无力，只能靠 cookie —— 那种情况这里等多久都一样。
 */
export async function settlePage(port, platform, timeoutMs = 12000, opts = {}) {
  const wantId = opts.targetId ? String(opts.targetId) : '';
  const quietMs = Number(opts.quietMs) > 0 ? Number(opts.quietMs) : 1500;
  const interactiveGraceMs = Number(opts.interactiveGraceMs) > 0 ? Number(opts.interactiveGraceMs) : 4000;
  const pollMs = 200;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastUrl = '';
  let changedAt = startedAt;
  let readyState = '';
  let bestUrl = '';
  let failures = 0;
  const domains = (platform && Array.isArray(platform.cookieDomains)) ? platform.cookieDomains : [];

  for (;;) {
    const pages = await listPages(port);
    // 指定了标签页就只认它（`--restore-last-session` 恢复出来的旧标签不能被当成本次导航结果）
    const wanted = wantId ? pages.find((p) => String(p.id) === wantId) : null;
    // 多标签页时优先挑本平台的（别把无关页当导航结果）
    const inSite = (p) => domains.some((d) => String(p.url || '').toLowerCase().includes(d));
    const target = wanted
      || pages.find((p) => /^https?:/i.test(p.url || '') && inSite(p))
      || pages.find((p) => /^https?:/i.test(p.url || ''))
      || null;

    let url = target ? String(target.url || '') : '';
    let state = '';
    if (target) {
      // /json/list 里的 URL 是 Chrome 侧维护的，可能落后一帧；直接从文档里读更"现在"。
      try {
        const raw = await evaluateOn(
          target.webSocketDebuggerUrl,
          'JSON.stringify({ href: document.location.href, readyState: document.readyState })',
          3000,
          port,
        );
        const got = raw ? JSON.parse(raw) : null;
        if (got && typeof got.href === 'string') url = got.href;
        if (got && typeof got.readyState === 'string') state = got.readyState;
        failures = 0;
      } catch {
        failures += 1; // 目标在关/重建，本轮拿不到 readyState，下一轮再看
      }
    }

    if (/^https?:/i.test(url)) {
      bestUrl = url;
      if (url !== lastUrl) { lastUrl = url; changedAt = Date.now(); }
    }
    if (state) readyState = state;

    const waitedMs = Date.now() - startedAt;
    const quiet = Date.now() - changedAt;
    if (bestUrl && state === 'complete' && quiet >= quietMs) {
      return { url: bestUrl, readyState: state, waitedMs, timedOut: false };
    }
    // 资源一直不结束的站点：URL 已经稳定够久就认，别把 12s 全耗完
    if (bestUrl && quiet >= interactiveGraceMs) {
      return { url: bestUrl, readyState: readyState || state, waitedMs, timedOut: false };
    }
    // 一直没有可用的页面目标（浏览器还没开好 / 已经在关）：别硬等到超时
    if (failures >= 8 && !bestUrl) return { url: '', readyState, waitedMs, timedOut: true };
    if (Date.now() >= deadline) return { url: bestUrl, readyState, waitedMs, timedOut: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ── 账号操作 ────────────────────────────────────────────────────────────────

/** 两个路径是不是同一个档案目录（Windows 大小写、斜杠、结尾分隔符都不敏感）。 */
function samePath(a, b) {
  const norm = (s) => String(s || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const x = norm(a);
  return x !== '' && x === norm(b);
}

/**
 * 这个端口上的 Chrome 是不是这个账号的那只？返回 'mine' | 'other' | 'unknown'。
 *
 * 先查我们自己起浏览器时留下的登记表（快、准），查不到再去问进程命令行（慢一点但更权威）。
 * 两条都问不出来 = unknown。
 *
 * v0.8.3：以前 unknown 直接当 true（乐观放行）。那意味着「端口被别的程序占着」时，
 * 插件会去读它的 cookie、往它上面 setCookies、乃至 Browser.close 关掉它 —— 一律改成
 * 只有明确 'mine' 才读写；'unknown' 只在「挂个标签页」这种不发 cookie 的动作里放行。
 *
 * v0.8.4：登记表也**不是永久可信**了 —— 条目要有写入时间（8 小时内），pid > 0 时还要确认
 * 这个进程真的活着（崩溃/重启后端口可能已经被别人接手）。
 */
const RUNTIME_TTL_MS = 8 * 60 * 60 * 1000;

function runtimeEntryMine(account, port, dir) {
  const entry = readRuntime()[account.id];
  if (!entry || Number(entry.port) !== Number(port) || !samePath(entry.profileDir, dir)) return false;
  const at = Date.parse(String(entry.at || ''));
  if (!Number.isFinite(at) || Date.now() - at > RUNTIME_TTL_MS) return false;
  const pid = Number(entry.pid) || 0;
  // pid 为 0 的条目（"复用已有浏览器" / 无头探测）**没有存活凭据**：不能只凭登记表就认定是自己的，
  // 否则浏览器退出、端口被别人接手后，8 小时内还会把真 cookie setCookies 过去。
  // 这类条目一律退回 `chromeOwnerOfPort()` 问进程命令行，查不到就是 unknown（不读不写）。
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (err) {
    if (err && err.code === 'ESRCH') return false; // 进程没了
    // EPERM 等：进程还活着（只是不归我们管），继续按登记处理
  }
  return true;
}

async function portOwnership(account, port, dir) {
  if (runtimeEntryMine(account, port, dir)) return 'mine';
  const owner = await chromeOwnerOfPort(port);
  if (!owner) return 'unknown';
  return samePath(owner, dir) ? 'mine' : 'other';
}

/** 只认明确属于自己的端口（读/写 cookie 之前必须过这一关）。 */
async function ourBrowserOnPort(account, port, dir) {
  return (await portOwnership(account, port, dir)) === 'mine';
}

/**
 * 刚刚在"空闲端口"上 spawn 出来的浏览器，归属确认。
 * 进程命令行查得到 → 必须是这份档案；查不到（WMI 被组策略限制等）→ 接受（端口刚才是空的，
 * 这只就是我刚起的）。这样既不放过明确的冒名者，也不会在受限机器上把功能挡死。
 */
async function verifyFreshLaunch(port, dir) {
  const owner = await chromeOwnerOfPort(port);
  if (!owner) return true;
  return samePath(owner, dir);
}

/** 端口分配：账号上已定的端口优先（保证"上架流程记住的端口"不会变），否则找新的。 */
async function allocatePort(account, cfg) {
  const accounts = loadAccounts();
  const taken = accounts.filter((a) => a.id !== account.id).map((a) => Number(a.port)).filter(Boolean);
  const pinned = Number(account.port) || 0;
  if (pinned && !taken.includes(pinned)) {
    const free = await isPortFree(pinned);
    if (free) return pinned;
    // 端口被占着：里面有 CDP 且是这个账号自己的浏览器 → 复用；是别人的 Chrome → 换端口
    if (await browserUp(pinned, 600)) {
      const dir = accountProfileDir(account, cfg);
      if (await ourBrowserOnPort(account, pinned, dir)) return pinned;
    }
  }
  return pickPort(Number(cfg.portBase) || 9222, taken);
}

/**
 * 打开一个账号的浏览器。`mode==='login'` 打开登录页（新增/重新登录用），
 * 否则打开平台工作台（复用登录态用）。
 *
 * 关键：**浏览器已经在跑的时候绝不再拉起一个 Chrome**。Chrome 是单实例的，同 profile 再启一次
 * 只会把命令行里的 URL 转给已有窗口然后自己退出；而调试端口仍被老实例占着，`waitForCdp` 于是"成功"，
 * 整个动作看起来成功却什么都没发生 —— 用户看到的就是「点了重新登录没反应、不给扫码」。
 * 所以这里分两条路：已在跑 → 直接在它上面开新标签页；没在跑 → 起窗口，并核对端口确实属于这个账号的档案。
 */
async function openAccount(account, mode) {
  const platform = platformOf(account.platform);
  if (!platform) throw new Error(`未知平台 ${account.platform}`);
  const cfg = readConfig();
  if (backendFor(cfg) === 'egolite') return egoOpenAccount(account, mode);
  const exe = resolveBrowserPath(cfg.browserPath);
  if (!exe) throw new Error(`找不到可用的浏览器（${osPlatform.label}）。请在下方「浏览器设置」里手动指定浏览器可执行文件的完整路径。`);

  const dir = accountProfileDir(account, cfg);
  ensureDir(dir);

  // 账号上记的「店铺 URL」优先（那是这个店铺自己的工作台/后台页）；否则用平台的默认工作台。
  // 只接受 http/https：`account.url` 可被接口写，拼进 Chrome 命令行就是开关注入（--proxy-server 等）。
  const shopUrl = String(account.url || '').trim() ? safeNavUrl(account.url) : '';
  const workUrl = shopUrl || platform.workUrl || platform.homeUrl;
  const urls = mode === 'login'
    ? [platform.loginUrl]
    : [workUrl].concat(cfg.openWorkTab && workUrl !== platform.homeUrl ? [platform.homeUrl] : []);

  const pinned = Number(account.port) || 0;
  if (pinned && (await browserUp(pinned, 800))) {
    // 归属三态：mine = 我们的；other = 明确是别人的 Chrome（别往里塞标签页）；unknown = 查不到（旧行为，允许塞）
    const ownership = await portOwnership(account, pinned, dir);
    if (ownership !== 'other') {
      const opened = [];
      for (const u of urls) opened.push({ url: u, ok: Boolean(await newPage(pinned, u)) });
      if (!opened.some((x) => x.ok)) {
        throw new Error(`这个店铺的浏览器已经在 ${pinned} 上跑着，但新开标签页失败了（调试连接可能被别的程序占着）。先点「关闭」再试。`);
      }
      patchAccount(account.id, {
        port: pinned,
        profileDir: dir,
        lastOpenAt: new Date().toISOString(),
        ...(mode === 'login' ? { pendingLogin: true } : {}),
      });
      // 注意：只有明确 'mine' 才写登记表。'unknown'（查不到归属）只允许"挂个标签页"，
      // 不能顺手把它记成自己的 —— 否则一次打开之后，这个陌生端口就永久被当成 mine 了。
      if (ownership === 'mine') setRuntime(account.id, { port: pinned, profileDir: dir, pid: 0, reused: true });
      return { port: pinned, pid: 0, reused: true, profileDir: dir, mode, cdpUrl: `http://127.0.0.1:${pinned}`, browser: exe, urls };
    }
    // 端口被别的 Chrome 占着：往下走，另起一个端口，别往别人窗口里塞标签页
  }

  const port = await allocatePort(account, cfg);
  if (!port) throw new Error('找不到空闲调试端口（9222 起 200 个都被占了）。可在「浏览器设置」里改起始端口。');

  const { pid } = launchBrowser({ exe, profileDir: dir, port, urls });
  const up = await waitForCdp(port, 30000);
  if (!up) {
    // 端口没起来通常有两种原因：档案被另一个 Chrome 实例占着（单实例锁），或启动失败。
    // 这里必须把刚 spawn 出去的那只收掉，否则它会一直锁着档案（后续 reset/删除全失败）。
    try { await killChromeForProfile(dir); } catch { /* ignore */ }
    throw new Error(`浏览器窗口起来了但调试端口 ${port} 没响应（多半是这个档案已被别的 Chrome 进程占用）。`);
  }
  // 刚在"空闲端口"上起的这只：进程命令行查得到就必须是这份档案；查不到（WMI 被限）接受。
  if (!(await verifyFreshLaunch(port, dir))) {
    try { await killChromeForProfile(dir); } catch { /* ignore */ }
    throw new Error(`调试端口 ${port} 上是另一个 Chrome（不是这个店铺的档案）。请在「浏览器设置」里换个起始端口，或先关掉那个 Chrome 再试。`);
  }
  setRuntime(account.id, { port, profileDir: dir, pid });
  // 会话级 cookie 可能因为上次「点 X 关窗」没落盘 —— 先用本地备份补回去，再让窗口落到目标页。
  // 不然千牛这种站点一开窗就是登录页，用户白扫一次码。
  const restored = await restoreSessionCookies(port, account);
  if (restored.ok) {
    appendDebug('restore', { account: account.id, platform: account.platform, mode, count: restored.count, savedAt: restored.savedAt });
    try { await navigatePageTo(port, urls[0]); } catch { /* 导航失败就先让页面自己待着 */ }
  }
  setRuntime(account.id, { port, profileDir: dir, pid });
  patchAccount(account.id, {
    port,
    profileDir: dir,
    lastOpenAt: new Date().toISOString(),
    ...(mode === 'login' ? { pendingLogin: true } : {}),
  });
  return { port, pid, reused: false, profileDir: dir, mode, cdpUrl: `http://127.0.0.1:${port}`, browser: exe, urls };
}

/** 关闭一个账号的浏览器：先礼（CDP Browser.close，Chrome 会正常落盘）后兵（按档案路径强杀）。 */
async function closeAccount(account, opts = {}) {
  const cfg = readConfig();
  if (backendFor(cfg) === 'egolite') return egoCloseAccount(account, opts);
  const port = Number(account.port) || 0;
  const dir = accountProfileDir(account, cfg);
  let closedBy = 'none';
  if (port && (await browserUp(port, 900))) {
    // 只在"这个端口确实是这个店铺的浏览器"时才发 CDP Browser.close：
    // 否则会把用户自己的 Chrome / 别人的浏览器关掉（端口是配置值，可能被占）。
    const ownership = await portOwnership(account, port, dir);
    if (cfg.gracefulClose !== false && ownership === 'mine') {
      const asked = await closeBrowser(port);
      if (asked && (await waitPortGone(port, 8000))) closedBy = 'cdp';
    }
    if (closedBy === 'none' && (await browserUp(port, 700))) {
      // 强杀只按档案路径匹配进程，杀不到别人的浏览器
      await killChromeForProfile(dir);
      await waitPortGone(port, 6000);
      closedBy = 'kill';
    }
  }
  if (opts.clearPending !== false) patchAccount(account.id, { pendingLogin: false });
  setRuntime(account.id, null);
  return { closed: true, closedBy, port };
}

/**
 * 清空这个店铺的登录档案，然后重新打开登录页 —— 「不给重新扫码」时的硬招。
 * 有的站点会在档案里留着半死的会话：登录页一打开就被重定向回后台，二维码根本不出现。
 * 关窗 → 删档案 → 重启到登录页，最干净。
 */
async function resetAccount(account) {
  const cfg = readConfig();
  if (backendFor(cfg) === 'egolite') return egoResetAccount(account);
  const dir = accountProfileDir(account, cfg);
  // 递归删除只允许"根目录之内 + 目录名正好是账号 id"：profileDir 可以由接口指定（导入已有目录），
  // 不设这道关就等于给了一个"删任意目录"的原语（2026-10-31 安全审查 + 二次审查加固）。
  const delDir = deletableProfileDir(account, cfg);
  if (!delDir) {
    return {
      ok: false, dir,
      error: `这个店铺的档案目录不满足删除条件（${dir}）：必须是档案根目录下、且目录名就是账号 id。` +
        '导入的目录不会被插件递归删除 —— 需要清空请手动删。',
    };
  }
  const closed = await closeAccount(account);
  const removed = await removeProfileDir(delDir);
  if (!removed.ok) {
    return { ok: false, error: `档案删不掉（${removed.error || '未知原因'}）—— 先把那个店铺的 Chrome 窗口关掉再试`, dir, closed };
  }
  patchAccount(account.id, { port: 0, lastCheck: null, lastCheckAt: null, lastLoginAt: null, pendingLogin: false });
  const r = await openAccount({ ...account, port: 0 }, 'login');
  return { ok: true, dir, closed, removed, ...r };
}

// ── 定时任务（v0.15.0：默认「定时采集」，每店一条任务）──────────────────────
//
// 规则（排期算法在 schedule.mjs，这里只负责"到点真的去跑"）：
//   每天 startTime 起，全部店铺按 order 排队，每 groupSize 个一组、组间隔 groupIntervalMin。
//   到点什么：`schedule.mode` 决定 ——
//     'collect'（默认）→ **定时采集**：这个店配了采集就跑采集作业（prepare + drive），
//                         没配采集（或这个平台还没有可跑配方）就退回静默检测登录态；
//     'check'          → 老的静默检测（无头 Chrome 探一次，不弹窗）。
//   调度形状：**每店一条任务、彼此错峰**（10:00 / 10:30 / 11:00 …），到点只跑这一家。
//   执行用插件自己的 DSL 引擎（见 rpa.mjs / collect-runner.mjs），逻辑就三步：到点、按店跑采集、记账。
//   店铺自己的开关（schedEnabled）只管"到点跑不跑"，时间点照样占着；错过时间不补跑。

/** 本机内存（GB，一位小数）；拿不到当 0 → 每组 1 个，保守。 */
function memGB() {
  try {
    const bytes = os.totalmem();
    if (!bytes) return 0;
    return Math.round((bytes / 1024 ** 3) * 10) / 10;
  } catch { return 0; }
}

/** 给界面用的排期视图（纯读，不写文件）。 */
export function scheduleView(opts = {}) {
  const cfg = readConfig();
  const s = normalizeSchedule(cfg.schedule);
  const accounts = loadAccounts();
  const mem = opts.memGB != null ? Number(opts.memGB) : memGB();
  const plan = planSchedule({ schedule: s, accounts, memGB: mem });
  const next = nextRun({ schedule: s, accounts, memGB: mem, now: opts.now });
  return {
    ...plan,
    // v0.15.0：到点做什么（collect = 定时采集 / check = 只检测登录态）
    mode: s.mode,
    keepaliveSec: s.keepaliveSec,
    groupSizeMode: Number(s.groupSize) > 0 ? 'manual' : 'auto',
    autoGroupSize: groupSizeFor({ ...SCHEDULE_DEFAULTS, groupSize: 0 }, mem),
    memGB: mem,
    nextRunAt: next ? next.at : null,
    nextTime: next ? next.time : '',
    lastDay: s.lastDay,
    canRun: Boolean(s.enabled) && plan.rows.some((r) => r.enabled),
  };
}

/**
 * v0.16.0：某个店在排期里的槽位时间（`HH:mm`），拿不到返回 `''`。
 * 「什么时候采」只有一个来源 = 全局排期；采集配置里那个 `collection.time` 已经不再影响任何调度。
 */
export function schedSlotOf(accountId, opts = {}) {
  try {
    const view = opts.schedule || scheduleView();
    const row = (view.rows || []).find((r) => r.id === accountId);
    return row ? String(row.time || '') : '';
  } catch { return ''; }
}

/** 给一个 Promise 套超时（超时后 reject，让上层按"失败"记账，不要卡住整轮）。 */
function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`超时（${Math.round(ms / 1000)} 秒没结果）`), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

let schedBusy = false;

/**
 * 跑一轮到点的定时任务。
 * - **先记账再执行**：失败也算跑过，否则每 20 秒重试一次会把无头 Chrome 起爆；
 * - 浏览器正开着 / 正在等登录的店铺直接跳过，不打断用户手里的活；
 * - `checkFn` / `collectFn` 可注入（自检里塞假函数，绝不起浏览器）。
 *
 * 动作选择（v0.15.0）：
 *   schedule.mode === 'collect' 且这个店配了采集  → 跑采集作业（collectFn）
 *   其它情况                                      → 静默检测登录态（checkFn）
 */
export async function tickSchedule(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const log = opts.log || { info: () => {}, warn: () => {} };
  const s = normalizeSchedule(readConfig().schedule);
  const accounts = loadAccounts();
  // `due` 可注入（自检里直接指定"谁到点了"，不用去构造刚好落在宽限内的时刻）
  const due = Array.isArray(opts.due) ? opts.due : dueRows({
    schedule: s, accounts, now,
    memGB: opts.memGB != null ? opts.memGB : memGB(),
    graceMs: opts.graceMs,
  });
  if (!due.length) return { ran: [], skipped: [], at: now.toISOString(), mode: s.mode };

  const keepaliveSec = opts.keepaliveSec != null ? opts.keepaliveSec : s.keepaliveSec;
  const checkFn = typeof opts.checkFn === 'function' ? opts.checkFn : (a) => checkAccount(a, { silent: true, keepaliveSec });
  const collectFn = typeof opts.collectFn === 'function' ? opts.collectFn : (a) => runScheduledCollection(a, log);
  const ran = [];
  const skipped = [];
  for (const row of due) {
    const account = findAccount(row.id);
    if (!account) { skipped.push({ id: row.id, name: row.name, reason: '账号已不存在' }); continue; }
    if (account.pendingLogin) { skipped.push({ id: row.id, name: row.name, reason: '正在等登录' }); continue; }
    // 到点要干什么：v0.16.0 起**只看"这个店配了采集没有"**（选了采集域 = 配了），
    // 不再看 collection.enabled（老字段，只用于"显式退出"）—— 跑不跑由排期表的 schedEnabled 决定。
    const wantsCollect = s.mode !== 'check' && collectionReady(account);
    const backend = backendFor(readConfig());
    let running = false;
    try {
      if (backend === 'egolite') running = false; // 见上：不再用「空间开着」当跳过理由
      else running = Number(account.port) ? await browserUp(Number(account.port), 500) : false;
    } catch { running = false; }
    // 采集要自己开窗口，所以「浏览器开着」不跳过（那正是我们要用的登录态）；检测则照旧跳过不打断
    if (!wantsCollect && running) { skipped.push({ id: row.id, name: row.name, reason: '浏览器开着，不打断' }); continue; }
    // 先抢这个店铺的锁：抢不到（用户正在手动操作它）就跳过，而且**不记账** —— 记了这次时间点就没了。
    const releaseLock = await acquireAccountLock(account.id, { wait: false });
    if (!releaseLock) { skipped.push({ id: row.id, name: row.name, reason: '这个店铺正在手动操作' }); continue; }
    try {
      // 记账放在**抢到锁之后、真正执行之前**：预检跳过不该消耗掉这个时间点。
      try {
        writeConfig({ schedule: markRan(readConfig().schedule, { accountIds: [row.id], time: row.time, now }) });
      } catch (err) {
        log.warn(`定时任务记账失败（${row.name}）：${err && err.message ? err.message : String(err)}`);
      }
      const at = new Date().toISOString();
      if (wantsCollect) {
        // 超时保护：代填/采集任何一步卡住，都不能把整轮定时任务钉死在这里
        const collectTimeoutMs = Number(opts.collectTimeoutMs) > 0 ? Number(opts.collectTimeoutMs) : 15 * 60_000;
        const out = await withTimeout(collectFn(account, { now, slot: row.time }), collectTimeoutMs);
        patchAccount(account.id, { lastSchedAt: at, lastSchedError: out && out.ok === false ? String(out.error || out.code || '采集失败') : '' });
        ran.push({
          id: row.id, name: row.name, time: row.time, action: 'collect',
          ok: Boolean(out && out.ok), code: (out && out.code) || '',
          counts: (out && out.counts) || null,
        });
      } else {
        const live = await checkFn(account, { keepaliveSec });
        patchAccount(account.id, { ...checkPatch(live, at), lastSchedAt: at, lastSchedError: '' });
        ran.push({ id: row.id, name: row.name, time: row.time, action: 'check', loggedIn: Boolean(live && live.loggedIn), reason: (live && live.reason) || '' });
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      patchAccount(account.id, { lastSchedAt: new Date().toISOString(), lastSchedError: msg });
      skipped.push({ id: row.id, name: row.name, reason: '执行失败：' + msg });
    } finally {
      releaseLock();
    }
  }
  if (ran.length) {
    log.info(`定时任务完成：${ran.map((r) => r.name + (r.action === 'collect'
      ? (r.ok ? `✓采集${r.counts ? `(${r.counts.ok}/${r.counts.total})` : ''}` : `✗采集(${r.code || '失败'})`)
      : (r.loggedIn ? '✓检测' : '✗检测'))).join('、')}`);
  }
  if (skipped.length) log.info(`定时任务跳过：${skipped.map((r) => r.name + '（' + r.reason + '）').join('、')}`);
  return { ran, skipped, at: now.toISOString(), mode: s.mode };
}

/**
 * 一个店铺的定时采集（v0.15.0）：挑这个平台能跑的配方 → prepare → 自己跑完 → 回写采集结果。
 * 没有可跑配方 / 平台不支持 → 明确返回原因，让上层退回检测（不假装采过）。
 */
export async function runScheduledCollection(account, log = { info: () => {}, warn: () => {} }, opts = {}) {
  const cfg = account.collection || {};
  const inventory = listDsls().items.filter((d) => d.platform === account.platform);
  if (!inventory.length) {
    return { ok: false, code: 'NO_DSL_FOR_PLATFORM', error: `「${account.platform}」还没有可执行的采集配方` };
  }
  // 可注入（自检用假实现，绝不起浏览器）
  const prepareFn = typeof opts.prepareFn === 'function'
    ? opts.prepareFn
    // includeDownload：抖音、京东这类配方的产物是下载文件（v0.14.0 起已支持），
    // 定时采集也必须带上，否则它们会被当成「没有可跑的配方」（v0.17.7）。
    : (extra = {}) => prepareJobForAccount(account, { drive: true, skipCovered: true, includeDownload: true, ...extra });
  const autoLoginFn = typeof opts.autoLoginFn === 'function'
    ? opts.autoLoginFn
    : (acc, pw) => autoLogin(acc, { password: pw, backend: backendFor(readConfig()), cfg: readConfig() });

  let out;
  try {
    out = await prepareFn({});
  } catch (err) {
    return { ok: false, code: 'COLLECT_FAILED', error: String((err && err.message) || err) };
  }
  if (out && out.success === false) {
    // 一条都没准备好：把真正的原因说出来（平台不匹配 / 缺业务参数 / 缺后处理能力），
    // 不要笼统报「作业没准备好」（v0.16.7）。
    const first = (out.errors || [])[0] || {};
    const code = String(first.code || 'JOBS_NOT_PREPARED');
    const detail = String(first.message || '').trim();
    const error = code === 'UNSUPPORTED_CAPABILITY'
      ? `这个平台的采集配方需要额外的能力（${detail || '响应体需要专用解密'}），本插件暂不支持`
      : `采集配方没准备好${detail ? '：' + detail : ''}`;
    patchAccount(account.id, {
      lastSchedError: error,
      collection: applyCollectionResult(account, { status: 'failed', note: error, by: 'schedule' }),
    });
    return { ok: false, code, error, errors: (out.errors || []).slice(0, 3) };
  }
  let data = (out && out.data) || {};
  let counts = data.counts || { total: 0, ok: 0, failed: 0, empty: 0, pending: 0 };
  if (data.next_action !== 'done') {
    return { ok: false, code: 'JOB_NOT_FINISHED', error: '采集作业没跑完（可能需要先打开店铺 / 重新登录）', counts, jobId: data.job_id };
  }
  if (!counts.total) {
    // 全部因为"已采过"被跳过 —— 这是正常的（当天已采过），记一笔成功
    const note = `定时采集：配方都已采过，无需重复（计划跳过 ${(data.plan && data.plan.skipped && data.plan.skipped.length) || 0} 项）`;
    patchAccount(account.id, { collection: applyCollectionResult(account, { status: 'ok', note, by: 'schedule' }) });
    return { ok: true, code: 'ALREADY_COVERED', counts, note, jobId: data.job_id };
  }

  // ── v0.15.1：登录过期 → **用本机保存的密码自动代填，填完接着采** ────────────
  // 需求：给了密码就该在过期时代填。所以这里不再"只标待登录"：
  //   1) 挑出因为 LOGIN_REQUIRED 失败的配方；
  //   2) 有密码 → autoLogin 代填一次（验证码/短信仍需人，这时才标待登录）；
  //   3) 代填成功 → 只重跑那几份配方，结果并进统计。
  let loginNote = '';
  let autoLoginInfo = null;
  const delivery0 = data.delivery || {};
  const loginDslIds = (delivery0.incomplete || [])
    .filter((x) => String(x.code || '') === 'LOGIN_REQUIRED')
    .map((x) => String(x.dslId || ''))
    .filter(Boolean);

  if (loginDslIds.length) {
    // v0.17.0：「扫码或手动登录」的店铺存心不存密码 —— 定时任务不用代填，直接标待登录等人扫一次
    if (loginModeOf(account) === 'qrcode') {
      const manualNote = '定时采集时登录态已过期：这个店铺是「扫码或手动登录」，打开店铺扫码或登录一次即可';
      patchAccount(account.id, { pendingLogin: true, lastSchedError: manualNote });
      return {
        ok: false, code: 'AUTOLOGIN_LOGIN_MODE_MANUAL', counts, jobId: data.job_id,
        error: manualNote, loginDslIds,
      };
    }
    const pw = getPassword(account.id);
    if (!pw) {
      patchAccount(account.id, { pendingLogin: true, lastSchedError: '定时采集时登录态失效，但本机没有保存密码，无法代填' });
      return {
        ok: false, code: 'AUTOLOGIN_NO_PASSWORD', counts, jobId: data.job_id,
        error: '登录态失效，但本机没存密码 —— 在店铺详情里存一次密码，之后定时采集就能自动代填',
        loginDslIds,
      };
    }
    let login;
    try {
      login = await autoLoginFn(account, pw);
    } catch (err) {
      login = { ok: false, code: 'AUTOLOGIN_EXCEPTION', error: String((err && err.message) || err) };
    }
    autoLoginInfo = { code: (login && login.code) || '', ok: Boolean(login && login.ok), loggedIn: Boolean(login && login.loggedIn), hint: (login && login.hint) || '' };
    const loggedIn = Boolean(login && (login.loggedIn || login.ok));
    if (!loggedIn) {
      const code = String((login && login.code) || '');
      // 账号/密码错了：这不是「等用户点两下」能好的 —— 明确报出来，并且**停下自动代填**
      // （连续错密码可能被站点锁号，所以记 credentialErrorAt，定时任务不再反复试）。
      if (code === 'AUTOLOGIN_BAD_CREDENTIALS') {
        patchAccount(account.id, {
          pendingLogin: true,
          credentialErrorAt: new Date().toISOString(),
          lastSchedError: '登录账号或密码不正确 —— 已暂停自动代填，去店铺详情改对账号/密码后再继续',
        });
        return {
          ok: false, code: 'AUTOLOGIN_BAD_CREDENTIALS', counts, jobId: data.job_id,
          autoLogin: autoLoginInfo,
          error: '登录账号或密码不正确（站点提示）—— 已停止自动代填，避免连续错误被锁号。请到店铺详情里改正账号/密码。',
          loginDslIds,
        };
      }
      // 需要验证码/短信，或者填不进去：这时才交回给人
      const needsUser = /NEEDS_USER|CAPTCHA|FILL_FAILED/.test(code);
      patchAccount(account.id, {
        pendingLogin: true,
        lastSchedError: needsUser
          ? '定时采集时代填到验证码/短信，需要人工完成一次登录'
          : `定时采集时自动代填失败：${(login && login.code) || '未知'}`,
      });
      return {
        ok: false,
        code: needsUser ? 'AUTOLOGIN_NEEDS_USER' : 'AUTOLOGIN_FAILED',
        counts, jobId: data.job_id, autoLogin: autoLoginInfo,
        error: needsUser ? '登录已过期，代填到了验证码/短信，需要人工完成一次' : `登录已过期，自动代填失败：${(login && login.error) || (login && login.code) || '未知'}`,
        loginDslIds,
      };
    }
    // 代填成功 → 只重跑刚才因为登录失败的那几份配方
    log.info?.(`定时采集：${account.name} 登录已过期，已用本机密码自动代填，重跑 ${loginDslIds.length} 份配方`);
    patchAccount(account.id, { pendingLogin: false, lastLoginAt: new Date().toISOString(), lastSchedError: '' });
    loginNote = `（登录过期，已自动代填后重采 ${loginDslIds.length} 份）`;
    try {
      const retry = await prepareFn({ dslIds: loginDslIds, skipCovered: false });
      const rdata = (retry && retry.data) || {};
      const rc = rdata.counts || {};
      if (rdata.next_action === 'done' && (rc.total || 0) > 0) {
        // 合并统计：先扣掉这几次失败，再加上重采结果
        counts = {
          total: counts.total,
          ok: counts.ok + (rc.ok || 0),
          empty: counts.empty + (rc.empty || 0),
          failed: Math.max(0, counts.failed - loginDslIds.length) + (rc.failed || 0),
          pending: counts.pending,
        };
        data = { ...data, delivery: rdata.delivery || delivery0, job_id: data.job_id };
      } else {
        // 重采也没跑完：保持失败，并如实说明
        patchAccount(account.id, { lastSchedError: '自动代填成功，但重采没有跑完' });
      }
    } catch (err) {
      patchAccount(account.id, { lastSchedError: '自动代填成功，但重采出错：' + String((err && err.message) || err) });
    }
  }

  const status = counts.failed > 0 ? (counts.ok > 0 ? 'partial' : 'failed') : 'ok';
  const delivery = data.delivery || {};
  const note = `定时采集：成功 ${counts.ok} / 空数据 ${counts.empty} / 失败 ${counts.failed}（产物 ${(delivery.artifacts || []).length} 个）${loginNote}`;
  patchAccount(account.id, { collection: applyCollectionResult(account, { status, note, by: 'schedule' }) });

  // 代填成功但仍有配方报登录失效 → 说明是别的问题（权限/改版），标待登录让人看一眼
  const stillLogin = (delivery.incomplete || []).some((x) => String(x.code || '') === 'LOGIN_REQUIRED');
  if (stillLogin && !loginNote) {
    patchAccount(account.id, { pendingLogin: true, lastSchedError: '定时采集时登录态失效，需要重新登录' });
  }
  return {
    ok: status !== 'failed', code: status === 'failed' ? 'ALL_FAILED' : '', counts, note,
    jobId: data.job_id, delivery, autoLogin: autoLoginInfo || undefined,
  };
}

/** 定时器里的一轮：同一时间只跑一轮，挤进来的 tick 直接让路。 */
async function schedTick(log) {
  if (schedBusy) return;
  schedBusy = true;
  try {
    await tickSchedule({ log });
  } catch (err) {
    log.warn('定时检测出错：' + (err && err.message ? err.message : String(err)));
  } finally {
    schedBusy = false;
  }
}

// ── 状态组装 ────────────────────────────────────────────────────────────────

async function buildState() {
  const cfg = readConfig();
  const { accounts, error } = readAccounts();
  const browserPath = resolveBrowserPath(cfg.browserPath);
  const backend = backendFor(cfg);
  // ego 的 profile/TaskSpace 列表（带缓存；ego 没装就直接是 available:false）
  // 只有真的在用 ego 时才去起 ego CLI 读列表 —— 用 Chrome 的时候每 30 秒起一个 ego 进程太浪费，
  // 而且 ego 没开着的话还可能把浏览器窗口弹出来。设置页点「刷新 ego」/切到 ego 后端时才强制读。
  const ego = backend === 'egolite'
    ? await refreshEgoInfo(false).catch(() => egoInfoSync())
    : egoInfoSync();
  const sched = scheduleView();
  const schedById = new Map(sched.rows.map((r) => [r.id, r]));
  // Chrome 后端要逐个探端口（每次最多 700ms）。串行的话店铺一多，/state 比前端轮询还慢会请求堆积 ——
  // 所以先把所有端口并发探一次（v0.8.1 修）。
  const portUp = new Map();
  if (backend !== 'egolite') {
    const ports = [...new Set(accounts.map((a) => Number(a.port) || 0).filter(Boolean))];
    const probed = await Promise.all(ports.map(async (p) => [p, await browserUp(p, 700).catch(() => false)]));
    for (const [p, up] of probed) portUp.set(p, up);
  }
  const out = [];
  const vinfo = vaultInfo();
  for (const a of accounts) {
    const platform = platformOf(a.platform);
    const type = normalizeAccountType(a.accountType);
    const caps = capabilitiesOf(platform, type);
    const port = backend === 'egolite' ? 0 : (Number(a.port) || 0);
    const egoSpace = egoSpaceName(a);
    const running = backend === 'egolite' ? egoSpaceExists(egoSpace, a.egoSpaceId) : (port ? portUp.get(port) === true : false);
    const dir = accountProfileDir(a, cfg);
    let pwFlag = false;
    let pwAt = null;
    let pwError = null;
    try {
      pwFlag = hasPassword(a.id);
      pwAt = pwFlag ? passwordUpdatedAt(a.id) : null;
    } catch (err) { pwError = String((err && err.message) || err); }
    out.push({
      id: a.id,
      platform: a.platform,
      platformLabel: platform ? platform.label : a.platform,
      name: a.name || '(未命名)',
      note: a.note || '',
      url: a.url || '',
      loginName: a.loginName || '',
      accountType: type,
      accountTypeLabel: accountTypeLabel(type),
      // v0.16.6：密码能力由身份的真实登录方式决定（拼多多 C 端没有账号密码 → 不提示"未保存密码"）
      // v0.17.0：还要看这家店铺选的登录方式 —— 选了「扫码或手动登录」就不需要密码、也不做代填
      capabilities: {
        ...caps,
        autoLoginSupported: vinfo.available && pwFlag && caps.passwordLogin && loginModeOf(a) === 'password',
        passwordRequired: Boolean(caps.passwordLogin && loginModeOf(a) === 'password'),
        loginMode: loginModeOf(a),
        loginModeLabel: loginModeLabelOf(loginModeOf(a)),
        passwordLoginSupported: Boolean(caps.passwordLogin),
      },
      loginMode: loginModeOf(a),
      loginModeLabel: loginModeLabelOf(loginModeOf(a)),
      hasPassword: pwFlag,
      passwordUpdatedAt: pwAt,
      passwordError: pwError,
      // v0.15.2：代填时站点说"账号或密码不正确" → 记时间点，界面据此显示醒目提示
      credentialErrorAt: a.credentialErrorAt || null,
      autoLoginBlocked: Boolean(a.pendingLogin && a.credentialErrorAt),
      collection: (() => {
        try { return normalizeCollection({}, a.collection || {}, { allow: allowedDomains(a.platform) }); } catch { return { enabled: false, domains: [], time: '' }; }
      })(),
      // v0.16.0：这个店配了采集没有（= 选了采集域 且 没被老开关显式关掉）—— 界面用它决定"定时采集会跑吗"
      collectionReady: collectionReady(a),
      // v0.12.0 目录层：这个平台的采集域与各域指标数（淘宝/天猫多「竞争洞察」）
      collectionDomains: (() => { try { return domainOptions(a.platform); } catch { return domainList(); } })(),
      // v0.16.0：到期判断用**排期槽位时间**（不再用 collection.time，那个已经不影响调度）
      collectionDue: (() => { try { return isCollectionDue(a, new Date(), { time: schedById.has(a.id) ? schedById.get(a.id).time : '' }); } catch { return false; } })(),
      // v0.11.0 数据层概览：近 30 天每个域覆盖了几天、缺几天、有多少条记录（只读本地文件，不采集）
      collectionCoverage: (() => { try { return collectionSummary(a); } catch { return null; } })(),
      port,
      cdpUrl: port ? `http://127.0.0.1:${port}` : '',
      backend,
      egoProfile: String(a.egoProfile || ''),
      egoSpace: backend === 'egolite' ? egoSpace : String(a.egoSpace || ''),
      egoSpaceId: Number(a.egoSpaceId) || 0,
      egoSharedProfile: Boolean(a.egoSharedProfile),
      profileDir: dir,
      profileExists: (() => { try { return fs.existsSync(dir); } catch { return false; } })(),
      running,
      pendingLogin: Boolean(a.pendingLogin),
      createdAt: a.createdAt || null,
      lastOpenAt: a.lastOpenAt || null,
      lastLoginAt: a.lastLoginAt || null,
      lastCheckAt: a.lastCheckAt || null,
      lastCheck: a.lastCheck || null,
      lastCheckError: a.lastCheckError || '',
      imported: Boolean(a.imported),
      schedEnabled: a.schedEnabled !== false,
      schedTime: schedById.has(a.id) ? schedById.get(a.id).time : '',
      lastSchedAt: a.lastSchedAt || null,
      lastSchedError: a.lastSchedError || '',
    });
  }
  // 排序：等待登录的排最前（那是用户此刻要处理的），其余按创建时间倒序
  out.sort((x, y) => (Number(y.pendingLogin) - Number(x.pendingLogin)) || String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  return {
    ok: true,
    now: new Date().toISOString(),
    platforms: platformList(),
    accountTypes: ACCOUNT_TYPES,
    // v0.17.0：登录方式选项（账号密码代填 / 扫码或手动登录），界面直接用这一份，避免文案两处漂移
    loginModes: LOGIN_MODES,
    collectionDomains: domainList(),
    collectionLabels: COLLECTION_LABELS,
    // v0.12.0 目录层：平台 → 采集域 → 指标（数量与域清单；指标明细走 GET /catalog）
    catalog: (() => { try { return catalogInfo(); } catch (err) { return { ready: false, error: String((err && err.message) || err), platforms: {} }; } })(),
    vault: vinfo,
    // 平台能力位：界面据此决定显示"保存密码/自动代填"还是"仅手动登录"（macOS Keychain 可用时与 Windows 等价）
    osPlatform: {
      id: osPlatform.id,
      label: osPlatform.label,
      secretBackend: osPlatform.secretBackend,
      capabilities: osPlatform.capabilities,
    },
    dueCollections: (() => {
      try { return dueCollections(accounts, new Date(), { timeOf: (a) => (schedById.has(a.id) ? schedById.get(a.id).time : '') }); } catch { return []; }
    })(),
    accounts: out,
    config: cfg,
    browser: { path: browserPath || '', found: Boolean(browserPath) },
    backend,
    ego,
    dataDir: dataDir(),
    version: ownVersion(),
    loadedVersion: LOADED_VERSION,
    updateDir: detectUpdateDir(),
    schedule: sched,
    paths: { config: configPath(), accounts: accountsPath() },
    storeError: error,
  };
}

// ── 路由 ────────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  let p = url.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length);
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  const mAccount = p.match(/^\/accounts\/([^/]+)$/);
  const mAction = p.match(/^\/accounts\/([^/]+)\/(open|close|reset|finish|check|reveal|silent-check|handoff|schedule)$/);

  // ── 请求来源校验（v0.8.3）────────────────────────────────────────────────
  // 宿主（Desktop）给所有插件路由加了 renderer token 门禁，但那是宿主的实现细节；
  // 插件自己也挡一道：必须是本插件的界面发来的请求。
  const headers = req.headers || {};
  if (String(headers[REQ_HEADER] || '') !== '1') {
    return sendJson(res, 403, { ok: false, error: `缺少 ${REQ_HEADER} 请求头：这个接口只允许插件自己的界面调用` });
  }
  const fetchSite = String(headers['sec-fetch-site'] || '');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return sendJson(res, 403, { ok: false, error: '拒绝跨站请求' });
  }
  // 反 DNS rebinding：rebinding 成功后浏览器发来的 Host 是**攻击者域名**（不是 IP/主机名）。
  // 只接受 IP 字面量 / localhost / 本机主机名；域名一律拒绝。缺 Host 也拒绝（HTTP/1.1 必有 Host）。
  const hostHeader = String(headers.host || '').trim();
  if (!hostHeader) {
    return sendJson(res, 403, { ok: false, error: '缺少 Host 请求头' });
  }
  if (!hostHeaderAllowed(hostHeader)) {
    return sendJson(res, 403, { ok: false, error: '拒绝来自域名的请求（防止 DNS rebinding）：Host=' + hostHeader });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    // 强制 JSON：跨站请求想带这个 Content-Type 就得先过 CORS 预检，而本服务不回 ACAO。
    const ct = String(headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return sendJson(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' });
    }
  }

  try {
    if (method === 'GET' && p === '/state') return sendJson(res, 200, await buildState());

    // ── 目录层（v0.12.0）：平台 → 采集域 → 指标清单 ─────────────────────────
    // ?platform=taobao&domain=运营推广 只取一个域；不给 platform 就返回全部概览（含各域指标数）。
    // 指标可能几百条（淘宝运营推广 540 条），所以 limit 默认 200，`all=1` 才全给。
    // ── v0.13.0 采集 DSL 库存：看看有哪些配方能跑 ───────────────────────────
    if (method === 'GET' && p === '/rpa/dsls') {
      try {
        const { items, seedDir, externalDir } = listDsls();
        const platform = String(url.searchParams.get('platform') || '').trim();
        const list = platform ? items.filter((d) => d.platform === platform) : items;
        return sendJson(res, 200, {
          ok: true,
          count: list.length,
          total: items.length,
          seedDir,
          externalDir,
          // externalDir 为空时只有自带的种子配方（可用 SHOP_ACCOUNTS_DSL_DIR 指向外部配方库）
          items: list.map((d) => ({
            id: d.id, platform: d.platform, description: d.description, days: d.days,
            scheduleMode: d.scheduleMode, artifacts: d.artifacts, hasDownload: d.hasDownload, origin: d.origin,
          })),
          hint: 'POST /accounts/:id/collect-run {dslId} 跑一份；hasDownload=true 的需要下载落盘，本版不支持',
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      }
    }

    if (method === 'GET' && p === '/catalog') {      const q = url.searchParams;
      const wantPlatform = String(q.get('platform') || '').trim();
      const wantDomain = String(q.get('domain') || '').trim();
      const all = q.get('all') === '1';
      const limit = Math.min(Math.max(Number(q.get('limit')) || 200, 1), 5000);
      try {
        if (!wantPlatform) {
          const info = catalogInfo();
          return sendJson(res, 200, {
            ok: true,
            ready: info.ready,
            version: info.version,
            note: info.note,
            totalMetrics: info.totalMetrics,
            platforms: info.platforms,
            // 每个平台的默认（定时采集）域清单，界面直接可用
            platformDomains: Object.fromEntries(Object.keys(info.platforms).map((pid) => [pid, domainOptions(pid)])),
          });
        }
        const platform = platformOf(wantPlatform);
        if (!platform) return sendJson(res, 404, { ok: false, error: `未知平台：${wantPlatform}` });
        const domains = domainOptions(platform.id);
        if (wantDomain) {
          const metrics = catalogMetrics(platform.id, wantDomain);
          const rows = all ? metrics : metrics.slice(0, limit);
          return sendJson(res, 200, {
            ok: true,
            platform: platform.id,
            platformLabel: platform.label,
            domain: wantDomain,
            domains,
            metricCount: metrics.length,
            returned: rows.length,
            truncated: metrics.length > rows.length,
            metrics: rows,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          platform: platform.id,
          platformLabel: platform.label,
          domains,
          metrics: catalogMetrics(platform.id).slice(0, all ? 100000 : limit),
          totalMetrics: catalogMetrics(platform.id).length,
        });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      }
    }

    if (method === 'GET' && p === '/config') {
      const cfg = readConfig();
      const bp = resolveBrowserPath(cfg.browserPath);
      return sendJson(res, 200, {
        ok: true,
        config: cfg,
        browser: { path: bp || '', found: Boolean(bp) },
        backend: backendFor(cfg),
        ego: await refreshEgoInfo(false).catch(() => egoInfoSync()),
        dataDir: dataDir(),
        version: ownVersion(),
        loadedVersion: LOADED_VERSION,
        updateDir: detectUpdateDir(),
      });
    }
    // ego 的 profile / TaskSpace 列表（界面上「刷新 ego」按钮用；强刷，不走缓存）
    if (method === 'GET' && p === '/ego') {
      const cfg = readConfig();
      return sendJson(res, 200, { ok: true, backend: backendFor(cfg), ego: await refreshEgoInfo(true) });
    }
    // 只把 ego 主程序拉起来（界面上的「启动 ego」）—— 注意这和"用 CLI 读一次状态"不同：
    // 后者在 ego 没开着的时候会把整个浏览器连同上次所有标签一起恢复出来，不能拿来当"启动"用。
    if (method === 'POST' && p === '/ego/start') {
      const cfg = readConfig();
      const r = await egoLaunchApp(cfg.egoliteApp);
      if (r.ok) await sleep(800);
      return sendJson(res, r.ok ? 200 : 500, { ...r, ego: await refreshEgoInfo(true).catch(() => egoInfoSync()) });
    }
    if (method === 'PUT' && p === '/config') {
      const body = await readJsonBody(req);
      // 路径类配置必须校验：`profileRoot` 是删除动作的信任锚，`browserPath`/`egoliteCli` 会被 spawn，
      // `updateDir` 会被 git 读写 —— 全都不该由接口指到任意位置（2026-10-31 二次审查）。
      let patch;
      try {
        patch = {
          browserPath: typeof body.browserPath === 'string' ? normalizeExePath(body.browserPath, 'browser') : undefined,
          profileRoot: typeof body.profileRoot === 'string' ? normalizeProfileRoot(body.profileRoot) : undefined,
          portBase: Number.isInteger(body.portBase) && body.portBase >= 1024 && body.portBase <= 65000 ? body.portBase : undefined,
          openWorkTab: typeof body.openWorkTab === 'boolean' ? body.openWorkTab : undefined,
          gracefulClose: typeof body.gracefulClose === 'boolean' ? body.gracefulClose : undefined,
          updateDir: typeof body.updateDir === 'string' ? validateUpdateDir(body.updateDir) : undefined,
          browser: typeof body.browser === 'string' && ['auto', 'egolite', 'chrome'].includes(body.browser) ? body.browser : undefined,
          egoliteCli: typeof body.egoliteCli === 'string' ? normalizeExePath(body.egoliteCli, 'ego') : undefined,
          egoliteApp: typeof body.egoliteApp === 'string' ? normalizeExePath(body.egoliteApp, 'ego') : undefined,
          egoliteUserData: typeof body.egoliteUserData === 'string' ? normalizeOptionalDir(body.egoliteUserData, 'ego User Data 目录') : undefined,
        };
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
      const next = writeConfig(patch);
      const ego = await refreshEgoInfo(true).catch(() => egoInfoSync());
      return sendJson(res, 200, { ok: true, config: next, browser: resolveBrowserPath(next.browserPath) || '', backend: backendFor(next), ego });
    }

    // 检测更新：只 fetch + 比较，不动工作区（界面上的「检测更新」）
    if (method === 'GET' && p === '/update') {
      return sendJson(res, 200, await checkUpdate());
    }
    // 一键更新：快进合并 + 覆盖安装拷贝，改完要重启宿主（界面上的「更新到最新」）
    if (method === 'POST' && p === '/update') {
      const r = await applyUpdate();
      return sendJson(res, r.ok === false ? 500 : 200, r);
    }

    // ── 定时检测排期 ──────────────────────────────────────────────────────
    if (method === 'GET' && p === '/schedule') {
      return sendJson(res, 200, { ok: true, schedule: scheduleView() });
    }
    if (method === 'PUT' && p === '/schedule') {
      const body = await readJsonBody(req);
      const cur = normalizeSchedule(readConfig().schedule);
      const next = normalizeSchedule({
        ...cur,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : cur.enabled,
        // v0.15.0：到点做什么（collect = 定时采集 / check = 只检测）
        mode: body.mode != null ? body.mode : cur.mode,
        startTime: body.startTime != null ? body.startTime : cur.startTime,
        groupIntervalMin: body.groupIntervalMin != null ? body.groupIntervalMin : cur.groupIntervalMin,
        groupSize: body.groupSize != null ? body.groupSize : cur.groupSize,
        keepaliveSec: body.keepaliveSec != null ? body.keepaliveSec : cur.keepaliveSec,
        order: Array.isArray(body.order) ? body.order : cur.order,
      });
      writeConfig({ schedule: next });
      return sendJson(res, 200, { ok: true, schedule: scheduleView() });
    }
    // 只试算不保存：改时间/间隔/每组数/顺序时预览要立刻跟着变，但还没点「保存排期」
    if (method === 'POST' && p === '/schedule/preview') {
      const body = await readJsonBody(req);
      const cur = normalizeSchedule(readConfig().schedule);
      const mem = memGB();
      const plan = planSchedule({
        schedule: {
          ...cur,
          mode: body.mode != null ? body.mode : cur.mode,
          startTime: body.startTime != null ? body.startTime : cur.startTime,
          groupIntervalMin: body.groupIntervalMin != null ? body.groupIntervalMin : cur.groupIntervalMin,
          groupSize: body.groupSize != null ? body.groupSize : cur.groupSize,
          order: Array.isArray(body.order) ? body.order : cur.order,
        },
        accounts: loadAccounts(),
        memGB: mem,
      });
      return sendJson(res, 200, {
        ok: true, plan,
        autoGroupSize: groupSizeFor({ ...SCHEDULE_DEFAULTS, groupSize: 0 }, mem),
        memGB: mem,
      });
    }

    // ── 店铺配置迁移（v0.10.1）──────────────────────────────────────────────
    // 导出/导入走一次性的 JSON 文件，方便换机器（Windows → mac）时不用一条条重填。
    // 两类秘密都不进包：密码（本机密钥绑定，搬过去解不开）、登录态（档案/cookie 是本机的）。
    if (method === 'GET' && p === '/export') {
      return sendJson(res, 200, { ok: true, ...exportStores() });
    }
    if (method === 'POST' && p === '/import') {
      const body = await readJsonBody(req);
      let result;
      try {
        result = importStores(body);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
      return sendJson(res, 200, { ok: true, ...result });
    }

    // v0.17.9：客户端（渲染进程）报错落盘。设置页在真实宿主里被 SlotErrorBoundary
    // 兜住时界面只剩一片空白、console 又进不了宿主日志，所以在页面侧装了个上报钩子，
    // 把异常写到 <数据目录>/client-errors.log，出问题时能直接看到原因。
    if (method === 'POST' && p === '/client-error') {
      const body = await readJsonBody(req);
      const line = recordClientError(body);
      return sendJson(res, 200, { ok: true, logged: Boolean(line) });
    }
    if (method === 'GET' && p === '/client-errors') {
      return sendJson(res, 200, { ok: true, errors: readClientErrors() });
    }

    if (method === 'POST' && p === '/accounts') {
      const body = await readJsonBody(req);
      const platform = platformOf(String(body.platform || ''));
      if (!platform) return sendJson(res, 400, { ok: false, error: '平台只能是 ' + PLATFORMS.map((x) => x.id).join(' / ') });
      if (!isValidAccountType(body.accountType)) {
        return sendJson(res, 400, { ok: false, error: '账号类型只能是 seller（卖家）或 buyer（买家）' });
      }
      const accountType = normalizeAccountType(body.accountType);
      // v0.16.6：身份要按平台能力校验 —— 抖音 C 端网页端被风控挡住，买家身份不可用
      const typeSupport = accountTypeSupport(platform.id, accountType);
      if (!typeSupport.ok) {
        return sendJson(res, 400, { ok: false, code: typeSupport.code, error: typeSupport.reason });
      }
      // v0.9.2：账号与密码都是必填 —— account（非空、≤256）与 password（1..4096）
      // 都是必填，我们是同一件事的本地版：没有账号就没法代填/没法对上是哪个人，没有密码就不是一份能用的账密记录。
      // v0.16.6：**密码只在「这个身份真的有账号密码登录」时才必填**。
      // 拼多多 C 端只有手机验证码/扫码（实测页面里没有密码框），要求填密码就等于建不了号。
      const passwordLogin = supportsPasswordLogin(platform.id, accountType);
      // v0.17.0：登录方式。能力不支持密码登录时只能是「扫码/手动」；支持时默认仍是账号密码代填，
      // 用户可以显式选扫码（不记得账号密码的人走这条，界面就不逼着填密码）。
      const loginMode = passwordLogin ? normalizeLoginMode(body.loginMode) : 'qrcode';
      const needsPassword = passwordLogin && loginMode === 'password';
      const loginName = String(body.loginName || '').trim();
      if (!loginName) {
        return sendJson(res, 400, {
          ok: false, code: 'ACCOUNT_LOGIN_NAME_REQUIRED',
          error: '「登录账号」必填：每条记录都要有账号（手机号 / 旺旺名 / 邮箱），采集靠它对应到人',
        });
      }
      // v0.10.1：同平台 + 同登录账号 = 同一个人，不该建两条。
      const dupLogin = findDuplicateLoginName(platform.id, loginName, '');
      if (dupLogin) {
        return sendJson(res, 400, {
          ok: false, code: 'ACCOUNT_LOGIN_NAME_DUPLICATE',
          error: `这台机器上已经有 ${platform.label} 账号「${loginName}」了（店铺「${dupLogin.name || dupLogin.id}」）—— 同一个人不用建两条，直接改那条就行`,
        });
      }
      if (needsPassword && (typeof body.password !== 'string' || body.password.length === 0)) {
        return sendJson(res, 400, {
          ok: false, code: 'ACCOUNT_PASSWORD_REQUIRED',
          error: '「登录密码」必填：本机加密保存，打开店铺时用它自动账密登录（不想存密码可把登录方式改成「扫码或手动登录」）',
        });
      }
      // 采集配置：建号时就可以带上（界面默认关闭、空域）
      let collection = null;
      try { collection = normalizeCollection(body.collection || {}, {}, { allow: allowedDomains(platform.id) }); } catch (err) {
        return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
      const name = capStr(String(body.name || '').trim(), 80) || `${platform.label} 店铺 ${loadAccounts().length + 1}`;
      // 密码落库：库不可用/密码不合法时先挡掉，避免「号建出来了、密码却没存上」的半成品。
      // 响应里永远不回显密码。v0.16.6：身份不支持密码登录时整段跳过（密码库可用与否都不影响建号）。
      let newPassword = '';
      let passwordSkipped = '';
      if (needsPassword) {
        if (!vaultAvailable()) {
          return sendJson(res, 400, { ok: false, error: `本机密码库不可用（密钥后端 = ${osPlatform.secretBackend || '无'}）—— 密码不会被保存，也不会退化成明文` });
        }
        try { newPassword = normalizePassword(body.password); } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      } else if (!passwordLogin) {
        passwordSkipped = `${platform.label} 买家只有 ${loginMethodsOf(platform.id, 'buyer').map(loginMethodLabel).join(' / ') || '手动'} 登录，没有账号密码；密码未保存，建好后在浏览器里登录一次即可。`;
      } else {
        passwordSkipped = '这个店铺设为「扫码或手动登录」，不保存密码；建好后打开窗口扫码或登录一次，登录态会保存在本机档案里。';
      }
      const cfg = readConfig();
      // ego 后端下店铺名就是 TaskSpace 名（`店铺-<名字>`）—— 重名会让两个店铺落到同一个空间、
      // 登录态直接串台，所以这里必须挡掉（v0.8.0 修）。
      if (backendFor(cfg) === 'egolite') {
        const dup = loadAccounts().find((a) => String(a.name || '').trim() === name);
        if (dup) return sendJson(res, 400, { ok: false, error: `已经有同名店铺「${name}」了。ego 模式下店铺名就是窗口名，重名会让两个店铺共用一个空间 —— 换个名字。` });
      }
      // 店铺 URL 只收 http/https（它会进 Chrome 命令行 / ego 导航，`--proxy-server=` 那种就是开关注入）
      let safeUrl = '';
      try { safeUrl = String(body.url || '').trim() ? safeNavUrl(body.url) : ''; } catch (err) {
        return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
      let safeEgoProfile = '';
      try { safeEgoProfile = normalizeEgoProfileId(body.egoProfile); } catch (err) {
        return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
      // 导入的档案目录：必须是绝对路径的已存在目录（允许在档案根目录之外 —— 导入就是为此，
      // 但删除/打开这类动作另有 isInsideProfileRoot 把关）
      let importDir = '';
      try { importDir = normalizeImportedProfileDir(body.profileDir); } catch (err) {
        return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
      const wantPort = Number.isInteger(body.port) && body.port >= 1 && body.port <= 65535 ? body.port : 0;
      const id = newAccountId(platform.id);
      const account = {
        id,
        platform: platform.id,
        name,
        note: String(body.note || '').trim(),
        url: safeUrl,
        loginName: String(body.loginName || '').trim(),
        accountType,
        // v0.17.0：登录方式随账号存下来（password = 账密代填 / qrcode = 扫码或手动登录）
        loginMode,
        collection,
        profileDir: importDir || profileDirFor(id, cfg),
        port: wantPort,
        egoProfile: safeEgoProfile,
        egoSpace: String(body.egoSpace || '').trim(),
        imported: Boolean(importDir),
        pendingLogin: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastCheck: null,
        lastCheckAt: null,
        lastLoginAt: null,
      };
      // 导入已有目录时，顺手探一次它的登录态（静默），让界面立刻显示真实状态
      saveAccounts([...loadAccounts(), account]);
      let passwordSaved = false;
      if (newPassword) {
        try {
          setPassword(id, newPassword, { loginName: account.loginName, platform: account.platform });
          passwordSaved = true;
        } catch (err) {
          // 号已经建好了，不要把整个请求判失败 —— 只回报密码没存上，让用户进详情页重试
          return sendJson(res, 200, {
            ok: true, passwordSaved: false,
            passwordError: String((err && err.message) || err),
            account: findAccount(id),
          });
        }
      }
      if (importDir) {
        // 用 checkPatch：探测失败（ok:false）不能写成「未登录」的结论，否则界面会红着说掉线
        const check = await checkAccount(account, { silent: true });
        patchAccount(id, { ...checkPatch(check), pendingLogin: !check.loggedIn });
      }
      return sendJson(res, 200, { ok: true, passwordSaved, passwordSkipped, account: findAccount(id) });
    }

    if (mAccount && method === 'GET') {
      const account = findAccount(decodeURIComponent(mAccount[1]));
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });
      return sendJson(res, 200, { ok: true, account });
    }
    if (mAccount && method === 'PUT') {
      const account = findAccount(decodeURIComponent(mAccount[1]));
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });
      const body = await readJsonBody(req);
      const patch = {};
      if (typeof body.name === 'string' && body.name.trim()) {
        const nextName = body.name.trim();
        if (backendFor(readConfig()) === 'egolite') {
          const dup = loadAccounts().find((a) => a.id !== account.id && String(a.name || '').trim() === nextName);
          if (dup) return sendJson(res, 400, { ok: false, error: `已经有同名店铺「${nextName}」了（ego 模式下店铺名就是窗口名）。` });
          // 以前显式指定过 egoSpace 的话，改名后空间名也跟着变：把 egoSpace 清空让它按新名字走，
          // 否则会出现「记录里还是旧窗口名、列表里看新名字」的错位。
          // 注意比较对象是**派生名**（'店铺-' + 名字），不能写 spaceNameFor(account) ——
          // 那个函数在 egoSpace 非空时返回 egoSpace 自己，条件恒为真，会把用户手填的空间名也清掉（v0.8.1 修）。
          const derived = '店铺-' + (String(account.name || '').trim() || account.id);
          if (String(account.egoSpace || '').trim() && String(account.egoSpace || '').trim() === derived) {
            patch.egoSpace = '';
            patch.egoSpaceId = 0;
          }
        }
        patch.name = nextName;
      }
      if (typeof body.note === 'string') patch.note = body.note.trim();
      if (typeof body.url === 'string') {
        try { patch.url = body.url.trim() ? safeNavUrl(body.url) : ''; } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (typeof body.loginName === 'string') {
        patch.loginName = body.loginName.trim();
        // 改成别人的登录账号同样挡掉（排除自己）；改成空串是历史行为，保留——但那样代填就没账号可填了。
        const dupLogin = findDuplicateLoginName(account.platform, patch.loginName, account.id);
        if (dupLogin) {
          return sendJson(res, 400, {
            ok: false, code: 'ACCOUNT_LOGIN_NAME_DUPLICATE',
            error: `这个登录账号「${patch.loginName}」已经给了店铺「${dupLogin.name || dupLogin.id}」—— 同一个账号不能挂在两条记录上`,
          });
        }
      }
      if (body.accountType !== undefined) {
        if (!isValidAccountType(body.accountType)) {
          return sendJson(res, 400, { ok: false, error: '账号类型只能是 seller（卖家）或 buyer（买家）' });
        }
        const nextType = normalizeAccountType(body.accountType);
        // v0.16.6：平台不支持的身份不许改过去（比如把抖音店铺改成买家）
        const typeSupport = accountTypeSupport(account.platform, nextType);
        if (!typeSupport.ok) {
          return sendJson(res, 400, { ok: false, code: typeSupport.code, error: typeSupport.reason });
        }
        patch.accountType = nextType;
      }
      // v0.17.0：允许在详情页切换登录方式（不记得账号密码 → 改成扫码/手动登录，不再要求存密码）
      if (body.loginMode !== undefined) {
        const nextMode = normalizeLoginMode(body.loginMode);
        if (nextMode === 'password') {
          const typeNow = normalizeAccountType(patch.accountType || account.accountType);
          if (!supportsPasswordLogin(account.platform, typeNow)) {
            return sendJson(res, 400, {
              ok: false, code: 'LOGIN_MODE_UNSUPPORTED',
              error: `${platformOf(account.platform)?.label || account.platform} 的${accountTypeLabel(typeNow)}没有账号密码登录，只能用 `
                + `${loginMethodsOf(account.platform, typeNow).map(loginMethodLabel).join(' / ') || '手动'} 登录`,
            });
          }
        }
        patch.loginMode = nextMode;
      }
      if (body.collection !== undefined) {
        try { patch.collection = normalizeCollection(body.collection, account.collection || {}, { allow: allowedDomains(account.platform) }); } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (typeof body.profileDir === 'string' && body.profileDir.trim()) {
        try { patch.profileDir = normalizeImportedProfileDir(body.profileDir); } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (Number.isInteger(body.port) && body.port >= 1 && body.port <= 65535) patch.port = body.port;
      if (typeof body.egoProfile === 'string') {
        try { patch.egoProfile = normalizeEgoProfileId(body.egoProfile); } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (typeof body.egoSpace === 'string') {
        patch.egoSpace = body.egoSpace.trim();
        patch.egoSharedProfile = false;
      }
      // 改名后如果会与另一家店落到同一个 ego 空间名，直接挡掉（Chrome 模式下也挡：
      // 用户可能之后再切到 ego 后端，那时就会串台）
      if (patch.name !== undefined || patch.egoSpace !== undefined) {
        const nextAccount = { ...account, ...patch };
        const space = spaceNameFor(nextAccount);
        const dup = loadAccounts().find((a) => a.id !== account.id && spaceNameFor(a) === space);
        if (dup && backendFor(readConfig()) === 'egolite') {
          return sendJson(res, 400, {
            ok: false,
            error: `改完后会和「${dup.name || dup.id}」用到同一个 ego 空间名「${space}」—— 登录态会串台，换个名字。`,
          });
        }
      }
      return sendJson(res, 200, { ok: true, account: patchAccount(account.id, patch) });
    }
    if (mAccount && method === 'DELETE') {
      const id = decodeURIComponent(mAccount[1]);
      const account = findAccount(id);
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });
      const body = await readJsonBody(req).catch(() => ({}));
      if (backendFor(readConfig()) === 'egolite') {
        // ego 后端：先把店铺那个 TaskSpace 收掉，别在 ego 里留一个没人管的窗口（v0.8.1 修）。
        try {
          await withAccountLock(account.id, () => egoCloseAccount(account, { clearPending: false }));
        } catch { /* 收不掉不影响删账号 */ }
        setRuntime(account.id, null);
      }
      if (Number(account.port) && (await browserUp(account.port, 600))) {
        await killChromeForProfile(accountProfileDir(account, readConfig()));
      }
      saveAccounts(loadAccounts().filter((a) => a.id !== id));
      // 账号没了，密码不该还留在库里（否则以后新建同 id 的账号会"凭空有密码"）
      try { removeAccountSecret(id); } catch { /* 清不掉不影响删账号 */ }
      // 采集数据同理：账号都删了，历史采集记录留着只会让重建的同 id 账号"凭空有数据"
      try { removeCollectionStore(id); } catch { /* 清不掉不影响删账号 */ }
      let deletedDir = false;
      if (body && body.deleteProfile === true) {
        const cfg = readConfig();
        const dir = accountProfileDir(account, cfg);
        // 递归删除必须是「档案根目录下 + 目录名 = 账号 id」的形状：
        // 只判"在根目录内"会被"把 profileRoot 改成家目录"绕过（2026-10-31 二次审查）。
        const delDir = deletableProfileDir(account, cfg);
        if (!delDir) {
          return sendJson(res, 200, {
            ok: true, deleted: id, deletedProfile: false,
            warning: `账号已删除，但档案目录不满足删除条件（${dir}），插件没有递归删除它。`,
          });
        }
        try {
          fs.rmSync(delDir, { recursive: true, force: true });
          deletedDir = true;
        } catch { /* 删不掉就留着 */ }
      }
      return sendJson(res, 200, { ok: true, deleted: id, deletedProfile: deletedDir });
    }

    // ── 密码库（存 / 删 / 状态）──────────────────────────────────────────────
    // 密码只在「设置密码」和「自动登录」两条路上用到，且永不出现在 /state 或任何日志里。
    const mSecret = p.match(/^\/accounts\/([^/]+)\/(password|autologin)$/);
    if (mSecret) {
      const account = findAccount(decodeURIComponent(mSecret[1]));
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });
      const kind = mSecret[2];
      if (!vaultAvailable()) {
          return sendJson(res, 503, { ok: false, error: `本机密码库不可用（密钥后端 = ${osPlatform.secretBackend || '无'}）—— 密码不会被保存，也不会退化成明文` });
      }
      if (kind === 'password' && method === 'PUT') {
        const body = await readJsonBody(req);
        try {
          const pw = normalizePassword(body.password);
          const r = setPassword(account.id, pw, { loginName: account.loginName, platform: account.platform });
          return sendJson(res, 200, { ok: true, ...r, autoLoginSupported: true });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (kind === 'password' && method === 'DELETE') {
        const r = clearPassword(account.id);
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (kind === 'autologin' && method === 'POST') {
        // v0.9.2：不再要求 confirm:true —— 账密登录是登录流程的一部分，
        // 没有「再点一次确认」这一步。这里保留对 confirm:false 的尊重（显式拒绝就不代填）。
        const body = await readJsonBody(req).catch(() => ({}));
        if (body.confirm === false) {
          return sendJson(res, 200, { ok: false, code: 'AUTOLOGIN_DECLINED', error: '已按请求跳过代填' });
        }
        // v0.16.6：这个身份根本没有账号密码登录（抖音买家只有扫码/验证码）—— 代填无从谈起
        const type = normalizeAccountType(account.accountType);
        if (!supportsPasswordLogin(account.platform, type)) {
          return sendJson(res, 400, {
            ok: false, code: 'AUTOLOGIN_LOGIN_METHOD_UNSUPPORTED',
            error: `${platformOf(account.platform)?.label || account.platform} 的${accountTypeLabel(type)}只能用 `
              + `${loginMethodsOf(account.platform, type).map(loginMethodLabel).join(' / ') || '人工'} 登录，`
              + '没有账号密码可代填；请在打开的窗口里登录一次，之后登录态会保存在本机档案里。',
          });
        }
        // v0.17.0：这家店铺被设成「扫码或手动登录」时，代填同样无从谈起（用户选择不存密码）
        if (loginModeOf(account) === 'qrcode') {
          return sendJson(res, 400, {
            ok: false, code: 'AUTOLOGIN_LOGIN_MODE_MANUAL',
            error: '这个店铺的登录方式是「扫码或手动登录」—— 点「打开店铺」在窗口里扫码或登录一次即可，登录态会保存在本机档案里（本机没有保存可代填的密码）。',
          });
        }
        if (!account.loginName) {
          return sendJson(res, 400, { ok: false, code: 'AUTOLOGIN_NO_LOGIN_NAME', error: '这个店铺还没填「登录账号」，代填需要账号' });
        }
        const pw = getPassword(account.id);
        if (!pw) return sendJson(res, 400, { ok: false, code: 'AUTOLOGIN_NO_PASSWORD', error: '这个店铺还没有保存密码，请先点「设置密码」' });
        const releaseLock = await acquireAccountLock(account.id);
        try {
          return sendJson(res, 200, {
            ok: true,
            account: account.name,
            platform: account.platform,
            accountType: normalizeAccountType(account.accountType),
            result: await autoLogin(account, { password: pw, backend: backendFor(readConfig()), cfg: readConfig() }),
          });
        } finally {
          releaseLock();
        }
      }
      return sendJson(res, 405, { ok: false, error: `不支持 ${method} /accounts/:id/${kind}` });
    }

    // ── 采集：改配置 / 回写结果 / 取提示词 / plan / import / query（v0.11.0）────
    // ── 采集：改配置 / 回写结果 / 取提示词 / plan / import / query / run（v0.11–0.13）
    const mCollect = p.match(/^\/accounts\/([^/]+)\/(collection|collect-done|collect-prompt|collect-plan|collect-import|collect-records|collect-run|collect-job|collect-jobs)$/);
    if (mCollect) {
      const account = findAccount(decodeURIComponent(mCollect[1]));
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });
      const kind = mCollect[2];
      if (kind === 'collection' && method === 'PUT') {
        const body = await readJsonBody(req);
        try {
          const next = normalizeCollection(body, account.collection || {}, { allow: allowedDomains(account.platform) });
          // 采集配置里的 enabled 只作兼容：新界面只传 domains。
          // 但**必须把它跟 domains 保持一致** —— 新建店铺默认 enabled:false，如果只传域不改它，
          // collectionReady() 会一直判成"没配采集"，选了域也不会到点跑（v0.16.0 修）。
          if (body.enabled === undefined) next.enabled = next.domains.length > 0;
          const patch = { collection: next };
          // v0.16.0：开关统一到排期表的 schedEnabled。老调用方还在传 enabled 的，替它翻译过去，
          // 免得「我在采集卡片里关掉了，结果还是到点跑」。
          if (body.enabled === false) patch.schedEnabled = false;
          else if (body.enabled === true) patch.schedEnabled = true;
          const patched = patchAccount(account.id, patch);
          return sendJson(res, 200, {
            ok: true,
            account: patched,
            schedEnabled: patched.schedEnabled !== false,
            schedTime: schedSlotOf(patched.id),
            note: '采集域已保存；跑不跑、几点跑请用「定时任务」排期（到点会按这里的采集域跑）',
          });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (kind === 'collect-done' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const next = applyCollectionResult(account, body);
          const patched = patchAccount(account.id, { collection: next });
          return sendJson(res, 200, { ok: true, account: patched });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (kind === 'collect-prompt' && method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          account: account.name,
          collection: normalizeCollection({}, account.collection || {}),
          prompt: collectionPrompt(account, { domainMeta: domainOptions(account.platform) }),
        });
      }
      // ── v0.11.0 数据层 ───────────────────────────────────────────────────
      // plan：这个账号这个区间缺哪些天 → COLLECTION_REQUIRED / NO_COLLECTION_REQUIRED
      if (kind === 'collect-plan' && method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}));
        const cfg = account.collection || {};
        const range = collectionRangeText();
        try {
          const wantedDomains = Array.isArray(body.domains) && body.domains.length ? body.domains : cfg.domains;
          const badDomain = (Array.isArray(wantedDomains) ? wantedDomains : []).map((d) => domainErrorFor(account.platform, d)).find(Boolean);
          if (badDomain) return sendJson(res, 400, { ok: false, error: badDomain });
          const plan = planCollection({
            accountId: account.id,
            platform: account.platform,
            domains: wantedDomains,
            start: body.start || range.start,
            end: body.end || range.end,
          });
          return sendJson(res, 200, { ok: true, account: account.name, ...plan });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      // import：把采到的记录写进来（逐条校验 + 去重 + 记覆盖台账）
      if (kind === 'collect-import' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const domErr = domainErrorFor(account.platform, body.domain);
          if (domErr) return sendJson(res, 400, { ok: false, error: domErr });
          const badMetrics = unknownMetricIds(account.platform, (Array.isArray(body.items) ? body.items : []).map((x) => (x && x.metricId) || '').filter(Boolean));
          if (badMetrics.length) {
            return sendJson(res, 400, {
              ok: false,
              error: `这些 metricId 不在「${account.platform}」的目录里：${badMetrics.slice(0, 5).join('、')}${badMetrics.length > 5 ? ` 等 ${badMetrics.length} 个` : ''}（用 GET /catalog?platform=${account.platform}&domain=<域> 查可用指标）`,
              unknownMetricIds: badMetrics,
            });
          }
          const result = importRecords({
            accountId: account.id,
            platform: account.platform,
            domain: String(body.domain || ''),
            items: body.items,
            coverageStart: body.coverageStart,
            coverageEnd: body.coverageEnd,
            period: body.period || 'd',
            by: body.by || 'agent',
            note: body.note || '',
          });
          // 顺带把「这次采完了」记回账号表（老的 lastRun* 语义保留，界面角标还在用）
          if (result.ok) {
            const next = applyCollectionResult(account, {
              status: result.rejected.length ? 'partial' : 'ok',
              note: String(body.note || `导入 ${result.imported} 条${result.duplicates ? `，重复跳过 ${result.duplicates} 条` : ''}`),
              by: body.by || 'agent',
            });
            patchAccount(account.id, { collection: next });
          }
          return sendJson(res, result.ok ? 200 : 400, result);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      // query：查已采集的数据（给分析用，不用重采）
      if (kind === 'collect-records' && method === 'GET') {
        const q = url.searchParams;
        try {
          const domErr = domainErrorFor(account.platform, q.get('domain'));
          if (domErr) return sendJson(res, 400, { ok: false, error: domErr });
          const result = queryRecords({
            accountId: account.id,
            domain: q.get('domain') || '',
            metric: q.get('metric') || '',
            metricId: q.get('metricId') || '',
            start: q.get('start') || '',
            end: q.get('end') || '',
            limit: q.get('limit') ? Number(q.get('limit')) : 500,
          });
          return sendJson(res, 200, { ok: true, account: account.name, ...result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      // run：直接跑一份采集 DSL（v0.13.0）。默认只返回原始产物，
      // 不猜指标映射 —— 归一化交给 agent/skill 再用 collect-import 落库（引擎只负责 plan 与入库）。
      if (kind === 'collect-run' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const out = await runCollectionDsl(account, body);
          return sendJson(res, out.ok ? 200 : (out.httpStatus || 400), out);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      // job：编排层（v0.14.0：prepare / advance / status 三段式）
      if (kind === 'collect-jobs' && method === 'GET') {
        try { return sendJson(res, 200, { ok: true, account: account.name, ...listJobs(account.id).data }); } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      if (kind === 'collect-job' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const out = await prepareJobForAccount(account, body);
          return sendJson(res, out.success ? 200 : 400, out.success ? { ok: true, ...out.data } : { ok: false, errors: out.errors });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      }
      return sendJson(res, 405, { ok: false, error: `不支持 ${method} /accounts/:id/${kind}` });
    }

    // ── 采集作业的推进 / 状态（路径多一层 /collect-job/:jobId）───────────────
    const mJob = p.match(/^\/accounts\/([^/]+)\/collect-job\/([^/]+)(\/advance)?$/);
    if (mJob) {
      const account = findAccount(decodeURIComponent(mJob[1]));
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });
      const jobId = decodeURIComponent(mJob[2]);
      const isAdvance = Boolean(mJob[3]);
      if ((isAdvance && method !== 'POST') || (!isAdvance && method !== 'GET')) {
        return sendJson(res, 405, { ok: false, error: isAdvance ? '用 POST' : '用 GET' });
      }
      try {
        if (!isAdvance) {
          return sendJson(res, 200, { ok: true, ...statusJob({ accountId: account.id, jobId }).data });
        }
        const body = await readJsonBody(req);
        const out = advanceJob({
          accountId: account.id,
          jobId,
          revision: body.revision,
          batchId: body.batchId,
          results: body.results,
        }, artifactStatus);
        return sendJson(res, out.success ? 200 : 400, out.success ? { ok: true, ...out.data } : { ok: false, errors: out.errors, ...(out.data || {}) });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
      }
    }

    if (mAction) {
      const id = decodeURIComponent(mAction[1]);
      const action = mAction[2];
      const account = findAccount(id);
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });

      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '用 POST' });

      // 同一个店铺的动作串行化：定时检测和用户点「打开 / 检测 / 完成」撞上时，
      // 两个 ego CLI 会同时对同一个空间 takeOver / finish，轻则来回抢控制权，重则把窗口收掉。
      const lockable = ['open', 'close', 'reset', 'finish', 'check', 'silent-check', 'handoff'];
      const releaseLock = lockable.includes(action) ? await acquireAccountLock(account.id) : null;
      try {

      if (action === 'schedule') {
        const body = await readJsonBody(req).catch(() => ({}));
        const patched = patchAccount(account.id, { schedEnabled: body.enabled !== false });
        return sendJson(res, 200, { ok: true, account: patched, schedule: scheduleView() });
      }

      if (action === 'open') {
        const body = await readJsonBody(req).catch(() => ({}));
        const mode = body.mode === 'login' ? 'login' : 'work';
        // 注意：这里**不再**因为"端口上已经有 CDP"就空手返回 —— 浏览器在跑的时候 openAccount
        // 会在那个窗口里直接开一个登录页/工作台标签页。老写法会让「重新登录」变成静默空操作。
        const r = await openAccount(account, mode);
        appendDebug('open', { account: account.id, platform: account.platform, mode, snap: await snapshotAccount(account, platformOf(account.platform)) });
        // v0.9.2：账密登录是「打开」的一部分，不用再单独点一次「自动登录」。
        // 已经存了账号+密码就自动代填一次；body.autofill === false 时只开窗口（扫码/手工登录场景）。
        let autofill = null;
        // v0.16.6：身份没有账号密码登录（拼多多 C 端只有验证码/扫码）时直接不尝试
        // v0.17.0：这家店选了「扫码或手动登录」时也不尝试 —— 只把窗口开出来给人扫码
        if (body.autofill !== false && loginModeOf(account) !== 'qrcode' && account.loginName
          && supportsPasswordLogin(account.platform, normalizeAccountType(account.accountType))) {
          const pw = getPassword(account.id);
          if (pw) {
            try {
              const out = await autoLogin(account, { password: pw, backend: backendFor(readConfig()), cfg: readConfig() });
              autofill = { attempted: true, ok: !!(out && out.ok), code: (out && out.code) || '', hint: (out && out.hint) || '', loggedIn: !!(out && out.loggedIn) };
            } catch (err) {
              autofill = { attempted: true, ok: false, code: 'AUTOLOGIN_FAILED', hint: String((err && err.message) || err) };
            }
          } else {
            autofill = { attempted: false, code: 'AUTOLOGIN_NO_PASSWORD', hint: '这个店铺还没有保存密码，窗口已开，请在窗口里手动登录' };
          }
        }
        return sendJson(res, 200, { ok: true, ...r, autofill });
      }

      if (action === 'reset') {
        const r = await resetAccount(account);
        return sendJson(res, r.ok === false ? 500 : 200, r);
      }

      if (action === 'close') {
        const before = await snapshotAccount(account, platformOf(account.platform));
        const r = await closeAccount(account);
        appendDebug('close', { account: account.id, platform: account.platform, closed: r, snapBefore: before });
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (action === 'check' || action === 'silent-check') {
        const silent = action === 'silent-check';
        const body = await readJsonBody(req);
        // 手动「检测」默认不保活（要快）；带 keepaliveSec 就多待一会儿再复查一遍。
        const snapBefore = await snapshotAccount(account, platformOf(account.platform));
        const check = await checkAccount(account, {
          silent,
          keepaliveSec: Number(body && body.keepaliveSec) > 0 ? Number(body.keepaliveSec) : 0,
        });
        appendDebug('check', {
          account: account.id,
          platform: account.platform,
          silent,
          snapBefore,
          result: { loggedIn: check.loggedIn, evidence: check.evidence, url: check.url, cookieCount: check.cookieCount, matched: check.matched },
        });
        // 窗口开着且判定已登录 → 顺手存一份活 cookie（用户下一步可能直接点 X 关窗）。
        const cookieSaved = check.loggedIn ? await rememberLiveCookies(account) : false;
        patchAccount(account.id, {
          lastCheck: check,
          lastCheckAt: new Date().toISOString(),
          ...(check.loggedIn ? { lastLoginAt: new Date().toISOString() } : {}),
        });
        return sendJson(res, 200, { ok: true, check });
      }

      if (action === 'finish') {
        // ego 后端：验登录 → 存状态（空间留着不关，v0.7.1）；Chrome 后端：验登录 → 关窗 → 复核
        if (backendFor(readConfig()) === 'egolite') {
          const r = await egoFinishAccount(account);
          return sendJson(res, r.ok === false ? 500 : 200, r);
        }
        const platform = platformOf(account.platform);
        // 正常情况浏览器还开着 → 直接读它（毫秒级）；用户先把窗口关了 → 无头探一次，别拿旧结果糊弄
        let check = await checkAccount({ ...account, port: account.port }, { silent: true });
        let snapBefore = { up: false, url: '', cookies: [] };
        if (!check.loggedIn) {
          // 没登录成功就**不关窗、不假装保存** —— 用户还得在那个窗口里继续弄
          patchAccount(account.id, checkPatch(check));
          appendDebug('finish', { account: account.id, platform: account.platform, saved: false, why: 'live-check-not-logged-in', result: { loggedIn: check.loggedIn, evidence: check.evidence, url: check.url } });
          return sendJson(res, 200, { ok: true, saved: false, check, closed: false });
        }
        snapBefore = await snapshotAccount(account, platform);
        // 关窗之前：先等身份 cookie（淘宝的 unb 这种）全部到齐 —— 详情见 waitForIdentityCookies 注释。
        // 没等到就**不关窗**，让用户等工作台真的加载完再点一次保存。
        if (platform && Array.isArray(platform.identityCookies) && platform.identityCookies.length) {
          const gate = await waitForIdentityCookies(() => pickSiteUrl(account.port, platform).then((u) => readLoginFrom(account.port, platform, u)), platform, {
            first: check,
            timeoutMs: 20000,
            nudge: () => navigatePageTo(account.port, platform.homeUrl),
          });
          check = gate.live || check;
          if (!gate.ok) {
            patchAccount(account.id, checkPatch(check));
            appendDebug('finish', { account: account.id, platform: account.platform, saved: false, why: 'identity-cookie-missing', missing: gate.missing, waitedMs: gate.waitedMs, snapBefore });
            return sendJson(res, 200, {
              ok: true,
              saved: false,
              check,
              closed: false,
              reason:
                '还没拿到身份 cookie（' + gate.missing.join('、') + '）：工作台大概还没完全打开 —— ' +
                '等能看见店铺数据了，再点一次「保存登录态」',
            });
          }
          patchAccount(account.id, checkPatch(check));
        }
        // 关窗之前把「现在这份活着的 cookie 罐」存下来（含刚轮换过的值）：
        // 用户下次点 X 关窗也不怕 —— 启动时 restoreSessionCookies 会补回去。
        const cookieSaved = await rememberLiveCookies(account);
        const closed = await closeAccount(account);
        // 关窗之后再验一次：网页里「已登录」不等于档案里「登录态还在」——
        // 会话级 cookie 一旦没落盘，用户下一秒打开就是未登录（2026-10-19 千牛那次）。
        // 所以「保存了」这句话必须以**关掉浏览器之后**的真实状态为准，否则宁可不认账。
        await sleep(600); // 给 Chrome 一点时间把档案写完、锁释放
        const verified = await checkAccount({ ...account, port: account.port }, { silent: true });
        patchAccount(account.id, {
          ...checkPatch(verified),
          ...(verified.loggedIn ? { pendingLogin: false } : {}),
        });
        if (!verified.loggedIn) {
          appendDebug('finish', { account: account.id, platform: account.platform, saved: false, why: 'verify-after-close-failed', closed, cookieSaved, snapBefore, verified: { loggedIn: verified.loggedIn, evidence: verified.evidence, url: verified.url, cookieCount: verified.cookieCount, matched: verified.matched } });
          return sendJson(res, 200, {
            ok: true,
            saved: false,
            check: verified,
            closed,
            reason:
              '关掉浏览器后又查了一次：登录态没保住（多半是网站把登录 cookie 设成了「关窗即失效」）—— 请重新登录',
          });
        }
        appendDebug('finish', { account: account.id, platform: account.platform, saved: true, closed, cookieSaved, snapBefore, verified: { loggedIn: true, url: verified.url, cookieCount: verified.cookieCount, matched: verified.matched } });
        return sendJson(res, 200, { ok: true, saved: true, check: verified, ...closed });
      }

      // 手动把控制权还给你：万一某次 handOff 失败（ego 报错/进程被杀），空间会一直卡在
      // 「agent 调试中」，用这个动作补救 —— 不用你去 ego 里手点。
      if (action === 'handoff') {
        if (backendFor(readConfig()) !== 'egolite') return sendJson(res, 400, { ok: false, error: 'Chrome 后端没有「交还控制权」这回事' });
        const space = spaceNameFor(account);
        const r = await egoHandOff({ space, spaceId: account.egoSpaceId || 0 }, { egoliteCli: readConfig().egoliteCli, timeoutMs: 60000 });
        appendDebug('handoff', { account: account.id, space, ok: r.ok !== false, code: r.code || '' });
        return sendJson(res, r.ok === false ? 500 : 200, { ...r, space });
      }

      if (action === 'reveal') {
        const dir = accountProfileDir(account, readConfig());
        // 只允许打开档案根目录内的目录：`profileDir` 可能是导入的任意路径（甚至是 UNC），
        // 用 explorer 打开任意路径既容易被拿来当"打开任意位置"的原语，UNC 还会外发 NTLM。
        if (!isInsideProfileRoot(dir, readConfig())) {
          return sendJson(res, 400, {
            ok: false, dir,
            error: '这个店铺的档案目录在档案根目录之外，插件不会用资源管理器打开它。',
          });
        }
        try {
          if (fs.existsSync(dir)) {
            // 平台层负责"用什么打开目录"：Windows 资源管理器 / macOS Finder
            osPlatform.revealDir(dir);
          }
          return sendJson(res, 200, { ok: true, dir });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      }
      } finally {
        if (releaseLock) releaseLock();
      }
    }

    return sendJson(res, 404, { ok: false, error: `未知路由 ${method} ${BASE}${p}` });
  } catch (err) {
    // 请求体类错误带 status（400/413），别一律 500 —— 500 会让人以为是服务端崩了
    return sendJson(res, err && err.status ? err.status : 500, { ok: false, error: err && err.message ? err.message : String(err) });
  }
}

// ── agent 工具 ──────────────────────────────────────────────────────────────

/**
 * 取 `defineTool`：它不是恒等函数（要把 DSH 自有 schema DSL 编译成 JSON Schema 并建校验器），
 * 所以必须拿到宿主那一份。顺序同 dsh-douyin-comments 踩过的坑：
 *   1) 裸说明符（插件被拷进 profile 时可用）；
 *   2) `<DSH_HOME>/profiles/node_modules` 的拦截层 —— 全新 profile 里 pnpm 给插件装的
 *      那份 `@deepseek-ai/schemastery` 可能是旧版，裸说明符会命中错的；
 *   3) dsh 安装目录自带的副本（从 process.argv[1] 往上推，换机器也成立）。
 */
let defineToolPromise = null;
function loadDefineTool() {
  if (defineToolPromise) return defineToolPromise;
  defineToolPromise = (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-tools');
      if (typeof mod.defineTool === 'function') return mod.defineTool;
    } catch { /* 继续试绝对路径 */ }
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const candidates = [path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')];
    if (process.argv[1]) {
      const dshRoot = path.resolve(path.dirname(process.argv[1]), '..');
      candidates.push(path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
    }
    if (process.env.DTS_NODE_GLOBAL) {
      candidates.push(path.join(process.env.DTS_NODE_GLOBAL, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
    }
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.defineTool === 'function') return mod.defineTool;
      } catch { /* 继续 */ }
    }
    return null;
  })();
  return defineToolPromise;
}

/** 按名字/id/序号挑账号 —— 上架流程里说的是"店铺C"，这里要能吃下这种模糊输入。 */
function pickAccount(input) {
  const accounts = loadAccounts();
  const q = String(input || '').trim();
  if (!q) return null;
  const byId = accounts.find((a) => a.id === q);
  if (byId) return byId;
  const exact = accounts.find((a) => (a.name || '') === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const soft = accounts.filter((a) => (a.name || '').toLowerCase().includes(lower) || (a.note || '').toLowerCase().includes(lower));
  if (soft.length === 1) return soft[0];
  const num = q.match(/^[A-Za-z\u4e00-\u9fa5]*?([A-Z])$/i);
  if (num) {
    const idx = num[1].toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < accounts.length) return accounts[idx];
  }
  return soft[0] || null;
}

async function registerTool(ctx) {
  const defineTool = await loadDefineTool();
  if (!defineTool) {
    ctx.__shopAccountsToolError = '找不到 @deepseek-ai/dsh-tools 的 defineTool，工具 shop_accounts 未注册（设置页不受影响）';
    return null;
  }
  const tool = defineTool({
    name: 'shop_accounts',
    description:
      '电商店铺账号管理（淘宝/拼多多/抖音等）：列出已保存的店铺登录档案、打开某个店铺的浏览器、检测登录态，' +
      '并管理「数据采集」的配置（采集域 + 开关 + 时间，真正采集交给 agent/skill 执行）。' +
      '后端优先 ego lite（每个店铺一个 ego profile + 一个 TaskSpace，登录态按 profile 隔离），' +
      '没装 ego 时回退 Chrome（每店一份用户目录 + 一个调试端口，返回 cdpUrl）。' +
      '打开后：ego 后端返回 space/profileId（窗口已经在 ego 里开好），Chrome 后端返回 cdpUrl（如 http://127.0.0.1:9222）。' +
      '账号类型分卖家/买家：买家账号只做浏览与采集，不做上架。' +
      '注意：登录默认由用户在弹出的浏览器窗口里手动完成；action=autologin 会用本机加密保存的密码代填一次（需用户显式要求）。',
    // v0.17.9：宿主新版 tools.register 要求每个工具声明 output {schema, render}
    // （缺少 output 时 defineTool 直接抛 "Cannot read properties of undefined (reading 'render')"，
    //  工具就注册不上）。这里的返回值形状随 action 变化，所以用宽松的对象 schema，
    //  render 交回 JSON 文本 —— 模型看的还是同一份结果。
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'open', 'check', 'close', 'reset', 'collections', 'collect-prompt', 'collect-plan', 'collect-import', 'collect-query', 'collect-run', 'collect-done', 'collect-job', 'collect-advance', 'collect-status', 'collect-jobs', 'autologin', 'catalog', 'rpa-dsls'],
        required: true,
        description: 'list=列出店铺及其登录状态；open=打开店铺浏览器（返回 cdpUrl）；check=检测登录态；close=关掉店铺浏览器；reset=清空该店铺本地登录档案并重新打开登录页；'
          + 'collections=列出「今天该采集」的店铺及采集域（采集交给 skill 执行）；collect-prompt=取某店铺的采集任务提示词；'
          + 'collect-plan=算这个店铺某区间缺哪些天（返回 awaitCollect 清单，采之前先调它）；'
          + 'collect-import=把采到的记录写进本地数据层（逐条校验 + 去重 + 记覆盖台账，支持空结果只记台账）；'
          + 'collect-query=查已采集的数据（不用重采）；collect-done=回写采集结果（需 status: ok/partial/failed）；'
          + 'catalog=查某个平台/某个域的「可采指标清单」（指标名 + 度量类型 + 落库需要哪些字段）；'
          + 'rpa-dsls=列出本机可用的采集 DSL 配方（含是否依赖下载）；collect-run=按配方直接跑一次采集（返回原始产物，需自行归一化后 collect-import）；'
          + 'collect-job=开一个采集作业（分批返回 tasks，逐批回执推进）；collect-advance=提交本批回执并推进；collect-status=只读查作业；collect-jobs=列作业；'
          + 'autologin=用本机加密保存的密码代填一次登录（需用户显式要求）',
      },
      account: { type: 'string', description: '店铺名（支持部分匹配）或 account id。open/check/close 时必填；也接受「店铺A/店铺B」式的字母序号' },
      mode: { type: 'string', enum: ['work', 'login'], description: 'open 时用：work=打开平台工作台（复用登录态，默认）；login=打开登录页（重新登录）' },
      platform: { type: 'string', enum: PLATFORMS.map((p) => p.id), description: 'list 时按平台过滤' },
      silentCheck: { type: 'boolean', description: 'check 时用：true=用无头浏览器静默检测（不弹窗，几秒），false=只报告上次结果' },
      status: { type: 'string', enum: ['ok', 'partial', 'failed'], description: 'collect-done 时用：这次采集的结果' },
      note: { type: 'string', description: 'collect-done / collect-import 时用：一句话说明（失败原因 / 覆盖范围）' },
      // ── v0.11.0 采集数据层 / v0.12.0 目录层 ──
      domain: { type: 'string', enum: [...COLLECTION_DOMAINS, '竞争洞察'], description: 'collect-import / collect-query / catalog 时用：采集域（经营总览/流量转化/运营推广/商品供给/服务履约；淘宝天猫另有竞争洞察）' },
      domains: { type: 'array', items: { type: 'string', enum: [...COLLECTION_DOMAINS, '竞争洞察'] }, description: 'collect-plan 时用：只算这些域的缺口（不给就按账号的采集配置）' },
      start: { type: 'string', description: 'collect-plan / collect-query 时用：开始日期 YYYY-MM-DD（plan 不给就取最近 30 个完整自然日）' },
      end: { type: 'string', description: 'collect-plan / collect-query 时用：结束日期 YYYY-MM-DD' },
      coverageStart: { type: 'string', description: 'collect-import 时用：这次已采范围的开始日期（含），与 coverageEnd 成对；空结果必填' },
      coverageEnd: { type: 'string', description: 'collect-import 时用：这次已采范围的结束日期（含）' },
      period: { type: 'string', enum: ['h', 'd', 'w', 'm', 'y'], description: 'collect-import 时用：统计周期，默认 d（天）' },
      items: { type: 'array', items: { type: 'object' }, description: 'collect-import 时用：记录数组，每条 {bizDate, metric, value} 或 {bizDate, values:{指标:数值}}，可带 productId/extra/metricId（metricId 必须是 catalog 里该平台的指标）' },
      metric: { type: 'string', description: 'collect-query 时用：只看某个指标' },
      metricId: { type: 'string', description: 'collect-query 时用：按目录里的 metric_id 过滤' },
      dsl: { type: 'string', description: 'collect-run / rpa-dsls 时用：采集配方 id（如 tb_shop_overview；rpa-dsls 可列出全部）' },
      params: { type: 'object', description: 'collect-run 时用：配方需要的业务参数（如 {productId:"123456"}）' },
      timeoutMs: { type: 'number', description: 'collect-run 时用：整条配方执行预算（默认 300000 毫秒）' },
      // ── v0.14.0 采集作业 ──
      dslIds: { type: 'array', items: { type: 'string' }, description: 'collect-job 时用：要跑的配方 id 列表（不给就取该平台全部可跑配方）' },
      includeDownload: { type: 'boolean', description: 'collect-job 时用：是否包含依赖浏览器下载的配方（默认包含）' },
      skipCovered: { type: 'boolean', description: 'collect-job 时用：已采过的配方是否跳过（默认跳过）' },
      drive: { type: 'boolean', description: 'collect-job 时用：true=插件自己跑完全部批次（默认 false，只返回首批 tasks 让调用方执行）' },
      jobId: { type: 'string', description: 'collect-advance / collect-status 时用：作业 id（collect-job 返回）' },
      revision: { type: 'number', description: 'collect-advance 时用：回包里的 revision（防止重复推进）' },
      batchId: { type: 'string', description: 'collect-advance 时用：本批 batchId' },
      results: { type: 'array', items: { type: 'object' }, description: 'collect-advance 时用：本批回执 [{taskId, ok, code, outputs, artifacts, steps, finalUrl}]' },
      limit: { type: 'number', description: 'collect-query 时用：最多返回多少行（默认 500，上限 5000）' },
    },
    execute: async (args = {}) => {
      const action = String(args.action || 'list');
      if (action === 'list') {
        const backend = backendFor(readConfig());
        const all = loadAccounts();
        // index 用**全表下标**：`account` 参数支持「店铺B」这种字母序号，而字母序号是按全表解析的，
        // 若这里给过滤后的下标，带 platform 过滤时会指到别的店铺（v0.8.1 修）。
        const list = all
          .map((a, i) => ({ account: a, fullIndex: i }))
          .filter(({ account }) => !args.platform || account.platform === args.platform)
          .map(({ account: a, fullIndex: i }) => {
            const platform = platformOf(a.platform);
            return {
              index: i,
              id: a.id,
              name: a.name,
              platform: a.platform,
              platformLabel: platform ? platform.label : a.platform,
              accountType: normalizeAccountType(a.accountType),
              hasPassword: (() => { try { return hasPassword(a.id); } catch { return false; } })(),
              collection: normalizeCollection({}, a.collection || {}),
              collectionReady: collectionReady(a),
              collectionDue: (() => {
                try { return isCollectionDue(a, new Date(), { time: schedSlotOf(a.id) }); } catch { return false; }
              })(),
              note: a.note || '',
              backend,
              port: backend === 'egolite' ? 0 : (a.port || 0),
              cdpUrl: backend === 'egolite' ? '' : (a.port ? `http://127.0.0.1:${a.port}` : ''),
              egoProfile: String(a.egoProfile || ''),
              egoSpace: backend === 'egolite' ? egoSpaceName(a) : String(a.egoSpace || ''),
              egoSpaceId: Number(a.egoSpaceId) || 0,
              opening: backend === 'egolite' ? egoSpaceExists(egoSpaceName(a), a.egoSpaceId) : false,
              lastCheck: a.lastCheck || null,
              lastLoginAt: a.lastLoginAt || null,
            };
          });
        return { ok: true, backend, count: list.length, accounts: list, hint: list.length ? '用 action=open + account=<店铺名> 打开某个店铺的浏览器' : '还没有店铺档案，请在「设置 → 账号管理」里新增店铺并登录' };
      }

      if (action === 'collections') {
        const all = loadAccounts();
        const schedView = scheduleView();
        const timeOf = (a) => schedSlotOf(a.id, { schedule: schedView });
        const due = dueCollections(all, new Date(), { timeOf });
        const rows = all
          .filter((a) => collectionReady(a) || due.some((d) => d.id === a.id))
          .map((a) => ({
            id: a.id,
            name: a.name,
            platform: a.platform,
            accountType: normalizeAccountType(a.accountType),
            collection: normalizeCollection({}, a.collection || {}),
            due: due.some((d) => d.id === a.id),
            prompt: collectionPrompt(a),
          }));
        return {
          ok: true,
          count: rows.length,
          dueCount: due.length,
          accounts: rows,
          hint: due.length
            ? `有 ${due.length} 个店铺今天该采集。顺序：collect-plan 算缺口 → 采集 → collect-import 写回（空结果也要带覆盖区间）。`
            : '今天没有到期的采集任务（或采集开关都关着）。',
        };
      }

      const account = pickAccount(args.account);
      if (!account) {
        const names = loadAccounts().map((a) => a.name);
        return { ok: false, error: '没找到店铺：' + String(args.account || '(空)'), available: names };
      }

      if (action === 'open') {
        const mode = args.mode === 'login' ? 'login' : 'work';
        const r = await withAccountLock(account.id, () => openAccount(account, mode));
        const platform = platformOf(account.platform);
        const isEgo = r.backend === 'egolite';
        return {
          ok: true, alreadyRunning: Boolean(r.reused), account: account.name, mode,
          backend: r.backend || 'chrome',
          port: r.port, cdpUrl: r.cdpUrl, profileDir: r.profileDir,
          ...(isEgo ? { space: r.space, profileId: r.profileId, spaceId: r.spaceId, url: r.url } : {}),
          platform: account.platform, homeUrl: platform ? platform.homeUrl : '',
          hint: isEgo
            ? (mode === 'login'
              ? '登录页已经在 ego 的这个 TaskSpace 里打开了，请让用户在那个窗口里完成登录，然后点「完成并保存」'
              : '这个店铺的 ego 窗口已经开好（TaskSpace：' + r.space + '，profile：' + r.profileId + '），登录态直接复用，不需要重新扫码')
            : (mode === 'login'
              ? (r.reused
                ? '登录页已经在这个店铺已打开的 Chrome 窗口里新开了一个标签页，请让用户在那个窗口里完成登录，然后点「完成并保存」'
                : '已打开登录页，请让用户在弹出的 Chrome 窗口里完成登录，然后在「设置 → 账号管理」点「完成并保存」')
              : '可直接用这个 cdpUrl 复用登录态'),
        };
      }

      if (action === 'reset') {
        const r = await withAccountLock(account.id, () => resetAccount(account));
        if (r.ok === false) return { ok: false, account: account.name, error: r.error };
        // ego 后端没有「档案」这回事：清的是该平台域名下的 cookie，空间和 profile 都留着
        const isEgo = r.backend === 'egolite';
        return isEgo
          ? {
            ok: true, account: account.name, mode: 'login', backend: 'egolite', space: r.space, profileId: r.profileId,
            cleared: r.cleared, wholeJar: Boolean(r.wholeJar),
            hint: '这个店铺在 ego 里的登录 cookie 已按平台域名清掉，登录页已经打开；请让用户在那个窗口里重新登录，然后点「完成并保存」',
          }
          : {
            ok: true, account: account.name, mode: 'login', backend: 'chrome', port: r.port, cdpUrl: r.cdpUrl, profileDir: r.profileDir,
            removedProfile: true,
            hint: '这个店铺的本地登录档案已清空并重新打开登录页，请让用户重新扫码登录，然后点「完成并保存」',
          };
      }

      if (action === 'check') {
        const check = await withAccountLock(account.id, () => checkAccount(account, { silent: args.silentCheck === true }));
        patchAccount(account.id, checkPatch(check));
        return { ok: true, account: account.name, platform: account.platform, ...check };
      }

      if (action === 'close') {
        const r = await withAccountLock(account.id, () => closeAccount(account));
        return { ok: true, account: account.name, ...r };
      }

      if (action === 'collect-prompt') {
        return {
          ok: true,
          account: account.name,
          id: account.id,
          platform: account.platform,
          accountType: normalizeAccountType(account.accountType),
          collection: normalizeCollection({}, account.collection || {}),
          collectionReady: collectionReady(account),
          schedEnabled: account.schedEnabled !== false,
          schedTime: schedSlotOf(account.id),
          due: isCollectionDue(account, new Date(), { time: schedSlotOf(account.id) }),
          prompt: collectionPrompt(account, { domainMeta: domainOptions(account.platform) }),
        };
      }

      // ── v0.11.0：本地采集数据层（plan → collect → import → query）───────────
      if (action === 'collect-plan') {
        const range = collectionRangeText();
        const cfg = normalizeCollection({}, account.collection || {}, { allow: allowedDomains(account.platform) });
        const wantedDomains = Array.isArray(args.domains) && args.domains.length ? args.domains : cfg.domains;
        const badDomain = (Array.isArray(wantedDomains) ? wantedDomains : []).map((d) => domainErrorFor(account.platform, d)).find(Boolean);
        if (badDomain) return fail(badDomain);
        const plan = planCollection({
          accountId: account.id,
          platform: account.platform,
          domains: wantedDomains,
          start: args.start || range.start,
          end: args.end || range.end,
        });
        return {
          ok: true,
          account: account.name,
          id: account.id,
          platform: account.platform,
          ...plan,
          hint: plan.status === 'NO_COLLECTION_REQUIRED'
            ? '这段区间已经采全了（覆盖台账里都有记录），不用重复采集。'
            : '按 awaitCollect 里的 missing 去采；采完用 action=collect-import 写进来（记得带 coverageStart/coverageEnd，空结果也要带）。',
        };
      }

      if (action === 'collect-import') {
        const domErr = domainErrorFor(account.platform, args.domain);
        if (domErr) return fail(domErr);
        // metricId 必须是该平台目录里真实存在的指标（目录不可用时不拦）
        const badMetrics = unknownMetricIds(account.platform, (Array.isArray(args.items) ? args.items : []).map((x) => (x && x.metricId) || '').filter(Boolean));
        if (badMetrics.length) return fail(`这些 metricId 不在「${account.platform}」的目录里：${badMetrics.slice(0, 5).join('、')}（用 action=catalog 查这个平台可用的指标）`);
        const result = importRecords({
          accountId: account.id,
          platform: account.platform,
          domain: String(args.domain || ''),
          items: args.items,
          coverageStart: args.coverageStart,
          coverageEnd: args.coverageEnd,
          period: args.period || 'd',
          by: 'agent:shop_accounts',
          note: args.note || '',
        });
        if (result.ok) {
          // 顺手把「这次采完了」记回账号表（界面上的「上次采集」还用这套字段）
          const next = applyCollectionResult(account, {
            status: result.rejected.length ? 'partial' : 'ok',
            note: String(args.note || `导入 ${result.imported} 条${result.duplicates ? `，重复跳过 ${result.duplicates} 条` : ''}`),
            by: 'agent:shop_accounts',
          });
          patchAccount(account.id, { collection: next });
        }
        return { ok: result.ok !== false, account: account.name, ...result };
      }

      if (action === 'collect-query') {
        const domErr = domainErrorFor(account.platform, args.domain);
        if (domErr) return fail(domErr);
        const result = queryRecords({
          accountId: account.id,
          domain: args.domain || '',
          metric: args.metric || '',
          metricId: args.metricId || '',
          start: args.start || '',
          end: args.end || '',
          limit: args.limit || 500,
        });
        return { ok: true, account: account.name, id: account.id, ...result };
      }

      // ── v0.12.0 目录层：可采指标清单 ─────────────────────────────────────
      if (action === 'catalog') {
        const wantPlatform = String(args.platform || account.platform || '').trim();
        const platform = platformOf(wantPlatform);
        if (!platform) return fail(`未知平台：${wantPlatform}`);
        const domains = domainOptions(platform.id);
        const domain = String(args.domain || '').trim();
        if (domain) {
          const metrics = catalogMetrics(platform.id, domain);
          const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 2000);
          return {
            ok: true,
            platform: platform.id,
            platformLabel: platform.label,
            domain,
            domains,
            metricCount: metrics.length,
            returned: Math.min(metrics.length, limit),
            truncated: metrics.length > limit,
            metrics: metrics.slice(0, limit),
          };
        }
        return {
          ok: true,
          platform: platform.id,
          platformLabel: platform.label,
          domains,
          totalMetrics: catalogMetrics(platform.id).length,
          hint: '再带 domain=<域> 就是该域的指标清单；items 里带的 metricId 必须是这里的 id。',
        };
      }

      // ── v0.13.0 采集 DSL：库存 + 直接跑一份 ───────────────────────────────
      if (action === 'rpa-dsls') {
        const { items, seedDir, externalDir } = listDsls();
        const wantPlatform = String(args.platform || '').trim();
        const list = wantPlatform ? items.filter((d) => d.platform === wantPlatform) : items;
        return {
          ok: true,
          count: list.length,
          total: items.length,
          externalDir,
          seedDir,
          dsls: list.map((d) => `${d.platform}/${d.id}${d.hasDownload ? '（需下载，本版不支持）' : ''}`).slice(0, 200),
          hint: '用 action=collect-run + dsl 参数跑一份（如 collect-run dsl=tb_shop_overview）',
        };
      }

      if (action === 'collect-run') {
        const out = await runCollectionDsl(account, {
          dslId: args.dsl || args.dslId,
          start: args.start,
          end: args.end,
          params: args.params,
          timeoutMs: args.timeoutMs,
        });
        return out;
      }

      // ── 采集作业（v0.14.0 编排：prepare / advance / status）─────────────────
      if (action === 'collect-job') {
        const out = await prepareJobForAccount(account, {
          dslIds: Array.isArray(args.dslIds) ? args.dslIds : (args.dsl ? [args.dsl] : undefined),
          start: args.start,
          end: args.end,
          params: args.params,
          includeDownload: args.includeDownload,
          skipCovered: args.skipCovered,
          drive: args.drive === true,
        });
        if (!out.success) return { ok: false, errors: out.errors };
        return { ok: true, account: account.name, ...out.data };
      }
      if (action === 'collect-advance') {
        const out = advanceJob({
          accountId: account.id,
          jobId: args.jobId,
          revision: args.revision,
          batchId: args.batchId,
          results: args.results,
        }, artifactStatus);
        if (!out.success) return { ok: false, errors: out.errors, ...(out.data || {}) };
        return { ok: true, account: account.name, ...out.data };
      }
      if (action === 'collect-status') {
        return { ok: true, ...statusJob({ accountId: account.id, jobId: args.jobId }).data };
      }
      if (action === 'collect-jobs') {
        return { ok: true, account: account.name, ...listJobs(account.id).data };
      }

      if (action === 'collect-done') {
        const status = String(args.status || '').trim();
        const next = applyCollectionResult(account, { status, note: args.note, by: 'agent:shop_accounts' });
        const patched = patchAccount(account.id, { collection: next });
        return { ok: true, account: patched.name, collection: patched.collection };
      }

      if (action === 'autologin') {
        const pw = getPassword(account.id);
        if (!pw) return { ok: false, code: 'AUTOLOGIN_NO_PASSWORD', error: '这个店铺还没有保存密码（需要在设置页里先设置）', account: account.name };
        const r = await withAccountLock(account.id, () => autoLogin(account, {
          password: pw, backend: backendFor(readConfig()), cfg: readConfig(),
        }));
        if (r && r.loggedIn) {
          const check = await withAccountLock(account.id, () => checkAccount(account, { silent: true })).catch(() => null);
          if (check) patchAccount(account.id, checkPatch(check));
        }
        return { ok: Boolean(r && r.ok !== false), account: account.name, ...r };
      }

      return { ok: false, error: '不认识的 action：' + action };
    },
  });
  const dispose = ctx.tools.register(tool);
  return typeof dispose === 'function' ? dispose : null;
}

/**
 * v0.16.0 一次性迁移：把老数据里「采集自己那套开关/时间」并到排期上。
 *
 * 老版本有两套东西说同一件事：账号的 `schedEnabled`（排期表里的开启/暂停）和
 * 采集配置里的 `collection.enabled` / `collection.time`。升级后调度只认 `schedEnabled`
 * （时间和槽位来自全局排期），所以：
 *   · `collection.enabled === false` **且真的选过采集域**（用户当年在采集卡片里配了域又关掉）
 *     → 迁移成 `schedEnabled:false`，行为保持不变，不会因为升级突然开始自动采集；
 *     ⚠️ 只看 enabled 是不够的：新建店铺时采集配置默认就是 `{enabled:false, domains:[]}`，
 *        按 enabled 判会把**所有**店铺都标成暂停。所以必须同时有域才算"用户明确关过"。
 *   · `collection.enabled === true` → 什么都不动（`schedEnabled` 默认就是开的）；
 *   · `collection.time` 不再影响调度，**留在数据里**不删（老版本降级回去还能看到原来的值）。
 * 幂等：只有真的需要改才写文件，跑几遍都一样。
 */
export function migrateCollectionSchedule(log = { info: () => {}, warn: () => {} }) {
  let store;
  try { store = readAccounts(); } catch (err) {
    log.warn('采集开关迁移：读账号表失败 ' + (err && err.message ? err.message : String(err)));
    return { changed: 0, error: String((err && err.message) || err) };
  }
  const accounts = store.accounts || [];
  let changed = 0;
  const next = accounts.map((a) => {
    const cfg = a && a.collection;
    if (!cfg || cfg.enabled !== false) return a;
    // 必须真的选过域才算"用户明确关过"：新建店铺默认就是 {enabled:false, domains:[]}
    if (!Array.isArray(cfg.domains) || cfg.domains.length === 0) return a;
    if (a.schedEnabled === false) return a; // 已经是暂停的，不用再改
    changed += 1;
    return { ...a, schedEnabled: false };
  });
  if (!changed) return { changed: 0 };
  try {
    writeAccounts(next);
    log.info(`采集开关迁移：${changed} 个店铺原来在采集卡片里关着，已改成排期里的「暂停」`);
  } catch (err) {
    log.warn('采集开关迁移：写账号表失败 ' + (err && err.message ? err.message : String(err)));
    return { changed: 0, error: String((err && err.message) || err) };
  }
  return { changed };
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const log = makeLog(ctx);
  ensureDir(dataDir());

  // v0.16.0：先把老数据的采集开关并到排期上（幂等，只在需要时写一次）
  try { migrateCollectionSchedule(log); } catch { /* 迁移失败不影响挂载 */ }

  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    log.warn('宿主没有 webServer 服务，插件未挂载任何路由');
    return () => {};
  }

  const disposeRoute = webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => {
      handleRequest(req, res).catch((err) => {
        try { sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) }); } catch { /* 已经回过了 */ }
      });
    },
  });

  const disposers = [typeof disposeRoute === 'function' ? disposeRoute : () => {}];

  // 定时检测的"心跳"：每 20 秒看一次排期有没有到点（到位精度远小于一次静默检测的耗时）。
  // 关着排期时空转也只是一次 readConfig，可以忽略；unref 保证它不会拖住宿主退出。
  const schedTimer = setInterval(() => { schedTick(log); }, 20000);
  if (typeof schedTimer.unref === 'function') schedTimer.unref();
  disposers.push(() => clearInterval(schedTimer));

  try {
    const sv = scheduleView();
    const nextText = sv.nextRunAt ? new Date(sv.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '';
    log.info(sv.enabled
      ? `定时检测已开启：每天 ${sv.startTime} 起 · 每组 ${sv.groupSize} 个 · 间隔 ${sv.groupIntervalMin} 分钟${nextText ? ' · 下次 ' + nextText : ''}`
      : '定时检测未开启（设置 → 账号管理 → 调整排期）');
  } catch { /* 状态读不到不影响挂载 */ }

  // tools 是**可选**注入：没有工具服务的 profile（纯 TUI）也要能开设置页
  if (ctx.inject) {
    ctx.inject(['tools'], (scoped) => {
      let disposeTool = null;
      registerTool(scoped)
        .then((d) => {
          disposeTool = d;
          if (d) log.info('已注册工具 shop_accounts');
          else log.warn('工具 shop_accounts 未注册（不影响设置页）');
        })
        .catch((err) => log.warn('注册工具 shop_accounts 失败：' + (err && err.message ? err.message : String(err))));
      return () => { try { if (typeof disposeTool === 'function') disposeTool(); } catch { /* ignore */ } };
    });
  }

  log.info(`已挂载 ${BASE}（数据目录 ${dataDir()}）`);
  return () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
}
