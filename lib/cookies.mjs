// 会话 cookie 的本地备份与快照（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 「点 X 关窗」会丢会话级 cookie，所以登录态落定后把整罐（加密）存到本机档案目录，下次先补回去。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDir, readConfig, isInsideProfileRoot } from './store.mjs';
import { getAllCookies, setCookies, browserUp } from './cdp.mjs';
import { sessionKey, sealCookieJar, openCookieJar } from './secret.mjs';
import { platformOf, domainMatches } from './platforms.mjs';
import { accountProfileDir } from './accounts.mjs';
import { ourBrowserOnPort } from './port-ownership.mjs';

export async function snapshotAccount(account, platform) {
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
export function sessionCookieFile(account) {
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

export function loadSessionCookies(account) {
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
export async function rememberLiveCookies(account) {
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
