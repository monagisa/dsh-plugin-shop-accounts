/**
 * platform/darwin.mjs —— macOS 平台适配（v0.10.0 新增）
 *
 * 对应关系：
 *   · DPAPI            → **Keychain**（`/usr/bin/security`，系统自带，无需安装）
 *   · `C:\Program Files\...\chrome.exe` → `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
 *   · `Get-CimInstance Win32_Process`   → `ps -axo pid=,command=` 解析
 *   · `taskkill /T /F`                  → `pkill -P` + `kill -9`
 *   · `explorer.exe`                   → `open`
 *
 * ⚠️ 这一份实现**尚未在真机 macOS 上验证过**（开发机只有 Windows）。逻辑按 macOS 的标准
 * 命令行工具写，接口与 win32.mjs 完全对称；验收清单见 CHANGELOG v0.10.0。
 * 未验证的点集中在两处：`security` 首次访问会弹钥匙串授权、以及 ego lite 到底有没有 mac 版。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const id = 'darwin';
export const label = 'macOS';

/** 敏感数据（主密钥）后端：macOS 用 Keychain（登录钥匙串，系统自带）。 */
export const secretBackend = 'keychain';

export const capabilities = {
  platform: id,
  platformLabel: label,
  secret: true,
  secretBackend,
  browser: true,
  ego: true, // 候选表里没有就是没装，运行时会降级到 Chrome 后端
  reveal: true,
};

const SECURITY = '/usr/bin/security';
const KEYCHAIN_SERVICE_PREFIX = 'dsh-shop-accounts-';

/**
 * macOS 上路径就是 POSIX 路径，所以这里**固定用 path.posix**，不要用平台相关的 path：
 *   · 语义上更准（在 mac 上两者一样，但 mac 路径规则不随宿主变化）；
 *   · 顺带的好处是这份实现在 Windows 开发机上也能被自检覆盖（否则 `path.join` 会拼出反斜杠路径，
 *     测试就只能验证"代码存在"，验证不了"值对不对"）。
 */
const posix = path.posix;

/**
 * 每个数据目录一条独立的 Keychain 条目：service = 前缀 + 数据目录哈希。
 * 这样多个 DSH 档案/多个插件实例互不干扰，也不会互相覆盖主密钥。
 */
function serviceFor(dataDir) {
  const dir = posix.resolve(String(dataDir || '.'));
  // 用路径本身的可读片段 + 稳定哈希：既方便钥匙串访问里认人，又避免路径太长/带特殊字符
  const readable = posix.basename(dir).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'data';
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
  return `${KEYCHAIN_SERVICE_PREFIX}${readable}-${hash}`;
}

function runSecurity(args, input) {
  return execFileSync(SECURITY, args, {
    input: input == null ? undefined : String(input),
    encoding: 'utf8',
    timeout: 20000,
  });
}

/**
 * 把明文写进 Keychain，返回落盘用的标记串 `keychain:<service>`。
 * 用 `-U`：已存在就更新（对应 Windows 上 `wx` 写失败后读回已有密钥的分支）。
 */
export function secretProtect(dataDir, text) {
  const service = serviceFor(dataDir);
  const account = process.env.USER || os.userInfo().username || 'dsh';
  // -w 的值走命令行参数：内容是我们自己生成的 base64，不含空格/引号，安全
  runSecurity(['add-generic-password', '-U', '-a', account, '-s', service, '-w', String(text)]);
  return `keychain:${service}`;
}

/** 从 Keychain 取回明文。标记串不合法或条目不存在就抛（调用方按"解不开"处理）。 */
export function secretUnprotect(dataDir, blob) {
  const raw = String(blob || '').trim();
  let service = '';
  if (raw.startsWith('keychain:')) {
    service = raw.slice('keychain:'.length).trim();
  } else {
    // 兼容：早期版本可能只存了空文件/纯文本，按当前数据目录推导 service
    service = serviceFor(dataDir);
  }
  if (!service) throw new Error('keychain: 缺少 service 名');
  const out = runSecurity(['find-generic-password', '-s', service, '-w']);
  const text = String(out || '').replace(/\r?\n$/, '');
  if (!text) throw new Error('keychain: 条目为空');
  return text;
}

/** Keychain 没有「短暂占用重试」的问题，这里 no-op（保留接口对称）。 */
export function secretRetryDelaySync() { /* no-op on macOS */ }

// ── 浏览器可执行文件 ─────────────────────────────────────────────────────────

/** macOS 上的浏览器主程序路径（.app 包内的真实二进制）。 */
export function browserCandidates(opts = {}) {
  const home = opts.home || os.homedir();
  const apps = opts.applications || '/Applications';
  const mk = (app, bin) => posix.join(apps, app, 'Contents', 'MacOS', bin);
  const userApps = posix.join(home, 'Applications');
  const out = [
    mk('Google Chrome.app', 'Google Chrome'),
    posix.join(userApps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    mk('Microsoft Edge.app', 'Microsoft Edge'),
    posix.join(userApps, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    mk('Chromium.app', 'Chromium'),
    mk('Brave Browser.app', 'Brave Browser'),
  ];
  return out.filter(Boolean);
}

/** macOS 上「扫本机浏览器」的目标：只列插件真正能驱动的两个（Google Chrome 与 ego lite）。 */
export function browserScanTargets(opts = {}) {
  const cands = browserCandidates(opts);
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      exe: 'Google Chrome',
      product: 'Chromium',
      files: cands.filter((c) => posix.basename(c) === 'Google Chrome'),
    },
    {
      id: 'egolite',
      name: 'ego lite',
      exe: 'ego',
      product: 'ego 浏览器',
      files: egoAppCandidates(),
    },
  ];
}

/** macOS 上可执行文件名就是 app 的二进制名（没有 .exe 后缀）。 */
const BROWSER_BASENAMES = new Set([
  'google chrome', 'microsoft edge', 'chromium', 'brave browser', 'vivaldi', 'opera',
]);

export function isBrowserExecutable(basename) {
  return BROWSER_BASENAMES.has(String(basename || '').toLowerCase());
}

/** `ps` 里出现的浏览器进程名（大写开头，macOS 的 comm 就是二进制名）。 */
export function browserProcessNames() {
  return ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser', 'Vivaldi', 'Opera'];
}

/** ego 是 .app 包，二进制名就叫 ego（小写），文件名规则不能沿用 Windows 的 .exe 正则。 */
export function isEgoExecutable(basename) {
  return /^ego(-browser)?$/.test(String(basename || '').toLowerCase());
}

// ── 进程：按 --user-data-dir 精确匹配 ────────────────────────────────────────

/**
 * 一次 `ps` 拿到所有进程的 pid + 完整命令行。
 * 只取 `pid=` + `command=`，避免 `ps` 的列宽截断把长命令行切掉。
 */
function psSnapshot() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return String(out || '').split('\n').map((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), command: m[2] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** 从命令行里抠出 `--user-data-dir=` 的值（支持带引号的路径）。 */
function userDataDirOf(command) {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(String(command || ''));
  if (!m) return null;
  return m[1] || m[2] || null;
}

function normDir(p) {
  if (!p) return '';
  let s = String(p);
  try { s = posix.resolve(s); } catch { /* 解析失败就按原串比 */ }
  return s.replace(/[\\/]+$/, '');
}

/**
 * 按 `--user-data-dir` 精确匹配杀进程。
 *
 * 和 Windows 侧同样的安全要求：**解析出参数再比较相等**，不能用"命令行包含这个串"——
 * 否则短前缀（比如 `/Users`）会误杀同一用户下的所有 Chrome。
 */
export function killByProfileDir(profileDir) {
  return new Promise((resolve) => {
    const needle = normDir(String(profileDir || '').trim());
    if (!needle || needle === '/') {
      resolve({ ok: false, out: '', error: '拒绝用空路径/根路径做进程匹配' });
      return;
    }
    const killed = [];
    try {
      for (const p of psSnapshot()) {
        const ud = userDataDirOf(p.command);
        if (!ud) continue;
        if (normDir(ud) !== needle) continue;
        try { process.kill(p.pid, 'SIGKILL'); killed.push(p.pid); } catch { /* 已经退了 */ }
      }
      resolve({ ok: true, out: killed.map((x) => `killed ${x}`).join('\n'), error: null });
    } catch (err) {
      resolve({ ok: false, out: '', error: String((err && err.message) || err) });
    }
  });
}

/** 谁占着这个调试端口？从进程命令行里读 `--user-data-dir=`。读不到返回 null。 */
export async function ownerOfPort(port) {
  const p = String(port || '').trim();
  if (!p || !/^\d{1,5}$/.test(p)) return null;
  const re = new RegExp('--remote-debugging-port=' + p + '(?:\\s|$)');
  for (const proc of psSnapshot()) {
    if (!re.test(proc.command)) continue;
    const ud = userDataDirOf(proc.command);
    if (ud) return ud;
  }
  return null;
}

/** 杀掉一个进程树（ego CLI 子进程用）：先子后父，失败静默。 */
export function killPidTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  try { spawnSync('sh', ['-c', `pkill -9 -P ${n} 2>/dev/null; kill -9 ${n} 2>/dev/null || true`], { timeout: 10000 }); } catch { /* 已经退了 */ }
}

// ── 打开目录（Finder）────────────────────────────────────────────────────────

export function revealDir(dir) {
  const child = spawn('open', [dir], { detached: true, stdio: 'ignore' });
  child.unref();
}

// ── ego lite 位置（mac 版是否存在待验证；找不到就由上层降级到 Chrome）──────────

const PATH_SEP = ':';

export function egoCliCandidates() {
  const home = process.env.HOME || os.homedir();
  const out = [
    posix.join(home, '.local', 'share', 'ego', 'active_version_dir', 'ego-browser'),
    posix.join(home, 'Library', 'Application Support', 'ego', 'active_version_dir', 'ego-browser'),
    '/Applications/ego lite.app/Contents/MacOS/ego-browser',
    posix.join(home, 'Applications', 'ego lite.app', 'Contents', 'MacOS', 'ego-browser'),
  ];
  for (const dir of String(process.env.PATH || '').split(PATH_SEP)) {
    if (dir && /ego/i.test(dir)) out.push(posix.join(dir, 'ego-browser'));
  }
  return out.filter(Boolean);
}

export function egoAppCandidates() {
  const home = process.env.HOME || os.homedir();
  return [
    '/Applications/ego lite.app/Contents/MacOS/ego',
    posix.join(home, 'Applications', 'ego lite.app', 'Contents', 'MacOS', 'ego'),
  ];
}

/** ego lite 的 User Data 根目录候选（mac 上按 Application Support 约定；未真机验证）。 */
export function egoUserDataDirs() {
  const home = process.env.HOME || os.homedir();
  const appSupport = posix.join(home, 'Library', 'Application Support');
  return [
    posix.join(appSupport, 'Citro Labs', 'ego lite', 'User Data'),
    posix.join(appSupport, 'ego lite', 'User Data'),
  ];
}

export function pathSeparator() {
  return PATH_SEP;
}

export function egoSupported() {
  return true;
}

/** 目录是否在系统目录里（`updateDir` 校验用）。 */
export function systemDirs() {
  return ['/Applications', '/System', '/Library', '/usr', '/bin', '/sbin'];
}

export function browserSpawnOptions() {
  return { detached: true, stdio: 'ignore' };
}

/** 给自检用：导出内部函数，便于在非 mac 机器上验证路径/解析逻辑。 */
export const __internals = { serviceFor, userDataDirOf, normDir, psSnapshot };
