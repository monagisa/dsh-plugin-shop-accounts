/**
 * ego.mjs —— 店铺账号的「ego lite 后端」。
 *
 * 为什么要有这一层：
 *   · 本插件原本用「一个店铺一份 Chrome 档案 + 一个调试端口」来隔离登录态；
 *   · ego lite 自带多 profile + TaskSpace，登录态天生按 profile 隔离，且对人和 agent 都友好，
 *     所以装了 ego 就优先用它，没有才回退 Chrome（配置 `browser: auto|egolite|chrome`）。
 *
 * 动作（都在 `ego-browser nodejs` 运行时里执行，执行完即退出，空间/窗口留在 ego 里）：
 *   · list    —— 有哪些 profile、哪些 TaskSpace（判断"这个店铺是不是已经开着"）
 *   · open    —— 建/复用店铺的 TaskSpace，把页面导航到工作台或登录页，然后把控制权交还用户
 *   · probe   —— **另开一个临时空间**（同 profile）读 cookie + 网址判定登录态，读完立刻收掉。
 *                故意不碰用户那个开着的窗口：交给用户控制的空间要 takeOver 才收得回来，
 *                一收一还就是"抢控制"，用户正在用的时候会被打断。
 *                实测同一个 profile 可以同时开两个 TaskSpace，cookie 罐是同一份，所以读得一样准。
 *   · reset   —— 清掉这个店铺**平台域名下的** cookie（不是整仓清空，避免连坐共用 profile 的店铺），
 *                然后把店铺空间导到登录页
 *   · close   —— 收掉 TaskSpace（登录态留在 profile 里，不丢）
 *   · handoff —— 只交还控制权，不动页面
 *
 * 关于「agent 调试中」：ego 的 TaskSpace 有 ownership。agent 建的/接管的 = `agent`（ego 界面显示
 * 「agent 调试中」），`task.handOff()` 之后 = `agentDelegatedToUser`（用户控制，界面正常）。
 * 交还之后 ego 会把浏览器命令**硬停**，必须 `takeOverTaskSpace(id)` 才收得回来（id 来自 listTaskSpaces）。
 * 所以本模块的顺序固定为：需要操作 → 先收回控制 → 干活 → 最后交还。
 *
 * 关于「别把浏览器拉起来」：ego 的 CLI 在 app 没运行时**会把整个浏览器启动**（实测 5.7 秒、
 * 恢复上次几十个标签、3GB 内存）。所以除了 open/reset 这种用户明确要开窗口的动作，
 * 其它动作先看 ego.exe 在不在；不在就直接回 `ego_not_running`，绝不偷偷拉起。
 *
 * 两个 ego 的事实决定了这里的写法：
 *   1) ego 运行时**不继承调用方的环境变量**（process.env 是空的），所以参数必须内联进脚本；
 *   2) ego 自己在跑时**不提供 TCP 调试端口**（IPC 通信），所以不能用 CDP 连它 ——
 *      但 `page.cdp()` 这个桥可以透传 CDP 方法，`Network.getAllCookies` 实测可用（含 HttpOnly）。
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { pickPort, waitForCdp, waitPortGone } from './chrome.mjs';
import { getAllCookies, closeBrowser } from './cdp.mjs';
import { collectArtifacts, EGO_EXECUTOR_SOURCE } from './rpa.mjs';
import { FRAME_EVAL_SOURCE } from './frames.mjs';
import * as platform from './platform/index.mjs';

const RESULT_PREFIX = 'EGO_RESULT ';

/**
 * ego 新版对「控制权在用户手里」的任务空间有硬停策略：脚本还没跑，ego 就打一段说明并退出。
 * 文案里会带下面三句之一，识别出来是为了把它翻成人话、并给出可执行的下一步（而不是把原文抛给用户）。
 */
export function isUserInControlOutput(text) {
  const s = String(text || '');
  if (s.indexOf('Control of this task space is with the user') >= 0) return true;
  if (s.indexOf('EGO_TASK_SPACE_USER_IN_CONTROL') >= 0) return true;
  if (s.indexOf('explicitly asks you to continue') >= 0) return true;
  if (s.indexOf('This task has ended and the space is yours') >= 0) return true;
  return false;
}

const USER_IN_CONTROL_HINT =
  '这个店铺的窗口现在归你控制（ego 里要么显示「任务已结束」，要么你在浏览器里接管过这个窗口）。' +
  'ego 不允许插件自动把它抢回来。点「打开」会在同一个浏览器配置里新开一个窗口（登录态照旧共用）；' +
  '想回到原来那个窗口，先在 ego 里点「继续」，再点「打开」。';
const RUN_TIMEOUT = 120000;

/** ego-browser CLI 的常见位置（按优先级，路径由平台层提供）。 */
export function egoCliCandidates() {
  return platform.egoCliCandidates();
}

/** ego lite 主程序位置（只在需要启动 app 时用）。 */
export function egoAppCandidates() {
  return platform.egoAppCandidates();
}

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 权限问题，继续找 */ }
  }
  return null;
}

/** 配置优先 → 环境变量 → 自动探测。找不到返回 null。 */
export function resolveEgoCli(configured) {
  const c = String(configured || '').trim();
  if (c && fs.existsSync(c)) return c;
  const env = String(process.env.EGOLITE_CLI || process.env.PDD_EGOLITE_CLI || '').trim();
  if (env && fs.existsSync(env)) return env;
  return firstExisting(egoCliCandidates());
}

export function resolveEgoApp(configured) {
  const c = String(configured || '').trim();
  if (c && fs.existsSync(c)) return c;
  const env = String(process.env.EGOLITE_APP || '').trim();
  if (env && fs.existsSync(env)) return env;
  return firstExisting(egoAppCandidates());
}

/** 当前环境该用哪个后端：'egolite' | 'chrome'。`browser=auto` 时有 ego 就用 ego。 */
export function backendFor(cfg) {
  const want = String((cfg && cfg.browser) || 'auto').toLowerCase();
  if (want === 'chrome') return 'chrome';
  const cli = resolveEgoCli(cfg && cfg.egoliteCli);
  if (want === 'egolite') return cli ? 'egolite' : 'chrome'; // 强制但没装 → 明确回退，调用方会提示
  return cli ? 'egolite' : 'chrome';
}

/** ego 是否可用（设置页/启动日志用）。注意：available 只代表"装了"，不代表"开着"。 */
export function egoStatus(cfg) {
  const cli = resolveEgoCli(cfg && cfg.egoliteCli);
  const app = resolveEgoApp(cfg && cfg.egoliteApp);
  return { available: Boolean(cli), cli: cli || '', app: app || '', backend: backendFor(cfg) };
}

// ── ego 进程在不在（决定能不能安全地起 CLI） ────────────────────────────────

let appRunningCache = { at: 0, value: true, inflight: null };
const APP_RUNNING_TTL = 5000;

/**
 * ego lite 主程序此刻在不在跑。
 * 为什么需要：ego 的 CLI 只要 app 没开，就会把**整个浏览器**启动（实测 5.7s、恢复几十个标签、3GB），
 * 而插件会周期性刷新状态 —— 不先问一句，用户关掉 ego 之后又会被拉起来。
 * 探测失败时返回 true（宁可让功能正常工作，也不要因为探测不到就把功能挡死；最坏退回老行为）。
 */
export function egoAppRunning() {
  const now = Date.now();
  if (appRunningCache.inflight) return appRunningCache.inflight;
  if (now - appRunningCache.at < APP_RUNNING_TTL) return Promise.resolve(appRunningCache.value);
  appRunningCache.inflight = new Promise((resolve) => {
    // 进程名按实际解析到的主程序名来问（默认 ego.exe，但装成别的名字时也不至于误判成「没在跑」）。
    const exeName = path.basename(resolveEgoApp('') || 'ego.exe');
    // tasklist 是系统自带命令，比 wmic 快也更稳（wmic 在新系统里已经被弃用）
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      let value = true;
      if (!err) value = new RegExp(exeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(String(stdout || ''));
      appRunningCache = { at: Date.now(), value, inflight: null };
      resolve(value);
    });
  });
  return appRunningCache.inflight;
}

/** 强制忘掉缓存（刚启动/刚关掉 ego 之后调用）。 */
export function egoAppRunningInvalidate() { appRunningCache = { at: 0, value: true, inflight: null }; }

/** 只把 ego 主程序拉起来（用户点「启动 ego」时用），不建任何空间。 */
export function egoLaunchApp(configured) {
  const exe = resolveEgoApp(configured);
  if (!exe) return Promise.resolve({ ok: false, error: '找不到 ego lite 主程序' });
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => resolve({ ok: false, error: '启动失败：' + String((err && err.message) || err) }));
      child.unref();
      // 给 app 一点启动时间，随后让调用方自己再去读状态
      setTimeout(() => { egoAppRunningInvalidate(); resolve({ ok: true, exe }); }, 1200);
    } catch (err) {
      resolve({ ok: false, error: '启动失败：' + String((err && err.message) || err) });
    }
  });
}

/** ego lite 的 User Data 根目录（`Profile 1/2/3` 的父目录）。后台检测要用它。 */
export function egoUserDataDir(configured) {
  const c = String(configured || '').trim();
  if (c && fs.existsSync(c)) return c;
  const env = String(process.env.EGOLITE_USER_DATA || '').trim();
  if (env && fs.existsSync(env)) return env;
  return firstExisting(platform.egoUserDataDirs());
}

const offlineHit = (cookieDomain, domains) => {
  if (!domains || !domains.length) return true;
  const d = String(cookieDomain || '').replace(/^\.+/, '').toLowerCase();
  return domains.some((suf) => d === String(suf).toLowerCase() || d.endsWith('.' + String(suf).toLowerCase()));
};

// 同一个 User Data 同时只能有一个实例（SingletonLock 互斥），后台检测排队执行
let offlineChain = Promise.resolve();

/**
 * **后台检测**：ego 关着的时候，用同一份 User Data 起一个「无窗口」实例（`--headless=new`），
 * 通过 CDP 读 cookie，读完立刻关掉。不弹窗、不恢复上次的窗口，也不需要用户先把 ego 打开。
 *
 * 为什么必须用**真实档案**：ego 的 cookie 是 Chromium 的 App-Bound 加密（v20），实测把档案
 * 复制到别的目录再起实例只能读到 0 个 cookie（密钥和原 user-data-dir 绑定），所以不能复制。
 * 也正因为共用档案：ego 正开着的时候别用这条路（会撞 SingletonLock），调用方应改用 CLI 临时空间探测。
 *
 * 实测（2026-10-31，Profile 3）：CDP 426ms 就绪、读到 16 个 cookie（含 pinduoduo 的 PASS_ID），
 * 关掉后 0 进程 0 窗口；整个动作约 1.5 秒。
 */
/**
 * 后台检测用的无头实例参数。
 *
 * **不加 `--remote-allow-origins=*`**（2026-10-31 安全审查）：那个开关会让任意网页在
 * DNS rebinding 之后连上这个调试端口，而这里是**用户的真实 ego User Data**（ego 的 cookie
 * 是 App-Bound 加密的，走 CDP 等于绕过加密直接读明文）。本插件用的 Node WebSocket
 * （undici）不发 Origin 头，Chrome 只对带 Origin 的连接做 allowlist 校验 —— 实测
 * Chrome 156 不加该开关也能正常 `Network.getAllCookies`。
 */
export async function egoOfflineCookies({ profileId, domains, appConfigured, userDataConfigured, timeoutMs = 20000 } = {}) {
  let prof = '';
  try { prof = normalizeEgoProfileId(profileId); } catch (err) {
    return { ok: false, code: 'bad_profile', error: String((err && err.message) || err) };
  }
  if (!prof) return { ok: false, code: 'no_profile', error: '这个店铺还没分配 profile' };
  // 先看 ego 在不在跑：开着就说明档案被占着，交给调用方走 CLI 临时空间
  if (await egoAppRunning().catch(() => true)) {
    return { ok: false, code: 'ego_running', error: 'ego lite 正开着（用临时空间探测更合适）' };
  }
  const exe = resolveEgoApp(appConfigured);
  if (!exe) return { ok: false, code: 'no_app', error: '找不到 ego lite 主程序' };
  const ud = egoUserDataDir(userDataConfigured);
  if (!ud) return { ok: false, code: 'no_user_data', error: '找不到 ego lite 的 User Data 目录（可在设置里指定）' };

  const run = async () => {
    const startedAt = Date.now();
    // 端口避开账号 CDP 段（9222 起），单独用 9300 起
    const port = await pickPort(9300, []);
    if (!port) return { ok: false, code: 'no_port', error: '找不到空闲调试端口' };
    let child = null;
    try {
      child = spawn(exe, [
        '--headless=new', '--disable-gpu',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${ud}`,
        `--profile-directory=${prof}`,
        '--no-first-run', '--no-default-browser-check',
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (err) {
      return { ok: false, code: 'spawn_failed', error: '起无窗口实例失败：' + String((err && err.message) || err) };
    }
    const up = await waitForCdp(port, timeoutMs);
    if (!up) {
      try { child.kill(); } catch { /* 已经退了 */ }
      return { ok: false, code: 'cdp_timeout', error: '无窗口实例没在 ' + Math.round(timeoutMs / 1000) + ' 秒内就绪' };
    }
    try {
      const got = await getAllCookies(port);
      const all = (got && got.cookies) || [];
      return {
        ok: true, mode: 'headless', cookies: all.filter((c) => offlineHit(c.domain, domains)),
        cookieCount: all.length, url: '', elMs: Date.now() - startedAt,
      };
    } catch (err) {
      return { ok: false, code: 'cookie_failed', error: '读 cookie 失败：' + String((err && err.message) || err) };
    } finally {
      // 关干净：先 CDP 正常退出（让 cookie 落盘），再按 PID 树补一刀把孩子进程（renderer/crashpad）收掉，
      // 最后确认端口真的没了；万一还在就再强杀一次。绝不留后台进程。
      try { await closeBrowser(port); } catch { /* 忽略 */ }
      try { if (child && child.pid) platform.killPidTree(child.pid); } catch { /* 已经退了 */ }
      const gone = await waitPortGone(port, 4000);
      if (!gone) {
        try { if (child && child.pid) platform.killPidTree(child.pid); } catch { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, 300));
      }
      egoAppRunningInvalidate();
    }
  };

  const started = offlineChain.then(run, run);
  offlineChain = started.then(() => {}, () => {});
  return started;
}

/**
 * ego 的 profile 名/ID 来自 ego 自己的列表，但账号记录里的字段可以被 API 改 ——
 * 做形状校验，别让 `..`、斜杠、换行之类进到 `--profile-directory=` 参数里。
 */
export function normalizeEgoProfileId(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (s.length > 64 || /[\\/\r\n\t]/.test(s) || s === '.' || s === '..') {
    throw new Error('ego profile 名称不合法：' + JSON.stringify(s));
  }
  return s;
}

/**
 * 每次运行一个**私有临时目录**（mkdtemp 随机名），跑完整个删掉。
 * 之前是固定目录 + 固定前缀文件名，同用户进程可以在写入与 import 之间替换脚本。
 */
function makeRunDir() {
  const base = path.join(os.tmpdir(), 'dsh-shop-accounts-ego');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* 已存在 */ }
  return fs.mkdtempSync(path.join(base, 'run-'));
}

/** ego 运行时里跑的脚本：参数内联（ego 不继承环境变量），结果打一行 EGO_RESULT <json>。 */
function runnerSource(payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `// generated by dsh-plugin-shop-accounts — runs inside ego lite's Node runtime
const P = JSON.parse(Buffer.from(${JSON.stringify(b64)}, 'base64').toString('utf8'));
const emit = (o) => { try { console.log('${RESULT_PREFIX}' + JSON.stringify(o)); } catch (e) { console.log('${RESULT_PREFIX}{"ok":false,"error":"emit failed"}'); } };
const g = globalThis;
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
const pickCookie = (c) => ({ name: c.name, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, value: clip(c.value, 200) });
const domainHit = (c) => {
  if (!P.domains || !P.domains.length) return true;
  const d = String(c.domain || '').replace(/^\\.+/, '').toLowerCase();
  return P.domains.some((suf) => d === suf || d.endsWith('.' + suf));
};
const sanitize = (name) => String(name || '').replace(/[\\r\\n\\t]/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 采集 DSL 的哑执行器（源码来自 rpa.mjs，Node 侧编译好 ops 后这里只做执行）──
${EGO_EXECUTOR_SOURCE}

// ── 跨 frame 求值（源码来自 frames.mjs）：登录表单可能在跨域 iframe 里（淘宝/天猫/1688）──
${FRAME_EVAL_SOURCE}

// 用户的窗口里可能只剩一个空白页，甚至标签已经被全部关掉 —— 有地址的页优先，一个活页都没有就新建一页
async function pickPage(task) {
  const cands = [];
  try { for (const pg of (await task.pages()) || []) cands.push(pg); } catch (e) { /* 没 pages() 就新建一页 */ }
  for (const pg of cands) {
    try { const u = await pg.url(); if (/^https?:/i.test(u)) return pg; } catch (e) { /* 这页没了，看下一个 */ }
  }
  if (cands.length) {
    // 有页但不是 http(s)（about:blank 之类）：能导航就直接用它，省一次新建
    try { await cands[0].url(); return cands[0]; } catch (e) { /* 全是关掉的页 */ }
  }
  // v0.18.3 修的坑：空间里一页都不剩时，旧的 task.page('p1') 会递回一个已经关闭的 p1，
  // 之后任何 goto 都报 page p1 was closed，ego 窗口里就只留一个停在 https://x/ 的空 space
  // （用户每点一次「打开」就多一个）。没有活着的页面就新建一页。
  if (typeof task.newPage === 'function') {
    try { const np = await task.newPage(); if (np) return np; } catch (e) { /* 落到 p1 */ }
  }
  return task.page('p1');
}

// 导航失败时（典型是 page p1 was closed）换一张新页再试一次，别把窗口留在 https://x/
async function gotoMaybeNewPage(task, page, url, navErrors) {
  if (!url) return page;
  try { await page.goto(url, { timeout: 20000 }); return page; } catch (e) {
    navErrors.push(String((e && e.message) || e));
    if (typeof task.newPage !== 'function') return page;
    try {
      const np = await task.newPage();
      if (!np) return page;
      await np.goto(url, { timeout: 20000 });
      return np;
    } catch (e2) { navErrors.push(String((e2 && e2.message) || e2)); return page; }
  }
}

// 空间可能被用户改过名 —— 名字找不到时按 id 再找一次（id 来自 listTaskSpaces）
async function findEntry(spaceName, spaceId) {
  const spaces = (await g.listTaskSpaces().catch(() => [])) || [];
  const byName = spaces.find((s) => s && s.name === spaceName) || null;
  if (byName) return { entry: byName, spaces };
  // id 可能是 0（用户自己开的空间就没有 id），所以只认真值
  if (spaceId && Number(spaceId) > 0) {
    const byId = spaces.find((s) => s && s.id && String(s.id) === String(spaceId)) || null;
    if (byId) return { entry: byId, spaces };
  }
  return { entry: null, spaces };
}

// 拿到一个可以操作的句柄。
// ego 新版规则（v2.2+，实测 2026-11-05）：
//   · agent / agentDelegatedToUser —— 是本插件自己的任务，可以用 takeOverTaskSpace 拿回来；
//   · user —— 用户自己持有的空间（他在 ego 里点了「结束任务」，或在浏览器里接管过）。
//     对这类空间调 takeOver/claim，ego 会直接硬停整次运行（脚本都不执行），并明确要求
//     「等用户明确要求继续后再拿回来」——插件无从证明用户点了按钮，所以**绝不碰它**：
//     改用备用名字在同一个 profile 下新开一个空间（登录态是同一个 profile，照样共用）。
async function acquire(entry, spaceName, profileId) {
  if (!entry) {
    const t = profileId ? await g.taskSpace(spaceName, { profileId }) : await g.taskSpace(spaceName);
    return { task: t, alternativeName: '' };
  }
  const ownership = String(entry.ownership || '');
  if (ownership === 'agent' || ownership === 'agentDelegatedToUser') {
    if (typeof g.takeOverTaskSpace === 'function') {
      try { return { task: await g.takeOverTaskSpace(entry.id), alternativeName: '' }; } catch (e) { /* 名字/状态变了再试 taskSpace */ }
    }
    try { return { task: await g.taskSpace(spaceName), alternativeName: '' }; } catch (e) { /* 落到下面的备用名字 */ }
  }
  for (let i = 2; i <= 5; i++) {
    const alt = spaceName + ' (' + i + ')';
    try {
      const t = profileId ? await g.taskSpace(alt, { profileId }) : await g.taskSpace(alt);
      return { task: t, alternativeName: alt };
    } catch (e) {
      if (String((e && e.message) || '').indexOf('NAME_IN_USE') < 0) throw e;
    }
  }
  throw new Error('这个店铺原来的窗口归你控制（ego 不允许插件自动拿回来），也没能新开一个窗口');
}

async function main() {
  if (typeof g.taskSpace !== 'function') { emit({ ok: false, error: 'ego_sdk_missing: 必须在 ego-browser nodejs 运行时里跑' }); return; }
  const op = P.op;

  if (op === 'list') {
    const spaces = await g.listTaskSpaces().catch(() => []);
    const profiles = await g.profiles().catch(() => []);
    emit({
      ok: true,
      spaces: (spaces || []).map((s) => ({ name: s.name, id: s.id, spaceId: s.spaceId || s.id, profileId: s.profileId || null, ownership: s.ownership || null })),
      profiles: (profiles || []).map((p) => ({ id: p.id, name: p.name, isDefault: Boolean(p.isDefault) })),
    });
    return;
  }

  const spaceName = sanitize(P.space);
  if (!spaceName && op !== 'probe') { emit({ ok: false, error: 'space 不能为空' }); return; }

  // ── probe：一律用临时空间，绝不碰用户开着的那个窗口 ──────────────────────
  if (op === 'probe') {
    if (!P.profileId) { emit({ ok: false, error: 'probe 需要 profileId' }); return; }
    const tempName = sanitize(P.tempSpace) || ('临时检测-' + Math.random().toString(36).slice(2, 8));
    // 上一次检测如果被超时/崩溃打断，同名临时空间会留在 ego 里；先收掉它再建 ——
    // 否则每次检测都撞同一个名字（可能报 NAME_IN_USE，那个店铺就永远检测失败）（v0.8.1 修）。
    try {
      const spaces = (await g.listTaskSpaces()) || [];
      const stale = spaces.find((s) => s && s.name === tempName);
      if (stale && String(stale.ownership || '') === 'agent') {
        const old = await g.takeOverTaskSpace(stale.id);
        await old.finish({ keep: [] });
      }
    } catch (e) { /* 收不掉就算了，下面建不出来会走 probe_failed */ }
    let temp = null;
    try {
      temp = await g.taskSpace(tempName, { profileId: P.profileId });
      const page = await pickPage(temp);
      let url = '';
      if (P.url) {
        try { await page.goto(P.url, { timeout: 20000 }); } catch (e) { /* 登录页/风控页可能不触发 load，不致命 */ }
      }
      await page.waitForTimeout(1000).catch(() => {});
      url = await page.url().catch(() => '');
      let cookies = null;
      let cookieError = null;
      try {
        const res = await page.cdp('Network.getAllCookies', {});
        cookies = ((res && res.cookies) || []).filter(domainHit).map(pickCookie);
      } catch (e) { cookieError = String((e && e.message) || e); }
      emit({ ok: true, url, cookies, cookieError, temp: tempName });
    } catch (e) {
      emit({ ok: false, error: String((e && e.message) || e), code: /NAME_IN_USE/.test(String(e && e.message)) ? 'space_name_in_use' : 'probe_failed' });
    } finally {
      // 读完立刻收掉临时窗口（收不掉也不影响判定）
      if (temp) { try { await temp.finish({ keep: [] }); } catch (e) { /* ignore */ } }
    }
    return;
  }

  const { entry } = await findEntry(spaceName, P.spaceId);
  // close / handoff 绝不能为了"关闭"先建一个窗口：空间本来就不在（没打开过、被用户在 ego 里关了、
  // 改过名）时直接回 alreadyClosed。否则每点一次「关闭」就多一个 agent 占着的空窗口，
  // 而且它落在默认 profile 上，下次「打开」会认领它 → 店铺串到别的 profile（v0.8.1 修）。
  if (!entry && (op === 'close' || op === 'handoff')) {
    emit({
      ok: true, space: spaceName, created: false, ownershipBefore: null,
      tookOver: false, handedOff: false, alreadyClosed: true,
    });
    return;
  }
  // 关闭 / 交还控制权时如果窗口归用户所有，插件什么都不做（不是「没关掉」，是「不该碰」）
  if (entry && String(entry.ownership || '') === 'user' && (op === 'close' || op === 'handoff')) {
    emit({
      ok: true, space: spaceName, created: false, ownershipBefore: 'user',
      tookOver: false, handedOff: false, alreadyClosed: true,
      note: '这个窗口归你控制（ego 里显示任务已结束），插件不去动它',
    });
    return;
  }
  const created = !entry;  const meta = {
    space: (entry && entry.name) || spaceName, created,
    ownershipBefore: entry ? entry.ownership : null,
    tookOver: false, handedOff: false,
  };
  let task = null;
  const navErrors = [];
  try {
    const got = await acquire(entry, spaceName, P.profileId);
    task = got.task;
    if (got.alternativeName) {
      meta.alternativeName = got.alternativeName;
      meta.created = true;
      meta.space = got.alternativeName;
    } else if (entry && String(entry.ownership || '') !== 'agent') {
      meta.tookOver = true;
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    emit({ ok: false, error: msg, code: /NAME_IN_USE/.test(msg) ? 'space_name_in_use' : 'task_space_failed' });
    return;
  }

  // 收尾动作：把控制权交还用户（ego 里就不再显示「agent 调试中」，用户也能接着用这个窗口）。
  // 必须是本轮最后一个浏览器动作 —— handOff 之后所有命令都会被硬停。失败重试 3 次。
  async function handOff() {
    for (let i = 0; i < 3; i++) {
      try { await task.handOff(); meta.handedOff = true; delete meta.handOffError; return; }
      catch (e) { meta.handOffError = String((e && e.message) || e); if (i < 2) await sleep(300); }
    }
  }

  if (op === 'open') {
    let page = await pickPage(task);
    const urls = Array.isArray(P.urls) ? P.urls.filter(Boolean) : [];
    // 登录页/风控页可能一直不触发 load 事件（实测千牛登录页会超时）——导航失败不算致命，
    // 但要保证页面最终停在目标地址（或者至少拿一张能用的新页），不能留在 https://x/
    page = await gotoMaybeNewPage(task, page, urls[0], navErrors);
    await page.waitForTimeout(1200).catch(() => {});
    const url = await page.url().catch(() => '');
    // 交给用户：登录/使用是他要做的，agent 不该一直占着这个空间（否则 ego 一直显示「agent 调试中」）
    await handOff();
    emit({ ok: true, ...meta, spaceId: task.spaceId || (entry && entry.id) || null, url, navErrors });
    return;
  }

  if (op === 'autofill') {
    // 代填：进登录页 → 在页面里跑一段填充脚本（账号/密码由宿主从加密库里取出后内联进来）→
    // 等几秒读 cookie 判登录态 → **把控制权交还用户**（验证码/短信要人来点，不能一直占着空间）。
    let page = await pickPage(task);
    page = await gotoMaybeNewPage(task, page, P.url, navErrors);
    await page.waitForTimeout(1800).catch(() => {});
    let filled = null;
    let fillError = null;
    let fillFrame = '';
    let preClicked = false;
    // 抖店这类默认不是「账号密码」页签的站点：先点页签（邮箱登录），等表单渲染出来再填。
    if (P.preExpr) {
      try {
        const pr = await __dshEvalInFrames(page, String(P.preExpr), P.frameHints || [], true);
        preClicked = Boolean(pr && pr.value && pr.value.clicked);
      } catch (e) { /* 点不到就按原样往下试，填充脚本自己也会再点一次页签 */ }
      await page.waitForTimeout(Number(P.preWaitMs) || 600).catch(() => {});
    }
    // 淘宝/天猫/1688 的登录表单在跨域 iframe 里（主页面只有一张欢迎图），
    // 只在主 frame 里查输入框一定是空的 —— 所以按 frameHints 先试「登录框所在的子 frame」。
    try {
      const res = await __dshEvalInFrames(page, String(P.fillExpr || 'null'), P.frameHints || [], true);
      filled = res && res.value ? res.value : null;
      fillFrame = (res && res.frameUrl) || '';
    } catch (e) { fillError = String((e && e.message) || e); }
    if (filled && typeof filled === 'object' && preClicked) filled.preClicked = true;
    // 提交后给站点一点时间跳转（实测 3 秒左右足够淘宝/京东发起跳转）
    await page.waitForTimeout(3200).catch(() => {});
    // 扫一眼页面上的登录失败提示（账号/密码错、验证码）—— 别把"密码错"误报成"要验证码"
    let pageErrorText = '';
    if (P.errorExpr) {
      try {
        const er = await __dshEvalInFrames(page, String(P.errorExpr), P.frameHints || [], false);
        const v = er && er.value ? er.value : null;
        if (v && typeof v === 'object') {
          pageErrorText = [Array.isArray(v.hints) ? v.hints.join(' ') : '', String(v.body || '')].join(' ').slice(0, 4000);
        }
      } catch (e) { /* 扫不到就算了，不影响登录态判断 */ }
    }
    let cookies = null;
    let cookieError = null;
    try {
      const all = await page.cdp('Network.getAllCookies', {});
      cookies = ((all && all.cookies) || []).filter(domainHit).map(pickCookie);
    } catch (e) { cookieError = String((e && e.message) || e); }
    const finalUrl = await page.url().catch(() => '');
    await handOff();
    emit({ ok: true, ...meta, spaceId: task.spaceId || (entry && entry.id) || null, url: finalUrl, filled, fillFrame, fillError, cookies, cookieError, pageErrorText, navErrors });
    return;
  }

  if (op === 'rpa') {
    // 采集 DSL：整条 ops 列表在 ego 运行时里顺序执行（一次任务空间进出，避免每步一次 CLI 往返）。
    // 选择器/表达式/占位符都在 Node 侧编译好了（rpa.mjs 的 compileExecution），这里只当哑执行器。
    const page = await pickPage(task);
    const ops = Array.isArray(P.ops) ? P.ops : [];
    const postprocess = Array.isArray(P.postprocess) ? P.postprocess.map((c) => String(c || '')).filter(Boolean) : [];
    let result = null;
    let error = null;
    try {
      result = await __rpaRunOps(page, ops, { downloadDir: String(P.downloadDir || ''), postprocess });
    } catch (e) { error = String((e && e.message) || e); }
    const cookies = null;
    await handOff();
    emit({
      ok: true, ...meta, spaceId: task.spaceId || (entry && entry.id) || null,
      url: (result && result.finalUrl) || '', rpa: result, rpaError: error, cookies, navErrors,
    });
    return;
  }

  if (op === 'snapshot') {
    // 公开商品页快照（v0.19.0）：把页面导航到商品详情页，跑一段提取脚本（monitor-extract.mjs 生成），
    // 拿回价格 / 销量 / 评价 / SKU / 主图的原始解析结果，然后交还控制权。
    // 只读页面，不点收藏不登录 —— 买家账号的登录态照旧由 ego profile 提供。
    let page = await pickPage(task);
    page = await gotoMaybeNewPage(task, page, P.url, navErrors);
    await page.waitForTimeout(Number(P.waitMs) || 1600).catch(() => {});
    let scrollError = null;
    if (P.scroll !== false) {
      // 商品页的主图/销量常常是懒加载的：先往下滚一段触发加载，再提取（滚不动就算了）
      try {
        await page.cdp('Runtime.evaluate', { expression: 'window.scrollTo(0, 900); void 0;', returnByValue: true, awaitPromise: false });
        await page.waitForTimeout(400).catch(() => {});
      } catch (e) { scrollError = String((e && e.message) || e); }
    }
    let data = null;
    let error = null;
    try {
      const res = await __dshEvalInFrames(page, String(P.expr || 'null'), P.frameHints || [], false);
      data = (res && res.value) || null;
    } catch (e) { error = String((e && e.message) || e); }
    const finalUrl = await page.url().catch(() => '');
    let cookies = null;
    let cookieError = null;
    try {
      const all = await page.cdp('Network.getAllCookies', {});
      cookies = ((all && all.cookies) || []).filter(domainHit).map(pickCookie);
    } catch (e) { cookieError = String((e && e.message) || e); }
    await handOff();
    emit({
      ok: Boolean(data) && !error, ...meta, spaceId: task.spaceId || (entry && entry.id) || null,
      url: finalUrl, snapshot: data, snapshotError: error, scrollError, cookies, cookieError, navErrors,
    });
    return;
  }

  if (op === 'reset') {
    // 只清这个平台域名下的 cookie：共用 profile 的店铺不能被连坐清掉
    const page = await pickPage(task);
    let cleared = 0;
    let clearError = null;
    let targets = [];
    try {
      const all = await page.cdp('Network.getAllCookies', {});
      targets = ((all && all.cookies) || []).filter(domainHit);
      for (const c of targets) {
        try { await page.cdp('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }); cleared += 1; }
        catch (e) { clearError = String((e && e.message) || e); }
      }
    } catch (e) { clearError = String((e && e.message) || e); }
    // 有目标却一个都没清掉（老版本 ego 不支持 deleteCookies / 页面已关）：
    // **不退回整仓清空** —— 那会把共用同一 profile 的另一家店也登出（与"不连坐"的设计相反）。
    // 如实报错，让用户手动在那个窗口里退出登录。
    if (!cleared && targets.length) {
      emit({
        ok: false, code: 'reset_failed', ...meta, spaceId: task.spaceId || (entry && entry.id) || null,
        error: '没能清掉任何 cookie：' + (clearError || '未知原因') +
          '。为免连坐共用 profile 的其它店铺，这次没有做整仓清空 —— 请在那个 ego 窗口里手动退出登录。',
      });
      return;
    }
    if (P.url) { try { await page.goto(P.url, { timeout: 20000 }); } catch (e) { navErrors.push(String((e && e.message) || e)); } }
    await page.waitForTimeout(800).catch(() => {});
    const finalUrl = await page.url().catch(() => '');
    await handOff();
    emit({ ok: true, ...meta, spaceId: task.spaceId || (entry && entry.id) || null, created, cleared, wholeJar: false, wholeJarSkipped: Boolean(targets.length && !cleared), partial: Boolean(clearError && cleared && targets.length), clearError, url: finalUrl, navErrors });
    return;
  }

  if (op === 'handoff') {
    // 单纯把控制权交还用户（不动页面）：用于把早先被 agent 占着的空间「解掉调试中」
    if (!entry) { emit({ ok: true, ...meta, alreadyClosed: true }); return; }
    await handOff();
    emit({ ok: true, ...meta, spaceId: task.spaceId || entry.id || null });
    return;
  }

  if (op === 'close') {
    if (!entry) { emit({ ok: true, ...meta, alreadyClosed: true }); return; }
    try { await task.finish({ keep: [] }); } catch (e) { emit({ ok: false, space: spaceName, error: String((e && e.message) || e) }); return; }
    emit({ ok: true, ...meta, closed: true });
    return;
  }

  emit({ ok: false, error: 'unknown op ' + op });
}

main().catch((e) => emit({ ok: false, error: String((e && e.stack) || e).split('\\n').slice(0, 6).join(' | ') }));
`;
}

/** 只有这两个动作是"用户明确要开窗口"，允许顺手把 ego 拉起来。 */
const LAUNCH_ALLOWED = new Set(['open', 'reset']);

/**
 * 在 ego 运行时里跑一段脚本，拿回结果。
 * 注意：ego CLI 有时即使脚本成功也返回退出码 1（收掉空间/窗口时的收尾），
 * 所以**以 EGO_RESULT 那行为准**，退出码只用来补错误信息。
 */
export function runEgoOp(payload, opts = {}) {
  const cli = opts.cli || resolveEgoCli(opts.egoliteCli);
  if (!cli) return Promise.resolve({ ok: false, code: 'no_ego', error: '找不到 ego-browser CLI（装了 ego lite 后应自动探测到）' });
  const op = String(payload && payload.op || '');

  // 先看 ego 在不在跑：不在就别用 CLI 把它整个拉起来（实测会恢复几十个标签、吃 3GB）
  return egoAppRunning().then((running) => {
    if (!running && !LAUNCH_ALLOWED.has(op)) {
      if (op === 'close' || op === 'handoff') return { ok: true, alreadyClosed: true, appNotRunning: true };
      return {
        ok: false, code: 'ego_not_running', appRunning: false,
        error: 'ego lite 没在运行 —— 插件不会为了查状态把整个浏览器拉起来。点店铺的「打开」，或点「启动 ego」。',
      };
    }
    return runOnce(payload, opts, cli);
  });
}

function runOnce(payload, opts, cli) {
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || RUN_TIMEOUT);
  let runDir = '';
  try {
    runDir = makeRunDir();
  } catch (err) {
    return Promise.resolve({ ok: false, error: '建临时目录失败：' + String((err && err.message) || err) });
  }
  const file = path.join(runDir, 'run.mjs');
  try {
    fs.writeFileSync(file, runnerSource(payload), 'utf8');
  } catch (err) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return Promise.resolve({ ok: false, error: '写临时脚本失败：' + String((err && err.message) || err) });
  }

  return new Promise((resolve) => {
    let child;
    let out = '';
    let errOut = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* 删不掉就留给系统清理 */ }
      resolve(r);
    };
    try {
      child = spawn(cli, ['nodejs', '-e', 'await import(' + JSON.stringify(pathToFileURL(file).href) + ')'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({ ok: false, error: '启动 ego 失败：' + String((err && err.message) || err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ ok: false, error: `ego 执行超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { errOut += String(d); });
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: 'ego 进程错误：' + String((err && err.message) || err) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 实测：结果行有时走 stdout 有时走 stderr（收掉空间/窗口时 CLI 会把收尾输出换流），所以两边一起找
      const lines = [...out.split(/\r?\n/), ...errOut.split(/\r?\n/)].filter((l) => l.startsWith(RESULT_PREFIX));
      if (!lines.length) {
        const tail = (errOut || out).trim().split(/\r?\n/).slice(-2).join(' | ');
        if (isUserInControlOutput(out) || isUserInControlOutput(errOut)) {
          finish({ ok: false, code: 'ego_user_in_control', error: USER_IN_CONTROL_HINT, egoOutput: tail });
          return;
        }
        finish({ ok: false, error: 'ego 没有返回结果（退出码 ' + code + '）' + (tail ? '：' + tail : '') });
        return;
      }
      const last = lines[lines.length - 1].slice(RESULT_PREFIX.length);
      try {
        const parsed = JSON.parse(last);
        finish(parsed);
      } catch (err) {
        finish({ ok: false, error: 'ego 结果解析失败：' + String((err && err.message) || err) });
      }
    });
  });
}

// ── 面向调用方的动作 ────────────────────────────────────────────────────────

export async function egoList(opts = {}) {
  return runEgoOp({ op: 'list' }, opts);
}

export async function egoOpen({ space, spaceId, profileId, urls }, opts = {}) {
  const r = await runEgoOp({ op: 'open', space, spaceId: spaceId || '', profileId: profileId || '', urls: urls || [] }, opts);
  if (r && r.ok) egoAppRunningInvalidate();
  return r;
}

/**
 * 探测登录态：**另开一个临时空间**（同 profile），读完立刻收掉 —— 不接管用户开着的窗口。
 * 实测同一 profile 可以同时开两个 TaskSpace，cookie 罐是同一份，所以结果一样准。
 */
export async function egoProbe({ space, spaceId, profileId, url, domains, tempSpace }, opts = {}) {
  return runEgoOp({
    op: 'probe', space: space || '', spaceId: spaceId || '', profileId: profileId || '',
    url: url || '', domains: Array.isArray(domains) ? domains : [],
    tempSpace: tempSpace || '',
  }, opts);
}

export async function egoClose({ space, spaceId }, opts = {}) {
  return runEgoOp({ op: 'close', space, spaceId: spaceId || '' }, opts);
}

/**
 * 把空间的控制权交还用户：ego 里不再显示「agent 调试中」，页面和登录态都不动。
 * 注意 ego 的语义 —— 交还之后浏览器命令会被硬停，想再操作必须先 takeOverTaskSpace（本模块的 op 内部已处理）。
 */
export async function egoHandOff({ space, spaceId }, opts = {}) {
  return runEgoOp({ op: 'handoff', space, spaceId: spaceId || '' }, opts);
}

/**
 * 在 ego 的 TaskSpace 窗口里跑一次「代填 + 提交」。
 *
 * 安全说明：密码会内联进 ego 运行时脚本（ego CLI 不继承环境变量，只能走参数），
 * 该脚本写在 `%TEMP%/dsh-shop-accounts-ego/run-<rand>/run.mjs`（mkdtemp 私有目录、0600 级别隔离），
 * 执行结束立刻整目录删除。也就是说密码在磁盘上只存在"几秒"，且仅本机本用户可读 ——
 * 比明文长期落盘好，但不是零痕迹；不接受这一点就不要用自动登录（改用「打开窗口手动登录」）。
 */
export async function egoAutofill(account, { url, domains, fillExpr, errorExpr, frameHints, preExpr, preWaitMs }, opts = {}) {
  const a = account || {};
  return runEgoOp({
    op: 'autofill',
    space: spaceNameFor(a),
    spaceId: Number(a.egoSpaceId) || 0,
    profileId: String(a.egoProfile || ''),
    url: String(url || ''),
    domains: Array.isArray(domains) ? domains : [],
    fillExpr: String(fillExpr || 'null'),
    errorExpr: String(errorExpr || ''),
    preExpr: String(preExpr || ''),
    preWaitMs: Number(preWaitMs) || 0,
    frameHints: Array.isArray(frameHints) ? frameHints.map((h) => String(h || '')).filter(Boolean) : [],
  }, opts);
}

/**
 * 在 ego 运行时里跑一段编译好的采集 ops（rpa.mjs 的 compileExecution 产物）。
 * 与 Chrome 后端的 runOps 语义一致；返回 `{ok, code, outputs, artifacts, steps, finalUrl, window}`。
 */
export async function egoRpa({ account, space, spaceId, profileId } = {}, compiled, opts = {}) {
  const a = account || {};
  const spaceName = String(space || spaceNameFor(a) || '').trim();
  const ops = Array.isArray(compiled && compiled.ops) ? compiled.ops : [];
  if (!spaceName) return { ok: false, code: 'NO_SPACE', error: 'ego 后端需要任务空间名（先打开过这个店铺）' };
  if (!ops.length) return { ok: false, code: 'EMPTY_OPS', error: '没有可执行的步骤' };
  const r = await runEgoOp({
    op: 'rpa',
    space: spaceName,
    spaceId: Number(spaceId || a.egoSpaceId) || 0,
    profileId: String(profileId || a.egoProfile || ''),
    ops,
    downloadDir: String((opts && opts.downloadDir) || ''),
    postprocess: Array.isArray(compiled && compiled.postprocess) ? compiled.postprocess : [],
  }, opts);
  if (!r || r.ok === false) return { ok: false, code: r && (r.code || 'EGO_RPA_FAILED'), error: (r && r.error) || 'ego 执行失败', steps: [] };
  const inner = r.rpa || null;
  if (!inner) {
    return {
      ok: false, code: 'EGO_RPA_NO_RESULT', error: r.rpaError || 'ego 没有回报执行结果',
      outputs: {}, artifacts: [], steps: [], finalUrl: String(r.url || ''),
    };
  }
  return {
    ok: Boolean(inner.ok),
    code: inner.code || '',
    error: inner.error,
    dslId: compiled && compiled.dslId,
    outputs: inner.outputs || {},
    artifacts: collectArtifacts({ collection: { artifacts: (compiled && compiled.declaredArtifacts) || [] } }, inner.outputs || {}),
    postprocess: inner.postprocess || undefined,
    steps: inner.trace || [],
    finalUrl: inner.finalUrl || String(r.url || ''),
    window: compiled && compiled.window,
  };
}

/**
 * 公开商品页快照（v0.19.0）：进商品详情页跑一段提取脚本，拿回价格 / 销量 / 评价 / SKU / 主图。
 * 只读，不登录不点收藏；表达式的编译在 monitor-extract.mjs（`buildMonitorExpression`）。
 */
export async function egoSnapshot({ account, space, spaceId, profileId, url, expr, frameHints, waitMs }, opts = {}) {
  const a = account || {};
  const spaceName = String(space || spaceNameFor(a) || '').trim();
  if (!spaceName) return { ok: false, code: 'NO_SPACE', error: 'ego 后端需要任务空间名（先打开过这个账号）' };
  const r = await runEgoOp({
    op: 'snapshot',
    space: spaceName,
    spaceId: Number(spaceId || a.egoSpaceId) || 0,
    profileId: String(profileId || a.egoProfile || ''),
    url: String(url || ''),
    expr: String(expr || 'null'),
    waitMs: Number(waitMs) || 0,
    frameHints: Array.isArray(frameHints) ? frameHints.map((h) => String(h || '')).filter(Boolean) : [],
  }, opts);
  if (!r || r.ok === false) {
    return { ok: false, code: (r && r.code) || 'EGO_SNAPSHOT_FAILED', error: (r && r.error) || r && r.snapshotError || 'ego 执行失败', snapshot: null, finalUrl: (r && r.url) || '', cookies: (r && r.cookies) || null };
  }
  return {
    ok: true,
    snapshot: r.snapshot || null,
    error: r.snapshotError ? String(r.snapshotError) : '',
    finalUrl: String(r.url || ''),
    cookies: Array.isArray(r.cookies) ? r.cookies : null,
    window: { space: spaceName, spaceId: r.spaceId || 0 },
  };
}

/** 清掉这个店铺平台域名下的 cookie 再回登录页（共用 profile 时不会连坐别的店铺）。 */
export async function egoReset({ space, spaceId, profileId, url, domains }, opts = {}) {  const r = await runEgoOp({
    op: 'reset', space, spaceId: spaceId || '', profileId: profileId || '',
    url: url || '', domains: Array.isArray(domains) ? domains : [],
  }, opts);
  if (r && r.ok) egoAppRunningInvalidate();
  return r;
}

/** TaskSpace 名：把店铺名洗成能当名字用、又能一眼认出来的形式。 */
export function spaceNameFor(account) {
  const explicit = String((account && account.egoSpace) || '').trim();
  if (explicit) return stripSpaceName(explicit);
  const base = String((account && account.name) || account.id || 'shop').replace(/[\r\n\t]+/g, ' ').trim();
  return '店铺-' + (base ? stripSpaceName(base) : account.id);
}

/** 空间名的形状统一：去控制字符、折叠空白、限长（ego 拿它当窗口名，别塞奇怪东西进去）。 */
function stripSpaceName(value) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 60 ? s.slice(0, 60) : s;
}

/** 用户手填的 egoSpace：允许为空；不允许控制字符/超长（超长直接报错，别静默截断用户填的名字）。 */
export function normalizeEgoSpace(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('ego 空间名不能包含控制字符（换行/制表符等）');
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length > 60) throw new Error('ego 空间名太长（最多 60 字）：' + clean.slice(0, 20) + '…');
  return clean;
}
