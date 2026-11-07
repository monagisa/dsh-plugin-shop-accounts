// 请求来源校验（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 只认本插件界面打过来的请求：宿主 renderer token 是第一道，这里是插件自己的第二道。
import os from 'node:os';
import { REQ_HEADER } from './plugin-consts.mjs';

export function hostHeaderAllowed(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return false;
  let host = raw;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return false;
    host = raw.slice(0, close + 1);
  } else {
    const last = raw.lastIndexOf(':');
    if (last >= 0 && /^\d+$/.test(raw.slice(last + 1))) host = raw.slice(0, last);
  }
  host = host.replace(/\.$/, '');
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){0,3}$/.test(host)) return true;
  if (/^\[[0-9a-f:.%a-z0-9]+\]$/i.test(host)) return true;
  const me = String(os.hostname() || '').toLowerCase();
  if (me && (host === me || host === me + '.local' || host === me + '.lan')) return true;
  return false;
}
/**
 * 可执行文件路径的写入校验：必须是绝对路径、存在，且文件名要在已知程序名里。
 * 这些路径会被 `spawn`，虽然"用户自己选 Chrome/ego 路径"是功能，但不该允许指向任意 exe
 * （`chrome-evil.exe` / `not-ego.exe` 这种前缀/子串骗法也要挡掉）。
 */
