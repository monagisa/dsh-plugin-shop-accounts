

// ── 每个店铺一把锁 ──────────────────────────────────────────────────────────
// 同一个店铺可能同时被「定时检测」和用户点「检测 / 打开 / 完成」撞上：两个 ego CLI 会同时对同一个
// 空间 takeOver / finish，轻则来回抢控制权，重则把用户正在用的窗口收掉。按账号串行化。
export const accountLocks = new Map();

export function accountBusy(id) { return accountLocks.has(String(id)); }

/**
 * 拿这把锁执行 fn。`wait:false` 时如果锁被占就立刻返回 `{ busy:true }`（定时检测用：
 * 宁可这一轮跳过，也不要排在用户手动操作后面把窗口再抢一遍）。
 */
export async function withAccountLock(id, fn, opts = {}) {
  const release = await acquireAccountLock(id, opts);
  if (!release) return { busy: true, skipped: true };
  try { return await fn(); } finally { release(); }
}

/**
 * 手动取锁（路由层用：一整个动作里有多个 return 点，用 try/finally 最省事）。
 * 锁被占时：`wait:false` 立刻返回 null；默认排队等前一个动作做完。
 */
export async function acquireAccountLock(id, opts = {}) {
  const key = String(id);
  // 循环抢：被占用就等它放，醒来后**重新检查**再抢。
  // （不能只 await 一次就往下走 —— 两个等待者会同时被唤醒，后一个必须在重新检查时看到前一个的锁。）
  for (;;) {
    const cur = accountLocks.get(key);
    if (!cur) break;
    if (opts.wait === false) return null;
    await cur.catch(() => {});
  }
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  accountLocks.set(key, gate);
  return () => {
    if (accountLocks.get(key) === gate) accountLocks.delete(key);
    release();
  };
}
