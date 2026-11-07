import { accountPlatformOf } from './login-modes.mjs';
import { accountProfileDir, loadAccounts } from './accounts.mjs';
import { appendDebug } from './diagnostics.mjs';
import { backendFor } from './ego.mjs';
import { egoCheckAccount } from './ego-backend.mjs';
import { browserUp, closeBrowser, closePage, evaluateOn, getAllCookies, listPages, newPage } from './cdp.mjs';
import { restoreSessionCookies, saveSessionCookies } from './cookies.mjs';
import { judgeLogin, looksLikeLoginPage, platformOf, tokenExpiryOf } from './platforms.mjs';
import { ensureDir, readConfig, setRuntime } from './store.mjs';
import { isPortFree, killChromeForProfile, launchBrowser, pickPort, resolveBrowserPath, waitForCdp, waitPortGone } from './chrome.mjs';
import { ourBrowserOnPort, verifyFreshLaunch } from './port-ownership.mjs';
import { sleep } from './async-util.mjs';
import { checkPatch } from './login-check.mjs';

// ── 登录态检测 ──────────────────────────────────────────────────────────────

/**
 * 检测一个账号的登录态。三种情形：
 *   · 浏览器在跑   → 读它的 cookie + 当前页 URL（最准）；
 *   · 不在跑、要静默 → 用**无头** Chrome 开同一个档案探一次（不弹窗，几秒），
 *                     探完就关 —— 这是"关着窗口也能显示登录状态"的唯一办法；
 *   · 都不行       → 返回上一次的检测结果并标注 stale。
 */
export async function checkAccount(account, opts = {}) {
  const platform = accountPlatformOf(account) || platformOf(account.platform);
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
export async function pickSiteUrl(port, platform) {
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

export async function readLoginFrom(port, platform, preferUrl = '') {
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
 * v0.19.8：代填之前先看一眼「是不是已经登录了」。
 *
 * 用户会遇到这种情况：窗口里其实已经是登录态（cookie 都好着），但点「自动登录」/「打开」后
 * 代填链路会先把页面导回登录地址、再填一次账号密码，看起来就像「自己又退回去登了一遍」。
 * 这里只读不写：ego 用临时空间读一次 cookie（不碰用户开着的窗口），Chrome 读端口上的 cookie。
 * 读不到就返回 null，调用方按原逻辑继续代填（宁可多填一次，也别把真掉线的人卡住）。
 */
export async function quickLoginState(account) {
  const platform = accountPlatformOf(account) || platformOf(account.platform);
  try {
    if (backendFor(readConfig()) === 'egolite') {
      const out = await egoCheckAccount(account, { launch: false }).catch(() => null);
      return out && out.loggedIn ? out : null;
    }
    const port = Number(account.port) || 0;
    if (!port) return null;
    const siteUrl = await pickSiteUrl(port, platform).catch(() => '');
    const out = await readLoginFrom(port, platform, siteUrl).catch(() => null);
    return out && out.loggedIn ? out : null;
  } catch {
    return null;
  }
}

/**
 * 让已经开着的窗口跳到某个地址（用来催站点把身份 cookie 种下来）。
 */
export async function navigatePageTo(port, url) {
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
