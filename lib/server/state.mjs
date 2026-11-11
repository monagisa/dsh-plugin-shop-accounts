import { ACCOUNT_TYPES, accountTypeLabel, capabilitiesOf, normalizeAccountType, platformList, platformOf } from '../platforms.mjs';
import { LOADED_VERSION, detectUpdateDir, ownVersion } from '../self-update.mjs';
import { LOGIN_MODES, loginModeLabelOf, loginModeOf } from '../login-modes.mjs';
import { accountProfileDir } from '../accounts.mjs';
import path from 'node:path';
import { accountsPath, configPath, dataDir, readAccounts, readConfig } from '../store.mjs';
import { allowedDomains, domainOptions } from '../domains.mjs';
import { backendFor } from '../ego.mjs';
import { browserUp } from '../cdp.mjs';
import { catalogInfo } from '../catalog.mjs';
import { COLLECTION_LABELS, collectionReady, domainList, dueCollections, isCollectionDue, normalizeCollection } from '../collection.mjs';
import { collectionSummary } from '../datastore.mjs';
import { egoInfoSync, egoSpaceExists, egoSpaceName, refreshEgoInfo } from '../ego-lifecycle.mjs';
import { hasPassword, passwordUpdatedAt, vaultInfo } from '../vault.mjs';
import { isBuyerAccount } from '../collect-support.mjs';
import * as osPlatform from '../platform/index.mjs';
import { resolveBrowserPath } from '../chrome.mjs';
import { scheduleView } from '../scheduler-run.mjs';
import { dataDirInfo } from '../data-dir.mjs';

// ── 状态组装 ────────────────────────────────────────────────────────────────

export async function buildState(freshEgo) {
  const cfg = readConfig();
  const { accounts, error } = readAccounts();
  const browserPath = resolveBrowserPath(cfg.browserPath);
  const backend = backendFor(cfg);
  // ego 的 profile/TaskSpace 列表（带缓存；ego 没装就直接是 available:false）
  // 只有真的在用 ego 时才去起 ego CLI 读列表 —— 用 Chrome 的时候每 30 秒起一个 ego 进程太浪费，
  // 而且 ego 没开着的话还可能把浏览器窗口弹出来。设置页点「刷新 ego」/切到 ego 后端时才强制读。
  // v0.19.3：界面可见时会带 ?fresh=1 来（每 2 秒对一次），这时候也强制重列空间，
  // 用户在外面关掉某一个空间后，界面最多 2 秒就跟上，不用再等 30 秒的列表缓存。
  const ego = backend === 'egolite'
    ? await refreshEgoInfo(freshEgo ? true : false).catch(() => egoInfoSync())
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
      // v0.18.11：买家账号不做采集 —— 采集配置强制成空（历史数据不动，只是不再对外呈现/不再生效）
      collection: isBuyerAccount(a)
        ? { enabled: false, domains: [], time: '', lastRunAt: null, lastRunStatus: '', lastRunNote: '', lastRunBy: '' }
        : (() => {
          try { return normalizeCollection({}, a.collection || {}, { allow: allowedDomains(a.platform) }); } catch { return { enabled: false, domains: [], time: '' }; }
        })(),
      // v0.16.0：这个店配了采集没有（= 选了采集域 且 没被老开关显式关掉）—— 界面用它决定"定时采集会跑吗"
      collectionReady: !isBuyerAccount(a) && collectionReady(a),
      // v0.12.0 目录层：这个平台的采集域与各域指标数（淘宝/天猫多「竞争洞察」）
      collectionDomains: isBuyerAccount(a) ? [] : (() => { try { return domainOptions(a.platform); } catch { return domainList(); } })(),
      // v0.16.0：到期判断用**排期槽位时间**（不再用 collection.time，那个已经不影响调度）
      collectionDue: isBuyerAccount(a) ? false : (() => { try { return isCollectionDue(a, new Date(), { time: schedById.has(a.id) ? schedById.get(a.id).time : '' }); } catch { return false; } })(),
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
    // v0.20.16：把「采集数据保存在哪」也发给界面（数据集里 config/accounts 之外还有 collection 目录）。
    paths: {
      config: configPath(),
      accounts: accountsPath(),
      collection: path.join(dataDir(), 'collection'),
      // v0.20.17：数据目录本身也发给界面（设置页可以看、可以打开、可以改）。
      data: dataDir(),
    },
    dataDirInfo: dataDirInfo(),
    storeError: error,
  };
}

