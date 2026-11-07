// 诊断日志（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 两件事：关键动作的时间线（<数据目录>/debug.log）与客户端异常留档（client-errors.log）。
// 只是诊断，写不进去也绝不影响业务。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDir } from './store.mjs';
import { capStr } from './text.mjs';
import { PLUGIN } from './plugin-consts.mjs';

// ── 真机诊断日志 ─────────────────────────────────────────────────────────────
// 客户端的坑越来越依赖「当时现场」：千牛那次就是「登录→打开工作台→关窗→检测」四步里
// 某一步把身份 cookie 弄丢了，靠聊天问不出来。所以每个关键动作都把当时的 URL + 关键 cookie
// （只记名字/域/到期，**不记值**）追加到 <数据目录>/debug.log，出问题时直接看这条时间线。
// 纯诊断，写不进去也绝不影响业务。
export const DEBUG_LOG_MAX = 512 * 1024;

export function appendDebug(tag, payload) {
  try {
    const file = path.join(dataDir(), 'debug.log');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 还没有日志 */ }
    if (size > DEBUG_LOG_MAX) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), tag, ...payload }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 抓这个账号端口上「跟登录有关的那几个 cookie」的快照（值不落盘）。 */

// ── 日志 ────────────────────────────────────────────────────────────────────

export function makeLog(ctx) {
  let logger = null;
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger(PLUGIN) : ctx.logger;
  } catch { /* 宿主没给 logger 也不影响功能 */ }
  const write = (level, text) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level]('[shop-accounts] ' + text);
      else if (level === 'error') console.error('[shop-accounts] ' + text);
    } catch { /* 日志失败不许影响业务 */ }
  };
  return {
    info: (t) => write('info', t),
    warn: (t) => write('warn', t),
    error: (t) => write('error', t),
  };
}

// ── 客户端报错落盘（v0.17.9）────────────────────────────────────────────────
//
// 客户端半月在渲染进程里跑，它的 console.error / 未捕获异常进不了宿主日志；
// 而设置页的条目一旦抛异常，宿主会用 SlotErrorBoundary 兜住并渲染一个空 div ——
// 界面上只剩一片空白，看不出原因。所以页面侧把异常 POST 回来，这里落成文本。
//
// 只保留最近 N 条、每条一行，避免被刷爆：客户端本身有去重（同一条只报一次）。

export const CLIENT_ERROR_LOG = 'client-errors.log';
export const CLIENT_ERROR_KEEP = 200;

export function clientErrorPath() {
  return path.join(dataDir(), CLIENT_ERROR_LOG);
}

export function recordClientError(input) {
  try {
    const at = new Date().toISOString();
    const source = capStr(String((input && input.source) || 'client'), 64);
    const message = capStr(String((input && input.message) || ''), 400);
    const stack = capStr(String((input && input.stack) || ''), 4000);
    const where = capStr(String((input && input.where) || ''), 200);
    if (!message && !stack) return '';
    const line = JSON.stringify({ at, source, where, message, stack });
    const file = clientErrorPath();
    ensureDir(dataDir());
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 还没有文件 */ }
    const lines = prev.split('\n').filter(Boolean);
    lines.push(line);
    while (lines.length > CLIENT_ERROR_KEEP) lines.shift();
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return line;
  } catch {
    return '';
  }
}

export function readClientErrors(limit = 50) {
  try {
    const file = clientErrorPath();
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean).slice(-Math.max(1, limit));
    return lines.map((line) => {
      try { return JSON.parse(line); } catch { return { message: line }; }
    });
  } catch {
    return [];
  }
}

