import { accountPlatformOf } from './login-modes.mjs';
import { accountProfileDir, deletableProfileDir, loadAccounts, patchAccount } from './accounts.mjs';
import { appendDebug } from './diagnostics.mjs';
import { backendFor } from './ego.mjs';
import { egoCloseAccount, egoOpenAccount, egoResetAccount } from './ego-backend.mjs';
import { browserUp, closeBrowser, newPage } from './cdp.mjs';
import { ensureDir, readConfig, setRuntime } from './store.mjs';
import { isPortFree, killChromeForProfile, launchBrowser, pickPort, removeProfileDir, resolveBrowserPath, safeNavUrl, waitForCdp, waitPortGone } from './chrome.mjs';
import { ourBrowserOnPort, portOwnership, verifyFreshLaunch } from './port-ownership.mjs';
import { navigatePageTo } from './login-state.mjs';
import { restoreSessionCookies } from './cookies.mjs';

// ── 账号操作 ────────────────────────────────────────────────────────────────

/** 端口分配：账号上已定的端口优先（保证"上架流程记住的端口"不会变），否则找新的。 */
export async function allocatePort(account, cfg) {
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
export async function openAccount(account, mode) {
  const platform = accountPlatformOf(account) || platformOf(account.platform);
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
export async function closeAccount(account, opts = {}) {
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
export async function resetAccount(account) {
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
