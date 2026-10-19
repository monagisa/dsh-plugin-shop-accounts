/**
 * chrome.mjs —— 起 / 停一个「一个账号一份档案」的 Chrome。
 *
 * 为什么每个账号一份 `--user-data-dir`，而不是共用一个：
 *   · cookie 按域存，两家拼多多店铺共用一个档案会**互相挤掉登录态**（前脚登录后脚被顶下线）；
 *   · 共用档案还意味着"删掉一个店铺的登录"做不到 —— 只能全清。
 * 代价是每个档案几十到几百兆，所以档案根目录可以在设置里改到别的盘。
 *
 * 调试端口是「后续上架直接复用」的接口面：起着的 Chrome 就是一个现成的
 * CDP 端点（`http://127.0.0.1:<port>`），上架流程连上去就能用这份登录态，
 * 不需要导出 cookie、也不需要重新扫码。默认从 9222 起排（与本机既有的
 * 店铺浏览器 / pdd 上架脚本对齐），已被占用就往上找空位。
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { browserUp } from './cdp.mjs';

/** 常见安装位置（按优先级）。Edge 作为兜底：它同源同 CDP，能跑通登录流程。 */
export function browserCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

/** 配置里的路径优先；留空或路径不存在就按候选表探测；都没有返回 null。 */
export function resolveBrowserPath(configured) {
  const c = String(configured || '').trim();
  if (c && fs.existsSync(c)) return c;
  for (const p of browserCandidates()) {
    try { if (fs.existsSync(p)) return p; } catch { /* 权限问题，继续找 */ }
  }
  return null;
}

/** 端口是不是空的（TCP 层面）。 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try { srv.listen(port, '127.0.0.1'); } catch { resolve(false); }
  });
}

/** 从 base 往上找一个既没人监听、也不在本插件账号表里的端口。找不到就返回 null。 */
export async function pickPort(base, takenPorts = []) {
  const taken = new Set(takenPorts.filter((p) => Number.isInteger(p)));
  const start = Math.max(1024, Math.min(65000, Number(base) || 9222));
  for (let p = start; p < start + 200 && p <= 65535; p += 1) {
    if (taken.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  return null;
}

/** 等调试端口起来（Chrome 启动到 CDP 可用通常 1~4 秒，冷启动更久）。 */
export async function waitForCdp(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await browserUp(port, 1000)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 启动一个账号的浏览器。返回 { pid }。
 * `--remote-allow-origins=*` 是必需的：Node（undici）的 WebSocket 会带上 Origin，
 * Chrome 从 111 起默认拒绝带 Origin 的 CDP 连接 —— 没有这个开关，读 cookie 一律失败，
 * 界面会一直显示"检测不到登录态"。
 */
export function launchBrowser({ exe, profileDir, port, urls = [], headless = false }) {
  const args = [
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    // 会话级 cookie（没有 expires 的那种）默认**关窗即丢**：淘宝卖家的 `unb` 就是会话级，
    // 于是「登录完点保存 → 关窗 → 再打开」就变回未登录（用户 2026-10-19 报的 bug）。
    // Chrome 只在「启动时恢复上次会话」时才把会话 cookie 落盘并在下次启动读回，
    // 这个命令行开关就是强制走这条路（实测：不加丢、加了留，见 CHANGELOG v0.6.6）。
    '--restore-last-session',
    ...(headless ? [] : ['--window-size=1500,950']),
    ...urls.filter(Boolean),
  ];
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { pid: child.pid || 0, args };
}

/** 用 PowerShell 按 `--user-data-dir` 精确杀进程（CDP 关不掉时的最后手段）。 */
export function killChromeForProfile(profileDir) {
  return new Promise((resolve) => {
    const needle = String(profileDir);
    const ps = [
      '$needle = $env:DSH_SA_KILL_NEEDLE;',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" -ErrorAction SilentlyContinue |",
      '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |',
      '  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "killed $($_.ProcessId)" } catch {} }',
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { env: { ...process.env, DSH_SA_KILL_NEEDLE: needle }, timeout: 20000, windowsHide: true },
      (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim(), error: err ? String(err.message || err) : null }),
    );
  });
}

/**
 * 谁占着这个调试端口？从进程命令行里读 `--user-data-dir=`。
 *
 * 为什么不用 CDP 的 `Browser.getBrowserCommandLine`（实测过）：那个方法在没加 `--enable-automation`
 * 时直接报 "Command line not returned because --enable-automation not set."，而给用户的登录窗口加那个
 * 开关会设置 `navigator.webdriver`，登录站点有可能识别出来 —— 为了认一个端口不值得。
 * 读不到（没有这个进程 / 查询失败）就返回 null，调用方按"未知"处理，不据此拒绝。
 */
export async function chromeOwnerOfPort(port) {
  const p = String(port || '').trim();
  if (!p) return null;
  const ps = [
    '$p = $env:DSH_SA_PORT;',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" -ErrorAction SilentlyContinue |",
    '  Where-Object { $_.CommandLine -and $_.CommandLine -match ("--remote-debugging-port=" + $p + "(\\s|$)") } |',
    "  ForEach-Object { $m = [regex]::Match($_.CommandLine, '--user-data-dir=(?:\"([^\"]+)\"|([^\\s\"]+))');",
    '    if ($m.Success) { if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value } } }',
  ].join(' ');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { env: { ...process.env, DSH_SA_PORT: p }, timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const line = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        resolve(line || null);
      },
    );
  });
}

/** 端口的进程是否还在（用 TCP 探活代替 PID，Chrome 会 fork，PID 往往已经换人）。 */
export async function waitPortGone(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await browserUp(port, 800))) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 删掉一份浏览器档案（「重新扫码」前清场：站点在档案里留着半死的会话时，登录页会直接跳回后台、不给二维码）。
 * 档案被 Chrome 占着会删不掉，所以重试几次；删不干净就如实返回原因，绝不假装成功。
 */
export async function removeProfileDir(profileDir) {
  const dir = String(profileDir || '').trim();
  if (!dir) return { ok: false, error: '空路径' };
  let last = '';
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, dir, attempts: i + 1 };
    } catch (err) {
      last = String((err && err.message) || err);
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return { ok: false, dir, error: last };
}
