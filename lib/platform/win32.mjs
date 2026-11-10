/**
 * platform/win32.mjs —— Windows 平台适配（v0.10.0 从 secret.mjs / chrome.mjs / ego.mjs / index.js 抽出来）
 *
 * 这一层只做一件事：把「跟操作系统打交道」的部分集中起来，让业务代码不再出现
 * `process.platform === 'win32'` 和 `C:\Program Files` 这类硬编码。
 * 对外接口的契约见 ./index.mjs 顶部注释。
 *
 * Windows 上的实现细节与抽取前**逐字一致**（PowerShell 脚本、候选路径、进程匹配口径都没改），
 * 这样 143 项自检就是这次重构的回归网。
 */
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const id = 'win32';
export const label = 'Windows';

/** 敏感数据（主密钥）后端：Windows 用 DPAPI（CurrentUser）。 */
export const secretBackend = 'dpapi';

export const capabilities = {
  platform: id,
  platformLabel: label,
  secret: true, // 有密钥后端才能安全保存密码
  secretBackend,
  browser: true,
  ego: true,
  reveal: true,
};

// ── 密钥后端：DPAPI（经 PowerShell，ConvertFrom-SecureString 兼容）────────────────

const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  '$in = [Console]::In.ReadToEnd()',
  'if ($null -eq $in) { $in = "" }',
  '$sec = ConvertTo-SecureString -String $in -AsPlainText -Force',
  '[Console]::Out.Write((ConvertFrom-SecureString -SecureString $sec))',
].join('\n');

const PS_UNPROTECT = [
  "$ErrorActionPreference = 'Stop'",
  '$in = [Console]::In.ReadToEnd()',
  'if ($null -eq $in -or $in.Trim().Length -eq 0) { throw "empty protected string" }',
  '$sec = $in | ConvertTo-SecureString',
  '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)',
  'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
].join('\n');

function runPowerShell(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: String(input == null ? '' : input),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
}

/** 保护一段明文，返回可落盘的字符串。`_dataDir` 在 Windows 上不参与（DPAPI 按用户加密）。 */
export function secretProtect(_dataDir, text) {
  return runPowerShell(PS_PROTECT, text);
}

/** 反向。`_dataDir` 同上（保留参数是为了和 macOS 的 Keychain 后端同签名）。 */
export function secretUnprotect(_dataDir, blob) {
  return runPowerShell(PS_UNPROTECT, blob);
}

/** 解不开时重试前的等待（AV 扫描常造成短暂占用）。 */
export function secretRetryDelaySync() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 150'], { timeout: 5000, windowsHide: true });
  } catch { /* ignore */ }
}

// ── 浏览器可执行文件 ─────────────────────────────────────────────────────────

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

const BROWSER_BASENAMES = new Set(['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe', 'thorium.exe', 'vivaldi.exe', 'opera.exe', 'edge.exe']);

/**
 * 扫本机浏览器的候选目标（v0.20.3 / v0.20.5）：只列插件**真正能驱动**的两个——
 * Google Chrome（Chrome 后端走 CDP）与 ego lite（ego 后端）。其它 Chromium 系产品虽然同源，
 * 但插件没有对应的实测与配置路径，列出来只会让人以为能用。
 */
export function browserScanTargets() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || process.env['ProgramW6432'] || 'C:\\Program Files (x86)';
  const roots = [pf, pf86, local].filter(Boolean);
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      exe: 'chrome.exe',
      product: 'Chromium',
      bases: roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application')),
    },
    {
      id: 'egolite',
      name: 'ego lite',
      exe: 'ego.exe',
      product: 'ego 浏览器',
      bases: [],
      files: egoAppCandidates(),
    },
  ];
}

/** 用户填的浏览器可执行路径，文件名是否在允许名单里（防 `chrome-evil.exe` 这类骗法）。 */
export function isBrowserExecutable(basename) {
  return BROWSER_BASENAMES.has(String(basename || '').toLowerCase());
}

/** 进程名匹配用的浏览器主程序名（进程查询 / 归属判断）。 */
export function browserProcessNames() {
  return [...BROWSER_BASENAMES];
}

/** 用户填的 ego 可执行文件名是否合规（防 `not-ego.exe`）。 */
export function isEgoExecutable(basename) {
  return /^ego([ .-][a-z0-9 ._-]*)?\.exe$/.test(String(basename || '').toLowerCase());
}

// ── 进程：按 --user-data-dir 精确匹配 ────────────────────────────────────────

/**
 * 用 PowerShell 按 `--user-data-dir` **精确匹配**杀进程（CDP 关不掉时的最后手段）。
 *
 * 必须是"解析出 --user-data-dir 再比较相等"，不能用"命令行包含这个串"：
 * 后者在 profileDir 是 `C:\Program Files` 这类短前缀时会把**所有** Chrome/Edge 都杀掉
 * （2026-10-31 二次审查抓到的真实放大路径：导入目录 → 打开失败 → 强杀全机浏览器）。
 */
export function killByProfileDir(profileDir) {
  return new Promise((resolve) => {
    const needle = String(profileDir || '').trim();
    if (!needle) {
      resolve({ ok: false, out: '', error: '拒绝用空路径做进程匹配' });
      return;
    }
    const ps = [
      '$needle = $env:DSH_SA_KILL_NEEDLE;',
      // 归一化到完整路径：尾随点/斜杠/\\.\\ 这类写法（Chrome 有些版本会带）也能和 needle 对上
      'try { $needle = [IO.Path]::GetFullPath($needle) } catch {}',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" -ErrorAction SilentlyContinue |",
      '  ForEach-Object {',
      '    $cl = $_.CommandLine;',
      '    if (-not $cl) { return }',
      "    $m = [regex]::Match($cl, '--user-data-dir=(?:\"([^\"]+)\"|([^\\s\"]+))');",
      '    if (-not $m.Success) { return }',
      '    $ud = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value };',
      '    try { $ud = [IO.Path]::GetFullPath($ud) } catch {}',
      // 去掉尾部分隔符再比（大小写不敏感是 PowerShell -ne 的默认行为）
      "    if ($ud.TrimEnd('\\','/') -ne $needle.TrimEnd('\\','/')) { return }",
      '    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "killed $($_.ProcessId)" } catch {}',
      '  }',
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
export async function ownerOfPort(port) {
  const p = String(port || '').trim();
  if (!p || !/^\d{1,5}$/.test(p)) return null;
  const ps = [
    '$p = $env:DSH_SA_PORT;',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" -ErrorAction SilentlyContinue |",
    '  ForEach-Object {',
    '    $cl = $_.CommandLine;',
    '    if (-not $cl) { return }',
    // 端口匹配前先把引号去掉：带空格的路径会让 Chrome 给参数加引号，正则会漏
    '    $flat = $cl -replace \'"\', \'\' -replace "\'", \'\';',
    '    if ($flat -notmatch (\'--remote-debugging-port=\' + $p + \'(\\s|$)\')) { return }',
    "    $m = [regex]::Match($cl, '--user-data-dir=(?:\"([^\"]+)\"|([^\\s\"]+))');",
    '    if ($m.Success) { if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value } }',
    '  }',
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

/** 杀掉一个进程树（ego CLI 子进程用）。 */
export function killPidTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  try { spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true }); } catch { /* 已经退了 */ }
}

// ── 打开目录（资源管理器）────────────────────────────────────────────────────

/** 用资源管理器打开目录（已由调用方做过"必须在档案根内"的校验）。 */
export function revealDir(dir) {
  const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
  child.unref();
}

// ── ego lite 位置 ────────────────────────────────────────────────────────────

const PATH_SEP = ';';

/** ego-browser CLI 的常见位置（按优先级）。 */
export function egoCliCandidates() {
  const home = process.env.USERPROFILE || os.homedir();
  const local = process.env.LOCALAPPDATA || '';
  const out = [
    path.join(home, '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe'),
    local ? path.join(local, 'Programs', 'ego-lite', 'ego-browser.exe') : '',
  ];
  // PATH 里也可能有（ego 安装时会登记，但已启动的进程拿到的是旧 PATH，所以只作兜底）
  for (const dir of String(process.env.PATH || '').split(PATH_SEP)) {
    if (dir && /ego/i.test(dir)) out.push(path.join(dir, 'ego-browser.exe'));
  }
  return out.filter(Boolean);
}

/** ego lite 主程序位置（只在需要启动 app 时用）。 */
export function egoAppCandidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf, 'Citro Labs', 'ego lite', 'Application', 'ego.exe'),
    local ? path.join(local, 'Programs', 'ego lite', 'Application', 'ego.exe') : '',
  ].filter(Boolean);
}

/** ego lite 的 User Data 根目录候选（`Profile 1/2/3` 的父目录）。 */
export function egoUserDataDirs() {
  const local = process.env.LOCALAPPDATA || '';
  const home = process.env.USERPROFILE || os.homedir();
  return [
    local ? path.join(local, 'Citro Labs', 'ego lite', 'User Data') : '',
    path.join(home, 'AppData', 'Local', 'Citro Labs', 'ego lite', 'User Data'),
  ].filter(Boolean);
}

/** PATH 分隔符（Windows 是 `;`，POSIX 是 `:`）。 */
export function pathSeparator() {
  return PATH_SEP;
}

/** 该平台是否存在「ego 主程序」这种东西（darwin 上未知，按候选表探测结果为准）。 */
export function egoSupported() {
  return true;
}

/** 目录是否在系统/程序目录里（`updateDir` 校验用）。 */
export function systemDirs() {
  return [process.env.SystemRoot, process.env.windir, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean);
}

/** 启动浏览器时的额外 spawn 选项（Windows 上要 windowsHide:false 才能弹窗）。 */
export function browserSpawnOptions() {
  return { detached: true, stdio: 'ignore', windowsHide: false };
}
