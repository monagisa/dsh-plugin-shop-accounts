

/**
 * 把一次检测结果变成要写回账号的 patch。
 *
 * **检测失败（ok:false）不覆盖上一次的结论**：ego 没在跑、CLI 超时、无头 Chrome 起不来都会返回
 * `ok:false, loggedIn:false`，直接写进 lastCheck 会让界面把「这次没测成」显示成「登录已失效」，
 * 真实登录态被一次偶发失败抹掉，用户被迫重扫码（v0.8.1 修）。失败只记 lastCheckError。
 */
export function checkPatch(check, at = new Date().toISOString()) {
  if (check && check.ok === false) {
    return { lastCheckAt: at, lastCheckError: String(check.reason || check.error || '检测失败') };
  }
  return {
    lastCheck: check,
    lastCheckAt: at,
    lastCheckError: '',
    ...(check && check.loggedIn ? { lastLoginAt: at } : {}),
  };
}
