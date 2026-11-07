import { acquireAccountLock } from './locks.mjs';
import { applyCollectionResult, collectionReady } from './collection.mjs';
import { autoLogin } from './autologin.mjs';
import { backendFor } from './ego.mjs';
import { browserUp } from './cdp.mjs';
import { checkAccount } from './identity/login-state.mjs';
import { SCHEDULE_DEFAULTS, dueRows, groupSizeFor, markRan, nextRun, normalizeSchedule, planSchedule } from './schedule.mjs';
import { findAccount, loadAccounts, patchAccount } from './accounts.mjs';
import { getPassword } from './vault.mjs';
import { isBuyerAccount, prepareJobForAccount } from './collect-support.mjs';
import { listDsls } from './dsls.mjs';
import { loginModeOf } from './login-modes.mjs';
import { readAccounts, readConfig, writeAccounts, writeConfig } from './store.mjs';
import { appendDebug } from './diagnostics.mjs';
import { checkPatch } from './identity/login-check.mjs';
import { platformOf, normalizeAccountType, supportsPasswordLogin, looksLikeLoginPage } from './platforms.mjs';
import { egoOpenAccount, egoSpaceName, refreshEgoInfo, egoInfoSync } from './ego-lifecycle.mjs';
import { openAccount, closeAccount } from './account-ops.mjs';

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
export function memGB() {
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
export function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`超时（${Math.round(ms / 1000)} 秒没结果）`), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

export let schedBusy = false;

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
    // v0.18.11：买家账号永远不走采集，只做静默登录检测。
    const wantsCollect = s.mode !== 'check' && !isBuyerAccount(account) && collectionReady(account);
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
export async function schedTick(log) {
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
