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

import { PLATFORMS, platformOf, platformList, judgeLogin, tokenExpiryOf } from './platforms.mjs';
import {
  accountsPath, configPath, dataDir, ensureDir, newAccountId,
  profileDirFor, readAccounts, readConfig, readRuntime, setRuntime, writeAccounts, writeConfig,
} from './store.mjs';
import {
  chromeOwnerOfPort, isPortFree, launchBrowser, killChromeForProfile, pickPort, removeProfileDir,
  resolveBrowserPath, waitForCdp, waitPortGone,
} from './chrome.mjs';
import { browserUp, closeBrowser, evaluateOn, getAllCookies, listPages, newPage } from './cdp.mjs';
import {
  SCHEDULE_DEFAULTS, dueRows, groupSizeFor, markRan, nextRun, normalizeSchedule, planSchedule,
} from './schedule.mjs';

export const name = 'dsh-plugin-shop-accounts';

/** 等一会儿（保活停留用）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 路由是硬需求；`tools` 走可选注入（见下方 apply）—— 没有工具服务也不该拖垮设置页。 */
export const inject = ['webServer'];

const PLUGIN = 'shop-accounts';
/** 本插件 HTTP 面的路径前缀（客户端半身里的 BASE 必须与之一致）。 */
const BASE = '/shop-accounts';
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

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        try { req.destroy(); } catch { /* 已经断了 */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('请求体不是合法 JSON：' + err.message)); }
    });
    req.on('error', reject);
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

/** 跑一次 git（同步、带超时、绝不抛）。GIT_TERMINAL_PROMPT=0：凭据缺失时宁可失败也不要挂住。 */
function runGit(dir, args, timeoutMs = 30000) {
  try {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return {
      ok: r.status === 0,
      out: String(r.stdout || '').trim(),
      err: String(r.stderr || '').trim() || (r.error ? String(r.error.message || r.error) : ''),
    };
  } catch (err) {
    return { ok: false, out: '', err: err && err.message ? err.message : String(err) };
  }
}

/**
 * 源码目录在哪：优先用设置里手填的；否则按「自己是不是 git 仓库」→「profile 的
 * `file:` / `link:` 依赖」两步猜。猜不到就返回 ''，让界面提示去填。
 */
function detectUpdateDir() {
  const configured = String(readConfig().updateDir || '').trim();
  if (configured) return path.resolve(configured);
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
  const dir = opts.updateDir ? path.resolve(opts.updateDir) : detectUpdateDir();
  if (!dir) {
    return {
      ok: false,
      localVersion,
      updateDir: '',
      error: '找不到本插件的 git 源码目录 —— 在下面「更新源目录」里填一下（例如 D:\\dycopy\\dsh-plugin-shop-accounts）',
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

/** 把源码目录里的运行文件覆盖到目标目录（默认 = 这份安装拷贝；源码目录 == 目标时跳过）。 */
export function syncFromSource(dir, target = PKG_ROOT) {
  const dst = path.resolve(target);
  if (path.resolve(dir) === dst) return { copied: 0, target: dst, sameDir: true };
  const items = ['lib', 'test', 'package.json', 'README.md'];
  let copied = 0;
  for (const item of items) {
    const src = path.join(dir, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dst, item), { recursive: true, force: true });
    copied += 1;
  }
  return { copied, target: dst, sameDir: false };
}

/** 一键更新：快进合并 + 覆盖安装拷贝。返回最终状态（含 `updated` / `restartRequired`）。 */
export async function applyUpdate(opts = {}) {
  const target = path.resolve(opts.target || PKG_ROOT);
  const info = await checkUpdate(opts);
  if (!info.ok) return info;
  const dir = info.updateDir;
  if (!info.needsUpdate) {
    return { ...info, updated: false, copied: 0, restartRequired: false };
  }
  let merged = false;
  if (info.behind > 0) {
    const dirty = runGit(dir, ['status', '--porcelain']);
    if (dirty.ok && dirty.out) {
      return { ...info, ok: false, updated: false, error: '源码目录里有未提交的改动，先处理干净再更新：' + dir };
    }
    const m = runGit(dir, ['merge', '--ff-only', info.upstream], 60000);
    if (!m.ok) {
      return { ...info, ok: false, updated: false, error: '快进合并失败：' + (m.err || m.out || '未知原因') };
    }
    merged = true;
  }
  const synced = syncFromSource(dir, target);
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

/** 档案目录：优先用账号上记的（可能是"导入已有目录"），否则按 id 推。 */
function accountProfileDir(account, cfg) {
  if (account && account.profileDir && String(account.profileDir).trim()) return String(account.profileDir);
  return profileDirFor(account.id, cfg);
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
  const port = Number(account.port) || 0;
  const running = port ? await browserUp(port, 900) : false;

  if (running) {
    const live = await readLoginFrom(port, platform);
    return { ok: true, ...live, running: true, stale: false, checkedAt: new Date().toISOString() };
  }

  if (opts.silent) {
    const exe = resolveBrowserPath(cfg.browserPath);
    if (!exe) {
      return { ok: false, loggedIn: false, evidence: 'none', reason: '找不到 Chrome/Edge 可执行文件，无法静默检测', running: false, stale: false };
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
        urls: [platform.homeUrl],
        headless: true,
      });
      const up = await waitForCdp(probePort, 20000);
      if (!up) {
        return { ok: false, loggedIn: false, evidence: 'none', reason: '无头检测：调试端口没起来', running: false, stale: false };
      }
      const settled = await settlePage(probePort, platform, 12000);
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
      await closeBrowser(probePort);
      if (!(await waitPortGone(probePort, 5000))) await killChromeForProfile(dir);
      return { ok: true, ...live, running: false, silent: true, stale: false, checkedAt: new Date().toISOString() };
    } catch (err) {
      try { await closeBrowser(probePort); } catch { /* ignore */ }
      try { await killChromeForProfile(dir); } catch { /* ignore */ }
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
    // 多标签页时优先挑本平台的（别把无关页当导航结果）
    const inSite = (p) => domains.some((d) => String(p.url || '').toLowerCase().includes(d));
    const target = pages.find((p) => /^https?:/i.test(p.url || '') && inSite(p))
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
 * 这个端口上的 Chrome 是不是这个账号的那只？
 * 先查我们自己起浏览器时留下的登记表（快、准），查不到再去问进程命令行（慢一点但更权威）。
 * 两条都问不出来 → 返回 true（乐观：那个端口本来就是分给这个账号的，不能因为查不到就拒绝）。
 */
async function ourBrowserOnPort(account, port, dir) {
  const entry = readRuntime()[account.id];
  if (entry && Number(entry.port) === Number(port) && samePath(entry.profileDir, dir)) return true;
  const owner = await chromeOwnerOfPort(port);
  if (owner) return samePath(owner, dir);
  return true;
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
  const exe = resolveBrowserPath(cfg.browserPath);
  if (!exe) throw new Error('找不到 Chrome / Edge。请在下方「浏览器设置」里手动指定 chrome.exe 的完整路径。');

  const dir = accountProfileDir(account, cfg);
  ensureDir(dir);

  // 账号上记的「店铺 URL」优先（那是这个店铺自己的工作台/后台页）；否则用平台的默认工作台
  const shopUrl = String(account.url || '').trim();
  const workUrl = shopUrl || platform.workUrl || platform.homeUrl;
  const urls = mode === 'login'
    ? [platform.loginUrl]
    : [workUrl].concat(cfg.openWorkTab && workUrl !== platform.homeUrl ? [platform.homeUrl] : []);

  const pinned = Number(account.port) || 0;
  if (pinned && (await browserUp(pinned, 800))) {
    if (await ourBrowserOnPort(account, pinned, dir)) {
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
      setRuntime(account.id, { port: pinned, profileDir: dir, pid: 0, reused: true });
      return { port: pinned, pid: 0, reused: true, profileDir: dir, mode, cdpUrl: `http://127.0.0.1:${pinned}`, browser: exe, urls };
    }
    // 端口被别的 Chrome 占着：往下走，另起一个端口，别往别人窗口里塞标签页
  }

  const port = await allocatePort(account, cfg);
  if (!port) throw new Error('找不到空闲调试端口（9222 起 200 个都被占了）。可在「浏览器设置」里改起始端口。');

  const { pid } = launchBrowser({ exe, profileDir: dir, port, urls });
  const up = await waitForCdp(port, 30000);
  if (!up) {
    // 端口没起来通常有两种原因：档案被另一个 Chrome 实例占着（单实例锁），或启动失败
    throw new Error(`浏览器窗口起来了但调试端口 ${port} 没响应（多半是这个档案已被别的 Chrome 进程占用）。`);
  }
  if (!(await ourBrowserOnPort(account, port, dir))) {
    throw new Error(`调试端口 ${port} 上是另一个 Chrome（不是这个店铺的档案）。请在「浏览器设置」里换个起始端口，或先关掉那个 Chrome 再试。`);
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
  const port = Number(account.port) || 0;
  const dir = accountProfileDir(account, cfg);
  let closedBy = 'none';
  if (port && (await browserUp(port, 900))) {
    if (cfg.gracefulClose !== false) {
      const asked = await closeBrowser(port);
      if (asked && (await waitPortGone(port, 8000))) closedBy = 'cdp';
    }
    if (closedBy === 'none' && (await browserUp(port, 700))) {
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
  const dir = accountProfileDir(account, cfg);
  const closed = await closeAccount(account);
  const removed = await removeProfileDir(dir);
  if (!removed.ok) {
    return { ok: false, error: `档案删不掉（${removed.error || '未知原因'}）—— 先把那个店铺的 Chrome 窗口关掉再试`, dir, closed };
  }
  patchAccount(account.id, { port: 0, lastCheck: null, lastCheckAt: null, lastLoginAt: null, pendingLogin: false });
  const r = await openAccount({ ...account, port: 0 }, 'login');
  return { ok: true, dir, closed, removed, ...r };
}

// ── 定时检测 ────────────────────────────────────────────────────────────────
//
// 规则（排期算法在 schedule.mjs，这里只负责"到点真的去跑"）：
//   每天 startTime 起，全部店铺按 order 排队，每 groupSize 个一组、组间隔 groupIntervalMin；
//   到点跑**静默检测**（无头 Chrome 探一次，不弹窗），结果写回 lastCheck / lastLoginAt，
//   于是列表里的「登录状态」自己就刷新了 —— 不用人一个个点「检测」。
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

let schedBusy = false;

/**
 * 跑一轮到点的定时检测。
 * - **先记账再执行**：失败也算跑过，否则每 20 秒重试一次会把无头 Chrome 起爆；
 * - 浏览器正开着 / 正在等登录的店铺直接跳过，不打断用户手里的活；
 * - `checkFn` 可注入（自检里塞假检测函数，绝不起浏览器）。
 */
export async function tickSchedule(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const log = opts.log || { info: () => {}, warn: () => {} };
  const s = normalizeSchedule(readConfig().schedule);
  const accounts = loadAccounts();
  const due = dueRows({
    schedule: s, accounts, now,
    memGB: opts.memGB != null ? opts.memGB : memGB(),
    graceMs: opts.graceMs,
  });
  if (!due.length) return { ran: [], skipped: [] };

  const keepaliveSec = opts.keepaliveSec != null ? opts.keepaliveSec : s.keepaliveSec;
  const checkFn = typeof opts.checkFn === 'function' ? opts.checkFn : (a) => checkAccount(a, { silent: true, keepaliveSec });
  const ran = [];
  const skipped = [];
  for (const row of due) {
    try {
      writeConfig({ schedule: markRan(readConfig().schedule, { accountIds: [row.id], time: row.time, now }) });
    } catch (err) {
      log.warn(`定时检测记账失败（${row.name}）：${err && err.message ? err.message : String(err)}`);
    }
    const account = findAccount(row.id);
    if (!account) { skipped.push({ id: row.id, name: row.name, reason: '账号已不存在' }); continue; }
    if (account.pendingLogin) { skipped.push({ id: row.id, name: row.name, reason: '正在等登录' }); continue; }
    let running = false;
    try { running = Number(account.port) ? await browserUp(Number(account.port), 500) : false; } catch { running = false; }
    if (running) { skipped.push({ id: row.id, name: row.name, reason: '浏览器开着，不打断' }); continue; }
    try {
      const live = await checkFn(account, { keepaliveSec });
      const at = new Date().toISOString();
      patchAccount(account.id, {
        lastCheck: live,
        lastCheckAt: at,
        ...(live && live.loggedIn ? { lastLoginAt: at } : {}),
        lastSchedAt: at,
        lastSchedError: '',
      });
      ran.push({ id: row.id, name: row.name, time: row.time, loggedIn: Boolean(live && live.loggedIn), reason: (live && live.reason) || '' });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      patchAccount(account.id, { lastSchedAt: new Date().toISOString(), lastSchedError: msg });
      skipped.push({ id: row.id, name: row.name, reason: '检测失败：' + msg });
    }
  }
  if (ran.length) log.info(`定时检测完成：${ran.map((r) => r.name + (r.loggedIn ? '✓' : '✗')).join('、')}`);
  if (skipped.length) log.info(`定时检测跳过：${skipped.map((r) => r.name + '（' + r.reason + '）').join('、')}`);
  return { ran, skipped, at: now.toISOString() };
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
  const sched = scheduleView();
  const schedById = new Map(sched.rows.map((r) => [r.id, r]));
  const out = [];
  for (const a of accounts) {
    const platform = platformOf(a.platform);
    const port = Number(a.port) || 0;
    const running = port ? await browserUp(port, 700) : false;
    const dir = accountProfileDir(a, cfg);
    out.push({
      id: a.id,
      platform: a.platform,
      platformLabel: platform ? platform.label : a.platform,
      name: a.name || '(未命名)',
      note: a.note || '',
      url: a.url || '',
      loginName: a.loginName || '',
      accountType: a.accountType || '',
      port,
      cdpUrl: port ? `http://127.0.0.1:${port}` : '',
      profileDir: dir,
      profileExists: (() => { try { return fs.existsSync(dir); } catch { return false; } })(),
      running,
      pendingLogin: Boolean(a.pendingLogin),
      createdAt: a.createdAt || null,
      lastOpenAt: a.lastOpenAt || null,
      lastLoginAt: a.lastLoginAt || null,
      lastCheckAt: a.lastCheckAt || null,
      lastCheck: a.lastCheck || null,
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
    accounts: out,
    config: cfg,
    browser: { path: browserPath || '', found: Boolean(browserPath) },
    dataDir: dataDir(),
    version: ownVersion(),
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
  const mAction = p.match(/^\/accounts\/([^/]+)\/(open|close|reset|finish|check|reveal|silent-check|schedule)$/);

  try {
    if (method === 'GET' && p === '/state') return sendJson(res, 200, await buildState());

    if (method === 'GET' && p === '/config') {
      const bp = resolveBrowserPath(readConfig().browserPath);
      return sendJson(res, 200, {
        ok: true,
        config: readConfig(),
        browser: { path: bp || '', found: Boolean(bp) },
        dataDir: dataDir(),
        version: ownVersion(),
        updateDir: detectUpdateDir(),
      });
    }
    if (method === 'PUT' && p === '/config') {
      const body = await readJsonBody(req);
      const next = writeConfig({
        browserPath: typeof body.browserPath === 'string' ? body.browserPath.trim() : undefined,
        profileRoot: typeof body.profileRoot === 'string' ? body.profileRoot.trim() : undefined,
        portBase: Number.isInteger(body.portBase) ? body.portBase : undefined,
        openWorkTab: typeof body.openWorkTab === 'boolean' ? body.openWorkTab : undefined,
        gracefulClose: typeof body.gracefulClose === 'boolean' ? body.gracefulClose : undefined,
        updateDir: typeof body.updateDir === 'string' ? body.updateDir.trim() : undefined,
      });
      return sendJson(res, 200, { ok: true, config: next, browser: resolveBrowserPath(next.browserPath) || '' });
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

    if (method === 'POST' && p === '/accounts') {
      const body = await readJsonBody(req);
      const platform = platformOf(String(body.platform || ''));
      if (!platform) return sendJson(res, 400, { ok: false, error: '平台只能是 ' + PLATFORMS.map((x) => x.id).join(' / ') });
      const name = String(body.name || '').trim() || `${platform.label} 店铺 ${loadAccounts().length + 1}`;
      const cfg = readConfig();
      const id = newAccountId(platform.id);
      const importDir = String(body.profileDir || '').trim();
      const account = {
        id,
        platform: platform.id,
        name,
        note: String(body.note || '').trim(),
        url: String(body.url || '').trim(),
        loginName: String(body.loginName || '').trim(),
        accountType: String(body.accountType || '').trim(),
        profileDir: importDir || profileDirFor(id, cfg),
        port: Number.isInteger(body.port) && body.port > 0 ? body.port : 0,
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
      if (importDir) {
        const check = await checkAccount(account, { silent: true });
        patchAccount(id, { lastCheck: check, lastCheckAt: new Date().toISOString(), pendingLogin: !check.loggedIn });
      }
      return sendJson(res, 200, { ok: true, account: findAccount(id) });
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
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (typeof body.note === 'string') patch.note = body.note.trim();
      if (typeof body.url === 'string') patch.url = body.url.trim();
      if (typeof body.loginName === 'string') patch.loginName = body.loginName.trim();
      if (typeof body.accountType === 'string') patch.accountType = body.accountType.trim();
      if (typeof body.profileDir === 'string' && body.profileDir.trim()) patch.profileDir = body.profileDir.trim();
      if (Number.isInteger(body.port) && body.port >= 1) patch.port = body.port;
      return sendJson(res, 200, { ok: true, account: patchAccount(account.id, patch) });
    }
    if (mAccount && method === 'DELETE') {
      const id = decodeURIComponent(mAccount[1]);
      const account = findAccount(id);
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });
      const body = await readJsonBody(req).catch(() => ({}));
      if (Number(account.port) && (await browserUp(account.port, 600))) {
        await killChromeForProfile(accountProfileDir(account, readConfig()));
      }
      saveAccounts(loadAccounts().filter((a) => a.id !== id));
      let deletedDir = false;
      if (body && body.deleteProfile === true) {
        const dir = accountProfileDir(account, readConfig());
        try {
          // 只删"档案必须存在"的那个目录本身；解析后的绝对路径必须以 account.id 结尾，
          // 否则说明配置被改成了别的地方 —— 那种情况下宁可不删（防止误删用户目录）。
          if (path.resolve(dir).endsWith(account.id)) { fs.rmSync(dir, { recursive: true, force: true }); deletedDir = true; }
        } catch { /* 删不掉就留着 */ }
      }
      return sendJson(res, 200, { ok: true, deleted: id, deletedProfile: deletedDir });
    }

    if (mAction) {
      const id = decodeURIComponent(mAction[1]);
      const action = mAction[2];
      const account = findAccount(id);
      if (!account) return sendJson(res, 404, { ok: false, error: '账号不存在' });

      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '用 POST' });

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
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (action === 'reset') {
        const r = await resetAccount(account);
        return sendJson(res, r.ok === false ? 500 : 200, r);
      }

      if (action === 'close') {
        const r = await closeAccount(account);
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (action === 'check' || action === 'silent-check') {
        const silent = action === 'silent-check';
        const body = await readJsonBody(req);
        // 手动「检测」默认不保活（要快）；带 keepaliveSec 就多待一会儿再复查一遍。
        const check = await checkAccount(account, {
          silent,
          keepaliveSec: Number(body && body.keepaliveSec) > 0 ? Number(body.keepaliveSec) : 0,
        });
        patchAccount(account.id, {
          lastCheck: check,
          lastCheckAt: new Date().toISOString(),
          ...(check.loggedIn ? { lastLoginAt: new Date().toISOString() } : {}),
        });
        return sendJson(res, 200, { ok: true, check });
      }

      if (action === 'finish') {
        // 正常情况浏览器还开着 → 直接读它（毫秒级）；用户先把窗口关了 → 无头探一次，别拿旧结果糊弄
        const check = await checkAccount({ ...account, port: account.port }, { silent: true });
        patchAccount(account.id, {
          lastCheck: check,
          lastCheckAt: new Date().toISOString(),
          ...(check.loggedIn ? { lastLoginAt: new Date().toISOString(), pendingLogin: false } : {}),
        });
        if (check.loggedIn) {
          const closed = await closeAccount(account);
          return sendJson(res, 200, { ok: true, saved: true, check, ...closed });
        }
        // 没登录成功就**不关窗、不假装保存** —— 用户还得在那个窗口里继续弄
        return sendJson(res, 200, { ok: true, saved: false, check, closed: false });
      }

      if (action === 'reveal') {
        const dir = accountProfileDir(account, readConfig());
        try {
          if (fs.existsSync(dir)) {
            const { spawn } = await import('node:child_process');
            const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
            child.unref();
          }
          return sendJson(res, 200, { ok: true, dir });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      }
    }

    return sendJson(res, 404, { ok: false, error: `未知路由 ${method} ${BASE}${p}` });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
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
      '电商店铺账号管理（淘宝/拼多多/抖音）：列出已保存的店铺登录档案，或打开某个店铺的浏览器。' +
      '每个店铺一份独立的 Chrome 用户目录 + 一个调试端口；打开后返回 cdpUrl（如 http://127.0.0.1:9222），' +
      '后续上架流程直接连这个 CDP 端口复用登录态，不需要重新扫码登录。' +
      '注意：登录必须由用户在弹出的 Chrome 窗口里手动完成，本工具不会（也不能）代填账号密码或代扫码。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'open', 'check', 'close', 'reset'],
        required: true,
        description: 'list=列出店铺及其登录状态；open=打开店铺浏览器（返回 cdpUrl）；check=检测登录态；close=关掉店铺浏览器；reset=清空该店铺本地登录档案并重新打开登录页（状态是「已过期/未登录」、登录页不给二维码时用）',
      },
      account: { type: 'string', description: '店铺名（支持部分匹配）或 account id。open/check/close 时必填；也接受「店铺A/店铺B」式的字母序号' },
      mode: { type: 'string', enum: ['work', 'login'], description: 'open 时用：work=打开平台工作台（复用登录态，默认）；login=打开登录页（重新登录）' },
      platform: { type: 'string', enum: PLATFORMS.map((p) => p.id), description: 'list 时按平台过滤' },
      silentCheck: { type: 'boolean', description: 'check 时用：true=用无头浏览器静默检测（不弹窗，几秒），false=只报告上次结果' },
    },
    execute: async (args = {}) => {
      const action = String(args.action || 'list');
      if (action === 'list') {
        const list = loadAccounts()
          .filter((a) => !args.platform || a.platform === args.platform)
          .map((a, i) => {
            const platform = platformOf(a.platform);
            return {
              index: i,
              id: a.id,
              name: a.name,
              platform: a.platform,
              platformLabel: platform ? platform.label : a.platform,
              note: a.note || '',
              port: a.port || 0,
              cdpUrl: a.port ? `http://127.0.0.1:${a.port}` : '',
              lastCheck: a.lastCheck || null,
              lastLoginAt: a.lastLoginAt || null,
            };
          });
        return { ok: true, count: list.length, accounts: list, hint: list.length ? '用 action=open + account=<店铺名> 打开某个店铺的浏览器' : '还没有店铺档案，请在「设置 → 账号管理」里新增店铺并登录' };
      }

      const account = pickAccount(args.account);
      if (!account) {
        const names = loadAccounts().map((a) => a.name);
        return { ok: false, error: '没找到店铺：' + String(args.account || '(空)'), available: names };
      }

      if (action === 'open') {
        const mode = args.mode === 'login' ? 'login' : 'work';
        const r = await openAccount(account, mode);
        const platform = platformOf(account.platform);
        return {
          ok: true, alreadyRunning: Boolean(r.reused), account: account.name, mode,
          port: r.port, cdpUrl: r.cdpUrl, profileDir: r.profileDir,
          platform: account.platform, homeUrl: platform ? platform.homeUrl : '',
          hint: mode === 'login'
            ? (r.reused
              ? '登录页已经在这个店铺已打开的 Chrome 窗口里新开了一个标签页，请让用户在那个窗口里完成登录，然后点「完成并保存」'
              : '已打开登录页，请让用户在弹出的 Chrome 窗口里完成登录，然后在「设置 → 账号管理」点「完成并保存」')
            : '可直接用这个 cdpUrl 复用登录态',
        };
      }

      if (action === 'reset') {
        const r = await resetAccount(account);
        if (r.ok === false) return { ok: false, account: account.name, error: r.error };
        return {
          ok: true, account: account.name, mode: 'login', port: r.port, cdpUrl: r.cdpUrl, profileDir: r.profileDir,
          removedProfile: true,
          hint: '这个店铺的本地登录档案已清空并重新打开登录页，请让用户重新扫码登录，然后点「完成并保存」',
        };
      }

      if (action === 'check') {
        const check = await checkAccount(account, { silent: args.silentCheck === true });
        patchAccount(account.id, { lastCheck: check, lastCheckAt: new Date().toISOString() });
        return { ok: true, account: account.name, platform: account.platform, ...check };
      }

      if (action === 'close') {
        const r = await closeAccount(account);
        return { ok: true, account: account.name, ...r };
      }

      return { ok: false, error: '不认识的 action：' + action };
    },
  });
  const dispose = ctx.tools.register(tool);
  return typeof dispose === 'function' ? dispose : null;
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const log = makeLog(ctx);
  ensureDir(dataDir());

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
