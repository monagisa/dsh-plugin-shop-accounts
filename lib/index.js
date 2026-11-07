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

import { maskSecrets, capStr } from './text.mjs';
import { PLUGIN, BASE, REQ_HEADER, BODY_LIMIT } from './plugin-consts.mjs';
import { loginMethodLabel, LOGIN_MODES, normalizeLoginMode, loginModeLabelOf, loginModeOf, accountPlatformOf } from './login-modes.mjs';
import { sendJson, readJsonBody } from './http-json.mjs';

import { DEBUG_LOG_MAX, appendDebug, makeLog, CLIENT_ERROR_LOG, CLIENT_ERROR_KEEP, clientErrorPath, recordClientError, readClientErrors } from './diagnostics.mjs';
import { snapshotAccount, sessionCookieFile, saveSessionCookies, loadSessionCookies, restoreSessionCookies, rememberLiveCookies } from './cookies.mjs';
import { PKG_ROOT, versionOfDir, ownVersion, LOADED_VERSION, runGit, detectUpdateDir, cmpVersion, upstreamOf, checkUpdate, syncFromSource, applyUpdate } from './self-update.mjs';
import { loadAccounts, saveAccounts, findAccount, patchAccount, loginNameKey, findDuplicateInList, findDuplicateLoginName, EXPORT_FORMAT, EXPORT_VERSION, EXPORT_MAX_ACCOUNTS, exportStores, importStores, accountProfileDir, deletableProfileDir, normalizeProfileRoot, normalizeOptionalDir } from './accounts.mjs';
import { hostHeaderAllowed } from './http-guard.mjs';
import { normalizeExePath, validateUpdateDir } from './self-update-paths.mjs';

import { allowedDomains, domainOptions } from './domains.mjs';
import { samePath, RUNTIME_TTL_MS, runtimeEntryMine, portOwnership, ourBrowserOnPort, verifyFreshLaunch } from './port-ownership.mjs';

import { accountLocks, accountBusy, withAccountLock, acquireAccountLock } from './locks.mjs';

import { sleep } from './async-util.mjs';
import { checkPatch } from './login-check.mjs';
import { egoInfoCache, EGO_INFO_TTL, egoInfoStale, refreshEgoInfo, egoInfoSync, egoSpaceName, egoSpaceExists, assertEgoSpaceUnique, ensureEgoProfile, allocateEgoProfile, ensureEgoApp, egoRunInfo, egoOpenAccount, egoCheckAccount, egoCloseAccount, egoResetAccount, egoFinishAccount } from './ego-backend.mjs';

import { checkAccount, pickSiteUrl, readLoginFrom, quickLoginState, navigatePageTo, waitForIdentityCookies, settlePage } from './login-state.mjs';
import { allocatePort, openAccount, closeAccount, resetAccount } from './account-ops.mjs';

import { isBuyerAccount, BUYER_COLLECT_UNSUPPORTED, runCollectionDsl, prepareJobForAccount, executeOps, domainErrorFor } from './collect-support.mjs';

import { memGB, scheduleView, schedSlotOf, withTimeout, schedBusy, tickSchedule, runScheduledCollection, schedTick, migrateCollectionSchedule } from './scheduler-run.mjs';

import { buildState } from './server/state.mjs';

import { handleRequest } from './server/routes.mjs';

import { defineToolPromise, loadDefineTool, pickAccount, registerTool } from './server/tools.mjs';


// P1 拆分后对外导出面保持不变：这些名字原来就由本插件导出，搬进独立模块后在这里再导出一次。
export { maskSecrets } from './text.mjs';
export { LOGIN_MODES, normalizeLoginMode, loginModeOf, accountPlatformOf } from './login-modes.mjs';
export { PKG_ROOT, versionOfDir, ownVersion, LOADED_VERSION, runGit, detectUpdateDir, cmpVersion, upstreamOf, checkUpdate, syncFromSource, applyUpdate } from './self-update.mjs';
export { snapshotAccount, sessionCookieFile, saveSessionCookies, loadSessionCookies, restoreSessionCookies, rememberLiveCookies } from './cookies.mjs';
export { loadAccounts, saveAccounts, findAccount, patchAccount, loginNameKey, exportStores, importStores, accountProfileDir, deletableProfileDir, normalizeProfileRoot, normalizeOptionalDir } from './accounts.mjs';
export { hostHeaderAllowed } from './http-guard.mjs';
export { normalizeExePath, validateUpdateDir } from './self-update-paths.mjs';
export { appendDebug, makeLog, CLIENT_ERROR_LOG, CLIENT_ERROR_KEEP, clientErrorPath, recordClientError, readClientErrors } from './diagnostics.mjs';
export { allowedDomains, domainOptions, domainsOverlap } from './domains.mjs';
export { allocateEgoProfile } from './ego-backend.mjs';
export { waitForIdentityCookies, settlePage } from './login-state.mjs';
export { scheduleView, schedSlotOf, tickSchedule, runScheduledCollection, migrateCollectionSchedule } from './scheduler-run.mjs';

export const name = 'dsh-plugin-shop-accounts';

export const inject = ['webServer'];

// 导出给自检用：同一家店的 ego 动作必须串行（路由/定时检测/agent 工具共用这把锁）。
// 放在这里而不是只给内部用，是因为锁的「等待-重检查」顺序很容易写错，需要有真并发的回归测试绑住。
export { acquireAccountLock, withAccountLock };

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
