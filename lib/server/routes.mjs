import os from 'node:os';
import { BASE, REQ_HEADER } from '../plugin-consts.mjs';
import { sendJson, readJsonBody } from '../http-json.mjs';
import { capStr } from '../text.mjs';
import { PLATFORMS, accountTypeLabel, accountTypeSupport, isValidAccountType, judgeLogin, loginMethodsOf, normalizeAccountType, platformOf, supportsPasswordLogin } from '../platforms.mjs';
import { LOGIN_MODES, accountPlatformOf, loginMethodLabel, loginModeLabelOf, loginModeOf, normalizeLoginMode } from '../login-modes.mjs';
import { accountProfileDir, deletableProfileDir, findAccount, findDuplicateLoginName, importStores, loadAccounts, normalizeOptionalDir, normalizeProfileRoot, patchAccount, saveAccounts, exportStores } from '../accounts.mjs';
import { dataDir, isInsideProfileRoot, newAccountId, normalizeImportedProfileDir, profileDirFor, readConfig, setRuntime, writeConfig } from '../store.mjs';
import { allowedDomains, domainOptions } from '../domains.mjs';
import { backendFor, egoHandOff, egoLaunchApp, normalizeEgoProfileId, spaceNameFor } from '../ego.mjs';
import { egoCloseAccount, egoFinishAccount, egoInfoSync, refreshEgoInfo, egoOpenAccount, egoResetAccount, egoCheckAccount } from '../ego-backend.mjs';
import { browserUp } from '../cdp.mjs';
import { killChromeForProfile, resolveBrowserPath, safeNavUrl } from '../chrome.mjs';
import { clearPassword, getPassword, normalizePassword, setPassword, vaultAvailable, removeAccountSecret } from '../vault.mjs';
import { applyCollectionResult, collectionPrompt, collectionRangeText, normalizeCollection } from '../collection.mjs';
import { importRecords, planCollection, queryRecords, removeCollectionStore } from '../datastore.mjs';
import { catalogInfo, catalogMetrics, unknownMetricIds } from '../catalog.mjs';
import { advanceJob, jobDirFor, listJobs, statusJob } from '../collect-runner.mjs';
import { artifactStatus } from '../rpa.mjs';
import { listDsls } from '../dsls.mjs';
import { groupSizeFor, normalizeSchedule, planSchedule, SCHEDULE_DEFAULTS } from '../schedule.mjs';
import { memGB, scheduleView, schedSlotOf } from '../scheduler-run.mjs';
import { checkAccount, navigatePageTo, pickSiteUrl, quickLoginState, readLoginFrom, waitForIdentityCookies, settlePage } from '../login-state.mjs';
import { checkPatch } from '../login-check.mjs';
import { sleep } from '../async-util.mjs';
import { acquireAccountLock, withAccountLock } from '../locks.mjs';
import { closeAccount, openAccount, resetAccount } from '../account-ops.mjs';
import { rememberLiveCookies, snapshotAccount } from '../cookies.mjs';
import { autoLogin } from '../autologin.mjs';
import { appendDebug, readClientErrors, recordClientError } from '../diagnostics.mjs';
import { hostHeaderAllowed } from '../http-guard.mjs';
import { normalizeExePath, validateUpdateDir } from '../self-update-paths.mjs';
import { LOADED_VERSION, applyUpdate, checkUpdate, detectUpdateDir, ownVersion } from '../self-update.mjs';
import * as osPlatform from '../platform/index.mjs';
import { BUYER_COLLECT_UNSUPPORTED, domainErrorFor, isBuyerAccount, prepareJobForAccount, runCollectionDsl } from '../collect-support.mjs';
import { buildState } from './state.mjs';

// ── 路由 ────────────────────────────────────────────────────────────────────

export async function handleRequest(req, res) {
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
    if (method === 'GET' && p === '/state') {
      // ?fresh=1：强制重列 ego 空间（界面可见时的 2 秒轮询用），默认走 30 秒缓存。
      return sendJson(res, 200, await buildState(url.searchParams.get('fresh') === '1'));
    }

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
      // v0.18.11：买家账号不做采集 —— 建买家账号时忽略采集配置，永远建成"空采集"。
      let collection = null;
      try {
        collection = isBuyerAccount({ accountType })
          ? normalizeCollection({}, {}, { allow: allowedDomains(platform.id) })
          : normalizeCollection(body.collection || {}, {}, { allow: allowedDomains(platform.id) });
      } catch (err) {
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
        // v0.18.11：买家账号不配采集 —— 改成买家时把采集清空（历史数据不保留，因为买家本来采不到）
        const typeNow = normalizeAccountType(patch.accountType || account.accountType);
        try {
          patch.collection = typeNow === 'buyer'
            ? normalizeCollection({}, {}, { allow: allowedDomains(account.platform) })
            : normalizeCollection(body.collection, account.collection || {}, { allow: allowedDomains(account.platform) });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) });
        }
      } else if (normalizeAccountType(patch.accountType || account.accountType) === 'buyer') {
        // 卖家改成买家：即使没显式传 collection，也要把原来的采集域清掉（否则定时任务还会按老配置去跑）
        patch.collection = normalizeCollection({}, {}, { allow: allowedDomains(account.platform) });
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
        // v0.19.8：窗口里已经是登录状态时不做代填 —— 代填会先把页面导回登录地址、再填一遍账号密码
        const already = await quickLoginState(account);
        if (already) {
          return sendJson(res, 200, {
            ok: true,
            account: account.name,
            platform: account.platform,
            accountType: normalizeAccountType(account.accountType),
            result: {
              ok: true, skipped: true, code: 'AUTOLOGIN_ALREADY_LOGGED_IN', loggedIn: true,
              hint: '窗口里已经是登录状态，这次没有代填', login: already,
            },
          });
        }
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
      // v0.18.11：买家账号没有商家后台的报表页面，采集相关入口一律拒绝（只读的历史接口留着，返回空即可）
      if (isBuyerAccount(account) && kind !== 'collect-records' && kind !== 'collect-jobs') {
        return sendJson(res, 400, { ok: false, code: 'COLLECTION_UNSUPPORTED_BUYER', error: BUYER_COLLECT_UNSUPPORTED });
      }
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
        appendDebug('open', { account: account.id, platform: account.platform, mode, snap: await snapshotAccount(account, accountPlatformOf(account)) });
        // v0.19.8：先看窗口里到底是不是已经登录了。已经登录还去代填，代填会先把页面导回登录地址
        // 再填一遍账号密码 —— 用户看到的就是「明明已经登录，又自己退回去登了一遍」。
        const openPlatform = accountPlatformOf(account) || platformOf(account.platform);
        let liveLogin = null;
        try {
          if (Array.isArray(r.cookies) && r.cookies.length) {
            liveLogin = judgeLogin(r.cookies, r.url || '', openPlatform, {
              cookieReadOk: true,
              accountType: normalizeAccountType(account.accountType),
            });
          } else if (Number(r.port) > 0) {
            liveLogin = await readLoginFrom(Number(r.port), openPlatform, r.url || '');
          }
        } catch (err) {
          liveLogin = null;
        }
        const alreadyLoggedIn = Boolean(liveLogin && liveLogin.loggedIn);
        // v0.9.2：账密登录是「打开」的一部分，不用再单独点一次「自动登录」。
        // 已经存了账号+密码就自动代填一次；body.autofill === false 时只开窗口（扫码/手工登录场景）。
        let autofill = null;
        // v0.16.6：身份没有账号密码登录（拼多多 C 端只有验证码/扫码）时直接不尝试
        // v0.17.0：这家店选了「扫码或手动登录」时也不尝试 —— 只把窗口开出来给人扫码
        if (body.autofill !== false && loginModeOf(account) !== 'qrcode' && account.loginName
          && supportsPasswordLogin(account.platform, normalizeAccountType(account.accountType))) {
          if (alreadyLoggedIn) {
            // v0.19.8：窗口里已经是登录状态，这次不代填（也不要把人踢回登录页）
            autofill = {
              attempted: false,
              ok: true,
              code: 'AUTOLOGIN_ALREADY_LOGGED_IN',
              hint: '窗口里已经是登录状态，这次没有代填',
              loggedIn: true,
            };
          } else {
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
        }
        return sendJson(res, 200, { ok: true, ...r, login: liveLogin, autofill });
      }

      if (action === 'reset') {
        const r = await resetAccount(account);
        return sendJson(res, r.ok === false ? 500 : 200, r);
      }

      if (action === 'close') {
        const before = await snapshotAccount(account, accountPlatformOf(account));
        const r = await closeAccount(account);
        appendDebug('close', { account: account.id, platform: account.platform, closed: r, snapBefore: before });
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (action === 'check' || action === 'silent-check') {
        const silent = action === 'silent-check';
        const body = await readJsonBody(req);
        // 手动「检测」默认不保活（要快）；带 keepaliveSec 就多待一会儿再复查一遍。
        const snapBefore = await snapshotAccount(account, accountPlatformOf(account));
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

