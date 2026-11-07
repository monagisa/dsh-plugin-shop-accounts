// HTTP 小工具（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 只处理「把 JSON 发出去 / 把一个 JSON 请求体读进来」这两件事。
import { BODY_LIMIT } from './plugin-consts.mjs';

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(body);
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    // 客户端中途断开（关面板 / 刷新页面 / 代理超时）时 Node 只发 aborted/close，不发 error ——
    // 不兜底的话这个 Promise 永远 pending：路由层拿着账号锁一直不释放，那个店铺后面所有动作都卡死（v0.8.1 修）。
    const bail = (why, status) => {
      if (done) return;
      done = true;
      const err = new Error(why);
      err.status = status || 400;
      reject(err);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        bail('请求体过大', 413);
        try { req.destroy(); } catch { /* 已经断了 */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        done = true;
        return resolve({});
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        bail('请求体不是合法 JSON：' + err.message, 400);
        return;
      }
      // 只收 JSON 对象：数组/字符串/null 会让下游 `body.xxx` 静默取到 undefined，
      // 变成"看着成功其实没改"的隐蔽状态。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        bail('请求体必须是 JSON 对象', 400);
        return;
      }
      done = true;
      resolve(parsed);
    });
    req.on('error', (err) => bail('读请求体出错：' + (err && err.message ? err.message : String(err)), 400));
    req.on('aborted', () => bail('请求被客户端中断', 400));
    req.on('close', () => bail('连接已关闭', 400));
  });
}
