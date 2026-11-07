import { readRuntime } from './store.mjs';
import { chromeOwnerOfPort } from './chrome.mjs';

/** 两个路径是不是同一个档案目录（Windows 大小写、斜杠、结尾分隔符都不敏感）。 */
export function samePath(a, b) {
  const norm = (s) => String(s || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const x = norm(a);
  return x !== '' && x === norm(b);
}

/**
 * 这个端口上的 Chrome 是不是这个账号的那只？返回 'mine' | 'other' | 'unknown'。
 *
 * 先查我们自己起浏览器时留下的登记表（快、准），查不到再去问进程命令行（慢一点但更权威）。
 * 两条都问不出来 = unknown。
 *
 * v0.8.3：以前 unknown 直接当 true（乐观放行）。那意味着「端口被别的程序占着」时，
 * 插件会去读它的 cookie、往它上面 setCookies、乃至 Browser.close 关掉它 —— 一律改成
 * 只有明确 'mine' 才读写；'unknown' 只在「挂个标签页」这种不发 cookie 的动作里放行。
 *
 * v0.8.4：登记表也**不是永久可信**了 —— 条目要有写入时间（8 小时内），pid > 0 时还要确认
 * 这个进程真的活着（崩溃/重启后端口可能已经被别人接手）。
 */
export const RUNTIME_TTL_MS = 8 * 60 * 60 * 1000;

export function runtimeEntryMine(account, port, dir) {
  const entry = readRuntime()[account.id];
  if (!entry || Number(entry.port) !== Number(port) || !samePath(entry.profileDir, dir)) return false;
  const at = Date.parse(String(entry.at || ''));
  if (!Number.isFinite(at) || Date.now() - at > RUNTIME_TTL_MS) return false;
  const pid = Number(entry.pid) || 0;
  // pid 为 0 的条目（"复用已有浏览器" / 无头探测）**没有存活凭据**：不能只凭登记表就认定是自己的，
  // 否则浏览器退出、端口被别人接手后，8 小时内还会把真 cookie setCookies 过去。
  // 这类条目一律退回 `chromeOwnerOfPort()` 问进程命令行，查不到就是 unknown（不读不写）。
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (err) {
    if (err && err.code === 'ESRCH') return false; // 进程没了
    // EPERM 等：进程还活着（只是不归我们管），继续按登记处理
  }
  return true;
}

export async function portOwnership(account, port, dir) {
  if (runtimeEntryMine(account, port, dir)) return 'mine';
  const owner = await chromeOwnerOfPort(port);
  if (!owner) return 'unknown';
  return samePath(owner, dir) ? 'mine' : 'other';
}

/** 只认明确属于自己的端口（读/写 cookie 之前必须过这一关）。 */
export async function ourBrowserOnPort(account, port, dir) {
  return (await portOwnership(account, port, dir)) === 'mine';
}

/**
 * 刚刚在"空闲端口"上 spawn 出来的浏览器，归属确认。
 * 进程命令行查得到 → 必须是这份档案；查不到（WMI 被组策略限制等）→ 接受（端口刚才是空的，
 * 这只就是我刚起的）。这样既不放过明确的冒名者，也不会在受限机器上把功能挡死。
 */
export async function verifyFreshLaunch(port, dir) {
  const owner = await chromeOwnerOfPort(port);
  if (!owner) return true;
  return samePath(owner, dir);
}
