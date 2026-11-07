import { accountPlatformOf } from './login-modes.mjs';
import { appendDebug } from './diagnostics.mjs';
import { backendFor, egoAppRunning, egoAppRunningInvalidate, egoClose, egoLaunchApp, egoList, egoOfflineCookies, egoOpen, egoProbe, egoReset, egoStatus, normalizeEgoProfileId, spaceNameFor } from './ego.mjs';
import { findAccount, loadAccounts, patchAccount } from './accounts.mjs';
import { judgeLogin, normalizeAccountType, platformOf, tokenExpiryOf } from './platforms.mjs';
import { readConfig, setRuntime } from './store.mjs';
import { sleep } from './async-util.mjs';
import { checkPatch } from './identity/login-check.mjs';

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

export let egoInfoCache = { at: 0, data: null, pending: null };
export const EGO_INFO_TTL = 30000;

export function egoInfoStale() { return !egoInfoCache.at || Date.now() - egoInfoCache.at > EGO_INFO_TTL; }

/**
 * 读 ego 的 profile / TaskSpace 列表（带缓存；一次调用要起一次 ego CLI，别每次轮询都打）。
 * **ego 没在跑的时候绝不去起 CLI** —— 那会把整个浏览器拉起来（实测 5.7s、恢复几十个标签、3GB），
 * 用户明明关掉了 ego，一开面板又冒出来。没开就如实报 `running:false`。
 */
export async function refreshEgoInfo(force) {
  if (egoInfoCache.pending) return egoInfoCache.pending;
  const cfg = readConfig();
  const st = egoStatus(cfg);
  if (!st.available) {
    egoInfoCache = { at: Date.now(), data: { available: false, running: false, cli: '', app: '', backend: 'chrome', profiles: [], spaces: [], error: '' } };
    return egoInfoCache.data;
  }
  // v0.19.2：用户手动关掉 ego 之后，30 秒的「空间列表」缓存还会说这些空间都在，
  // 界面于是把「浏览器运行中」一直挂着（详情页也就一直显示「关闭浏览器」）。
  // 进程在不在只要一次 tasklist（自带 5 秒缓存），比列空间的那次 ego CLI 便宜得多，所以先问它：
  // 主程序都没了，就立刻把运行中清掉，不用等缓存过期。
  const appRunning = await egoAppRunning().catch(() => true);
  if (!appRunning) {
    egoInfoCache = {
      at: Date.now(),
      data: {
        available: true, running: false, cli: st.cli, app: st.app, backend: backendFor(cfg),
        profiles: [], spaces: [], error: 'ego lite 没在运行',
      },
    };
    return egoInfoCache.data;
  }
  if (!force && !egoInfoStale() && egoInfoCache.data) return egoInfoCache.data;
  egoInfoCache.pending = (async () => {
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
export function egoInfoSync() {
  if (egoInfoCache.data) return egoInfoCache.data;
  const st = egoStatus(readConfig());
  return { available: st.available, running: false, cli: st.cli, app: st.app, backend: backendFor(readConfig()), profiles: [], spaces: [], error: '' };
}

export function egoSpaceName(account) { return spaceNameFor(account); }

/**
 * 这个店铺的空间是不是开着（ego 里真有这个窗口）。
 * 先按名字认；名字被用户改过就按记下来的 id 认（id 为 0 是 ego 里用户自己建的空间，不算）。
 */
export function egoSpaceExists(space, spaceId) {
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
export function assertEgoSpaceUnique(account) {
  const space = spaceNameFor(account);
  const sameSpace = loadAccounts().find((a) => a.id !== account.id && spaceNameFor(a) === space);
  if (sameSpace) {
    throw new Error(
      `有另一个店铺（${sameSpace.name || sameSpace.id}）和「${account.name || account.id}」用了同一个 ego 空间名「${space}」。` +
      'ego 模式下一个空间只能对应一个店铺，请先给其中一个改名，否则两家的登录态会串在一起。',
    );
  }
}

/**
 * 这个店铺该用哪个 ego profile。
 *   · 账号上已经记了 → 就用它（用户可以在界面/接口里手动指定）；
 *   · 没记 → 挑一个"没被别的店铺占用"的 profile，写回账号（下次就不再挑）；
 *   · 全被占了 → 找 cookie 域不重叠的店铺共用一个（淘宝/天猫/1688 会打架，拼多多/抖音不会）；
 *   · 都不行 → 明确报错（ego 的 SDK 不能新建 profile，只能人去建）。
 */
export async function ensureEgoProfile(account, opts = {}) {
  let explicit = String(account.egoProfile || '').trim();
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
  // 早期版本在 profile 不够用时会顺手把「默认配置」分给店铺，甚至共用（v0.18.2 前的真实案例）：
  // 默认配置里是**用户自己的浏览器与登录态**，拿它开店会出现「一打开就是我自己之前登录的账号」，
  // 也没法在一个干净环境里重新登录。发现这种记录就清掉重新分配（只要不是默认配置就照旧用）。
  if (explicit && account.egoSharedProfile === true
    && profiles.some((p) => p && String(p.id) === explicit && p.isDefault)) {
    appendDebug('ego-profile-default-shared', { account: account.id, egoProfile: explicit });
    patchAccount(account.id, { egoProfile: '', egoSharedProfile: false, egoSpaceId: 0 });
    account = findAccount(account.id) || account;
    explicit = '';
  }
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
  const platform = accountPlatformOf(account) || platformOf(account.platform);
  // 共用规则要按「平台 × 身份」判断：不同平台可以共用一份配置，同平台同身份的第二家店必须分开。
  const others = loadAccounts()
    .filter((a) => a.id !== account.id && String(a.egoProfile || '').trim())
    .map((a) => ({
      id: a.id,
      egoProfile: String(a.egoProfile),
      platform: String(a.platform || ''),
      accountType: String(normalizeAccountType(a.accountType) || 'seller'),
      cookieDomains: (accountPlatformOf(a) || {}).cookieDomains || [],
    }));
  const picked = allocateEgoProfile({
    profiles,
    others,
    platform: String(account.platform || ''),
    accountType: String(normalizeAccountType(account.accountType) || 'seller'),
    cookieDomains: (platform && platform.cookieDomains) || [],
  });
  const changed = String((findAccount(account.id) || {}).egoProfile || '') !== picked.profileId;
  const patch = picked.shared
    ? { egoProfile: picked.profileId, egoSharedProfile: true }
    : { egoProfile: picked.profileId, egoSharedProfile: false };
  // 空间（TaskSpace）是「某个 profile 里的窗口」：ego 的 profileId 只在**新建**空间时生效。
  // profile 换了还沿用旧 spaceId，就会把窗口开回旧配置里去（比如继续用用户自己的浏览器档案）。
  if (changed) patch.egoSpaceId = 0;
  patchAccount(account.id, patch);
  return picked.profileId;
}

/**
 * 给一个店铺挑一份 ego profile（纯函数，便于单测）。
 *
 * 规则（v0.18.4，按真实用法改）：
 *  1. **默认配置永远留给用户自己** —— 里面是用户自己的浏览器与登录态；分给店铺会出现
 *     「一打开就是我自己之前登录的账号」，也没法在干净环境里重新登录。
 *  2. 优先用完全空着的「用户配置」。
 *  3. 没有空配置时**可以共用**：不同平台的店铺（抖音 / 千牛 / 拼多多…）共用一份配置、
 *     各自开自己的空间就行；同一平台的**买家与卖家**也能共用。
 *  4. 只有**同一平台 + 同一身份**的第二家店必须分开（cookie 同名同域，挤在一起会互相覆盖）；
 *     真挤不下时如实报错，让用户去 ego 里多建一个「用户配置」。
 *  5. `allowShare: false` 用于自救/调试：只接受完全空着的配置。
 */
export function allocateEgoProfile({ profiles = [], others = [], platform = '', accountType = '', cookieDomains = [], allowShare = true } = {}) {
  const list = (profiles || []).filter((p) => p && String(p.id || '').trim());
  const own = list.filter((p) => !p.isDefault);
  const reservedDefault = list.length > own.length;
  const othersList = Array.isArray(others) ? others : [];
  const idOf = (o) => String((o && o.egoProfile) || '');
  // 「同一平台 + 同一身份」才是必须分开的那种：cookie 同名同域，挤在一份配置里会互相覆盖登录态。
  // 不同平台（抖音 / 千牛 / 拼多多…）可以共用一份配置；同一平台的买家与卖家也可以共用。
  const sameIdentity = (o) => String((o && o.platform) || '') === String(platform || '')
    && String((o && o.accountType) || '') === String(accountType || '');
  const rows = own.map((p) => {
    const id = String(p.id);
    const occupants = othersList.filter((o) => idOf(o) === id);
    return { id, name: String(p.name || ''), occupants, conflict: occupants.some(sameIdentity) };
  });
  // 1) 先看有没有完全空着的配置 —— 空配置不与人共登录态，最干净。
  const free = rows.filter((r) => !r.occupants.length);
  if (free.length) return { profileId: free[0].id, shared: false, profileName: free[0].name, reservedDefault };
  // 2) 都有人了：允许共用时，挑一个「现有店主都跟它不冲突」的配置挤进去（配置数才是稀缺的）。
  if (allowShare) {
    const compatible = rows.filter((r) => !r.conflict);
    if (compatible.length) {
      return { profileId: compatible[0].id, shared: true, profileName: compatible[0].name, reservedDefault };
    }
  }
  throw new Error(
    `ego 里没有可用的「用户配置」了：同一平台、同一身份的店铺必须用各自独立的配置（不同平台的店铺可以共用一份）。` +
    `请在 ego 里新建一个「用户配置」再打开这个店铺（现在 ${own.length} 个用户配置、${list.length - own.length} 个默认配置）。`,
  );
}

/**
 * 用户明确要开窗口的动作（打开 / 重置）可以把 ego 主程序拉起来。
 * 只读动作不许调用这里 —— 拉起来会把上次所有窗口一起恢复（实测 5.7s / 30 进程 / 3GB）。
 */
export async function ensureEgoApp(cfg) {
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
export async function egoRunInfo(account, opts = {}) {
  const platform = platformOf(account.platform);
  if (!platform) throw new Error(`未知平台 ${account.platform}`);
  assertEgoSpaceUnique(account);
  const profileId = await ensureEgoProfile(account, opts);
  return { platform, profileId, space: egoSpaceName(account), cfg: readConfig() };
}

/** ego 后端的「打开」：建/复用 TaskSpace，把页面导到工作台或登录页。 */
export async function egoOpenAccount(account, mode) {
  const { platform, profileId, space, cfg } = await egoRunInfo(account, { launch: true });
  // egoRunInfo 返回的是平台基础定义，打开要用「平台 × 身份」的变体（买家/卖家入口不同）
  const pv = accountPlatformOf(account) || platform;
  const shopUrl = String(account.url || '').trim();
  const workUrl = shopUrl || pv.workUrl || pv.homeUrl;
  const urls = mode === 'login'
    ? [pv.loginUrl]
    : [workUrl].concat(cfg.openWorkTab && workUrl !== pv.homeUrl ? [pv.homeUrl] : []);
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
    // v0.19.8：窗口刚打开时的 cookie 罐（含身份 cookie 的值），调用方据此判断「其实已经登录了」
    cookies: Array.isArray(r.cookies) ? r.cookies : null, cookieError: r.cookieError || '',
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
export async function egoCheckAccount(account, opts = {}) {
  const cfg = readConfig();
  const platform = accountPlatformOf(account) || platformOf(account.platform);
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
export async function egoCloseAccount(account, opts = {}) {
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
export async function egoResetAccount(account) {
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
export async function egoFinishAccount(account) {
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
