/**
 * cdp.mjs —— 够用就好的 Chrome DevTools Protocol 客户端。
 *
 * 为什么不用 playwright：本插件的宿主半身要在**用户机器上、任何 DSH 进程里**跑起来，
 * 不能依赖 `D:\node-v22.23.1\node_global\node_modules\playwright-core` 那种机器专属路径，
 * 也不该为「读一次 cookie」拉一个几十兆的依赖。本插件用到 CDP 的只有三件事：
 *   · `Network.getAllCookies` —— 判断登录态（含 HttpOnly，`document.cookie` 看不到的那部分）；
 *   · `Runtime.evaluate`     —— 读当前页 URL / 判断页面是否真的到了卖家后台；
 *   · `Browser.close`        —— 点「完成」后干净地关掉那个窗口（让 Chrome 把 cookie 落盘）。
 * HTTP 侧只用 `/json/version`、`/json/list`、`/json/new`。
 *
 * 依赖 Node 22 的全局 `WebSocket`（undici 实现，本插件 engines 已声明 >=22）。
 * 每次调用开一条连接、拿完就关：这些调用都是低频的用户动作（几十毫秒一次），
 * 长连接的复杂度换不来任何东西。
 */

/** 默认超时：本机 CDP 的正常往返是个位数毫秒，8 秒已经等于"对方没在听"。 */
const DEFAULT_TIMEOUT = 8000;

/** 一个 CDP HTTP 端点（/json/*）。 */
export async function httpJson(port, pathname, timeoutMs = 2500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
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
    return Boolean(v && (v.Browser || v['User-Agent']));
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
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
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
    const res = await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`, {
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 在一条 WebSocket 上调一次 CDP 方法。 */
export function cdpCall(wsUrl, method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
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
  let pages = await listPages(port);
  if (!pages.length) {
    const created = await newPage(port, 'about:blank');
    if (created && created.webSocketDebuggerUrl) pages = [created];
  }
  if (!pages.length) return null;

  const target = pages.find((p) => /^https?:/i.test(p.url || '')) || pages[0];
  await cdpCall(target.webSocketDebuggerUrl, 'Network.enable', {}, 5000).catch(() => {});
  const result = await cdpCall(target.webSocketDebuggerUrl, 'Network.getAllCookies', {}, 8000);
  const cookies = result && Array.isArray(result.cookies) ? result.cookies : [];
  return { cookies, url: target.url || '' };
}

/** 读某个页面目标的当前 URL（比 /json/list 里那份更"现在"）。 */
export async function evaluateOn(wsUrl, expression, timeoutMs = 5000) {
  const r = await cdpCall(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true }, timeoutMs);
  return r && r.result ? r.result.value : undefined;
}

/**
 * 关掉整个浏览器（不是关一个标签页）：走 browser 级端点 `Browser.close`，
 * 这样 Chrome 会走正常退出流程，把 cookie / Local Storage 落进档案目录。
 * 失败返回 false —— 调用方自己去 taskkill，不在这里静默丢账。
 */
export async function closeBrowser(port) {
  const info = await browserInfo(port);
  if (!info || !info.ws) return false;
  try {
    await cdpCall(info.ws, 'Browser.close', {}, 5000);
    return true;
  } catch {
    return false;
  }
}
