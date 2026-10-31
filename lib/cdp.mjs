/**
 * cdp.mjs —— 够用就好的 Chrome DevTools Protocol 客户端。
 *
 * 为什么不用 playwright：本插件的宿主半身要在**用户机器上、任何 DSH 进程里**跑起来，
 * 不能依赖 `<node_global>\node_modules\playwright-core` 那种机器专属路径，
 * 也不该为「读一次 cookie」拉一个几十兆的依赖。本插件用到 CDP 的只有三件事：
 *   · `Network.getAllCookies` —— 判断登录态（含 HttpOnly，`document.cookie` 看不到的那部分）；
 *   · `Runtime.evaluate`     —— 读当前页 URL / 判断页面是否真的到了卖家后台；
 *   · `Browser.close`        —— 点「完成」后干净地关掉那个窗口（让 Chrome 把 cookie 落盘）。
 * HTTP 侧只用 `/json/version`、`/json/list`、`/json/new`。
 *
 * 依赖 Node 22 的全局 `WebSocket`（undici 实现，本插件 engines 已声明 >=22）。
 * 每次调用开一条连接、拿完就关：这些调用都是低频的用户动作（几十毫秒一次），
 * 长连接的复杂度换不来任何东西。
 *
 * **信任边界（2026-10-31 加固）**：本模块连的是「本机 127.0.0.1 上某个端口」，但端口归属
 * 可能被本机其它进程冒名顶替（起个假 `/json/version` 就能骗过 browserUp），而 `setCookies`
 * 会把整罐 cookie（带值）发出去。所以：
 *   1. 端口必须是 1..65535 的整数，URL 用 `new URL()` 拼（不接受 `9222@evil.com` 这种串）；
 *   2. WebSocket 地址必须是 127.0.0.1/localhost/::1，且端口等于调用方期望的端口；
 *   3. 归属判定由调用方先做（chrome.mjs 的 chromeOwnerOfPort / runtime 登记表）。
 */

/** 默认超时：本机 CDP 的正常往返是个位数毫秒，8 秒已经等于"对方没在听"。 */
const DEFAULT_TIMEOUT = 8000;

/** 合法端口：1..65535 的整数。不是就直接抛 —— 绝不让字符串插值进 URL。 */
export function exactPort(port, name = 'port') {
  const n = typeof port === 'number' ? port : Number(String(port || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} 不是合法端口：` + JSON.stringify(port));
  }
  return n;
}

/** 合法的本机 CDP WebSocket 地址（127.0.0.1 / localhost / [::1]），可选校验端口。 */
export function assertLocalWs(wsUrl, expectedPort) {
  const s = String(wsUrl || '').trim();
  if (!s) throw new Error('CDP WebSocket 地址为空');
  let u;
  try { u = new URL(s); } catch { throw new Error('CDP WebSocket 地址不合法：' + s); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('CDP WebSocket 协议不对：' + u.protocol);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('CDP WebSocket 不是本机地址（拒绝把调试命令发到别的机器）：' + host);
  }
  if (expectedPort != null) {
    const want = exactPort(expectedPort);
    const got = Number(u.port) || (u.protocol === 'wss:' ? 443 : 80);
    if (got !== want) throw new Error(`CDP WebSocket 端口(${got})与期望端口(${want})不一致`);
  }
  return s;
}

/** 一个 CDP HTTP 端点（/json/*）。 */
export async function httpJson(port, pathname, timeoutMs = 2500) {
  const p = exactPort(port);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // 用 URL 对象拼接：端口是整数、host 写死，不存在字符串插值带来的 host 注入
    const url = new URL(`http://127.0.0.1:${p}${pathname}`);
    const res = await fetch(url, {
      signal: ctl.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 端口上是否有一只在跑、且开着调试端口的 Chromium。 */
export async function browserUp(port, timeoutMs = 1200) {
  if (!port) return false;
  try {
    const v = await httpJson(port, '/json/version', timeoutMs);
    if (!v || !(v.Browser || v['User-Agent'])) return false;
    // 有 webSocketDebuggerUrl 的再核一次：必须是本机 + 端口一致，否则当它不是 Chrome
    if (v.webSocketDebuggerUrl) {
      try { assertLocalWs(v.webSocketDebuggerUrl, port); } catch { return false; }
    }
    return true;
  } catch {
    return false;
  }
}

/** 浏览器版本信息（未运行返回 null）。 */
export async function browserInfo(port) {
  try {
    const v = await httpJson(port, '/json/version', 1500);
    return { ok: true, browser: v.Browser || '', userAgent: v['User-Agent'] || '', ws: v.webSocketDebuggerUrl || '' };
  } catch {
    return null;
  }
}

/** 所有可调试目标（/json/list）。 */
export async function listTargets(port) {
  try {
    const list = await httpJson(port, '/json/list', 2500);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 页面类目标。 */
export async function listPages(port) {
  const all = await listTargets(port);
  return all.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
}

/** 新建一个标签页，返回目标对象（Chrome ≥ 111 用 PUT）。 */
export async function newPage(port, url) {
  try {
    const p = exactPort(port);
    const res = await fetch(`http://127.0.0.1:${p}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  }
}

/** 关掉一个页面目标（标签页）。Chrome 附带的 `/json/close/<id>` 是 GET，失败返回 false。 */
export async function closePage(port, targetId) {
  if (!targetId) return false;
  try {
    const p = exactPort(port);
    const res = await fetch(`http://127.0.0.1:${p}/json/close/${encodeURIComponent(targetId)}`, {
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 在一条 WebSocket 上调一次 CDP 方法。`expectedPort` 给了就校验 ws 的 host/端口。 */
export function cdpCall(wsUrl, method, params = {}, timeoutMs = DEFAULT_TIMEOUT, expectedPort) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(assertLocalWs(wsUrl, expectedPort));
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已经关了 */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`CDP 超时（${method}）`)), timeoutMs);

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ id: 1, method, params }));
      } catch (err) {
        finish(reject, err);
      }
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (!msg || msg.id !== 1) return;
      if (msg.error) finish(reject, new Error(msg.error.message || `CDP 错误（${method}）`));
      else finish(resolve, msg.result);
    });
    ws.addEventListener('error', () => finish(reject, new Error('CDP 连接失败（Chrome 拒绝了调试连接）')));
    ws.addEventListener('close', () => finish(reject, new Error('CDP 连接被关闭')));
  });
}

/**
 * 读浏览器里的**全部** cookie（含 HttpOnly）。
 * 必须挂在某个 page 目标上：`Network` 域在 browser 级端点上不存在。
 * 没有任何页面时新建一个 about:blank —— 拿不到目标就返回 null，由调用方退化成 URL 判据。
 */
export async function getAllCookies(port) {
  const p = exactPort(port);
  let pages = await listPages(p);
  if (!pages.length) {
    const created = await newPage(p, 'about:blank');
    if (created && created.webSocketDebuggerUrl) pages = [created];
  }
  if (!pages.length) return null;

  const target = pages.find((p2) => /^https?:/i.test(p2.url || '')) || pages[0];
  await cdpCall(target.webSocketDebuggerUrl, 'Network.enable', {}, 5000, p).catch(() => {});
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Network.getAllCookies', {}, 8000, p);
  const cookies = result && Array.isArray(result.cookies) ? result.cookies : [];
  return { cookies, url: target.url || '' };
}

/** 读某个页面目标的当前 URL（比 /json/list 里那份更"现在"）。`expectedPort` 用于校验 ws 归属。 */
export async function evaluateOn(wsUrl, expression, timeoutMs = 5000, expectedPort) {
  const r = await cdpCall(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true }, timeoutMs, expectedPort);
  return r && r.result ? r.result.value : undefined;
}

/**
 * 把一个 cookie 罐写回浏览器（`Network.setCookies`）。
 *
 * 为什么需要：**会话级 cookie（expires=-1）会在「点 X 关窗」时丢掉**。
 * 淘宝/千牛的 `unb` 就是会话级 —— 丢了之后重开档案站点直接按回登录页。
 * CDP 的 `Browser.close` 走正常退出能落盘，但用户点窗口红叉时不归我们管。
 * 所以保存登录态时把 cookie 罐另存一份，下次启动先补回去，再打开页面。
 *
 * 只回填 CDP 认的字段；`expires<=0` 的不传（保持会话级），`sameSite` 只认三个合法值。
 *
 * **注意**：这个调用会把 cookie 值发给「端口上的那个浏览器」。调用方必须先确认端口真的是
 * 本插件起的那个档案（runtime 登记表 / chromeOwnerOfPort），否则等于把登录态送给冒名者。
 */
export async function setCookies(port, cookies, timeoutMs = 8000) {
  const p = exactPort(port);
  const list = (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && typeof c.name === 'string' && c.value != null)
    .map((c) => {
      const out = {
        name: c.name,
        value: String(c.value),
        domain: c.domain,
        path: c.path || '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
      };
      if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
      if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') out.sameSite = c.sameSite;
      return out;
    })
    .filter((c) => c.domain);
  if (!list.length) return false;

  let pages = await listPages(p);
  if (!pages.length) {
    const created = await newPage(p, 'about:blank');
    if (created && created.webSocketDebuggerUrl) pages = [created];
  }
  if (!pages.length) return false;
  const target = pages.find((p2) => /^https?:/i.test(p2.url || '')) || pages[0];
  await cdpCall(target.webSocketDebuggerUrl, 'Network.enable', {}, 5000, p).catch(() => {});
  await cdpCall(target.webSocketDebuggerUrl, 'Network.setCookies', { cookies: list }, timeoutMs, p);
  return true;
}

/**
 * 关掉整个浏览器（不是关一个标签页）：走 browser 级端点 `Browser.close`，
 * 这样 Chrome 会走正常退出流程，把 cookie / Local Storage 落进档案目录。
 * 失败返回 false —— 调用方自己去 taskkill，不在这里静默丢账。
 */
export async function closeBrowser(port) {
  const p = exactPort(port);
  const info = await browserInfo(p);
  if (!info || !info.ws) return false;
  try {
    await cdpCall(info.ws, 'Browser.close', {}, 5000, p);
    return true;
  } catch {
    return false;
  }
}
