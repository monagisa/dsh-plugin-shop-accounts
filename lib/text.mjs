// 文本与脱敏小工具（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 这一层只做字符串处理，不依赖任何业务状态，可以单独测。

/**
 * 把错误文本里的凭据打码：git 的 stderr 会把远端 URL 原样带出来，
 * 而 `https://user:TOKEN@github.com/...` 这种 URL 一旦进界面/日志就是一次泄露。
 */
export function maskSecrets(text) {
  return String(text == null ? '' : text)
    // URL 里的 user:password@
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
    // 只有 userinfo、没有冒号的（https://<token>@host）
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    // Authorization: Bearer xxx
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    // query 里的 token / key / secret / password
    .replace(/([?&](?:access_token|refresh_token|token|api[_-]?key|apikey|secret|password|sig|signature)=)[^&\s"']+/gi, '$1***')
    // 常见 token 形状
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})\b/g, '***');
}

/** 字符串字段的统一限长（防止有人往账号表里塞几十 KB 的字段把 /state 撑爆）。 */
export function capStr(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}
