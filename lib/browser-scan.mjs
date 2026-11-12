// ── 浏览器扫描（v0.20.3）─────────────────────────────────────────────────────
// 目的：设置页里不再只让用户手填一个路径，而是「扫一遍这台机器上能用的浏览器」，
// 列出名字、版本、路径，并标出当前用的是哪一个（照系统设置里「用户浏览器」那块的做法）。
// 只扫 Chromium 内核的桌面浏览器：插件用 CDP 起浏览器，只有它们能开调试端口。
// v0.20.24 起扫描结果里包含 Microsoft Edge（与 Chrome 同内核，启动参数与 CDP 面一致）。
//
// 路径字面量全部在平台层（`lib/platform/*` 的 `browserScanTargets()`）：这里只管遍历：
//   · `bases`：安装目录（如 Windows 的 `.../Google/Chrome/Application`），里面按版本子目录找主程序；
//   · `files`：直接给主程序路径（macOS 的 app bundle 就属于这种）。
// 版本优先从路径段 `Application/<版本>/` 推断（不起进程、不读 PE 头）；取不到就用目录里最大版本目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as osPlatform from './platform/index.mjs';
import { resolveBrowserPath } from './chrome.mjs';

/** 版本号路径段：以「整数.整数」开头（157.0.8103.38 / 89.0.4389.90 都命中）。 */
const VERSION_SEG = /^\d+\.\d+/;

/** 系统平台的展示名（界面那行「系统环境」用）。 */
export function osLabel(platformId) {
  const map = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  return map[String(platformId || '')] || String(platformId || '未知系统');
}

/** 从可执行路径里取版本号（取不到就空串）。 */
export function versionFromPath(exePath) {
  const segs = String(exePath || '').split(/[\\/]+/).filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i -= 1) {
    if (VERSION_SEG.test(segs[i])) return segs[i];
  }
  return '';
}

/** 版本号比较：大的在前。 */
function cmpVersionDesc(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 路径是不是同一个（Windows 不区分大小写、斜杠两种写法都认）。 */
export function samePath(a, b) {
  const norm = (v) => String(v || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (!norm(a) || !norm(b)) return false;
  return norm(a) === norm(b);
}

/** 某个安装目录下所有存在的主程序（带从目录名推断的版本）。 */
function exesUnder(base, exe, probe) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && VERSION_SEG.test(d.name))
      .map((d) => d.name);
  } catch { /* 目录不存在/没权限：当成没装 */ }
  dirs.sort(cmpVersionDesc);
  for (const d of dirs) {
    const p = path.join(base, d, exe);
    if (probe(p)) out.push({ path: p, version: d });
  }
  const direct = path.join(base, exe);
  if (probe(direct)) out.push({ path: direct, version: dirs[0] || '' });
  return out;
}

/**
 * v0.20.6：主程序就躺在安装根目录里（如 ego lite 的 `Application/ego.exe`）时，
 * 路径段里没有版本号 —— 退一步看同目录下有没有 `Application/<版本>/` 这种版本目录，
 * 取最大的那个当版本（ego lite 0.6.2.8 就是这么来的）。
 */
export function dirVersionOf(exePath) {
  const dir = path.dirname(String(exePath || ''));
  let dirs = [];
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && VERSION_SEG.test(d.name))
      .map((d) => d.name);
  } catch { return ''; }
  dirs.sort(cmpVersionDesc);
  return dirs[0] || '';
}

/**
 * 扫这台机器上能用的浏览器。
 *
 * @param cfg       当前配置（读 `browserPath` / `browser`，用来标「使用中」）
 * @param opts      `{ targets, probe, entries, resolved }`：`targets`/`entries` 仅测试用。
 * @returns {{ok, os:{platform,label,release,arch}, browsers, selected, selectedPath, selectedFound, backend, scannedAt}}
 */
export function scanBrowsers(cfg = {}, opts = {}) {
  const probe = typeof opts.probe === 'function' ? opts.probe : (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const configured = String(cfg.browserPath || '').trim();
  // 「使用中」看的是**实际会用**的那个：配置为空时 resolveBrowserPath 会按候选顺序回退（Chrome → Edge）。
  let effective = configured;
  if (!effective) {
    try { effective = String((typeof opts.resolved === 'string' ? opts.resolved : resolveBrowserPath('')) || ''); } catch { effective = ''; }
  }

  const found = [];
  const push = (entry) => {
    const id = String(entry.id || 'chrome');
    const existing = found.find((f) => f.id === id);
    if (!existing) { found.push(entry); return; }
    // 同一个浏览器装了多份/多版本：留版本最高、带版本号的那份；
    // 版本一样（同一版本既有启动器又有版本目录里的主程序）时，留「实际会用的那个」，
    // 否则界面标不出「使用中」。
    const cmp = cmpVersionDesc(entry.version, existing.version);
    if (cmp < 0) Object.assign(existing, entry);
    else if (cmp === 0 && samePath(entry.path, effective)) Object.assign(existing, entry);
  };

  if (Array.isArray(opts.entries)) {
    for (const e of opts.entries) {
      if (!e || !e.path) continue;
      push({ id: String(e.id || 'chrome'), name: String(e.name || e.id || 'Chrome'), product: String(e.product || ''), path: String(e.path), version: String(e.version || versionFromPath(e.path)) });
    }
  } else {
    const targets = Array.isArray(opts.targets) ? opts.targets : osPlatform.browserScanTargets();
    for (const t of targets) {
      for (const base of t.bases || []) {
        for (const { path: exePath, version } of exesUnder(base, t.exe, probe)) {
          push({ id: t.id, name: t.name, product: t.product, path: exePath, version });
        }
      }
      for (const f of t.files || []) {
        // v0.20.6：路径里取不到版本时，看同目录下的版本子目录（ego lite 的版本号在这里）。
        if (probe(f)) push({ id: t.id, name: t.name, product: t.product, path: f, version: versionFromPath(f) || dirVersionOf(f) });
      }
    }
  }

  // 顺序固定：Google Chrome → Microsoft Edge → ego lite（前两个是 Chromium 浏览器，最后一个是 ego 后端）。
  const RANK = { chrome: 0, edge: 1, egolite: 2 };
  found.sort((a, b) => (RANK[a.id] === undefined ? 9 : RANK[a.id]) - (RANK[b.id] === undefined ? 9 : RANK[b.id])
    || String(a.name).localeCompare(String(b.name)));
  // 「使用中」：后端是 ego lite 时只有 ego lite 在用；否则看 Chrome 那边实际会用的路径。
  const backendId = String(cfg.browser || 'auto');
  const browsers = found.map((b) => ({
    id: b.id,
    name: b.name,
    path: b.path,
    version: b.version,
    product: b.product || '',
    chosen: b.id === 'egolite'
      ? backendId === 'egolite'
      : backendId !== 'egolite' && samePath(b.path, effective),
  }));

  return {
    ok: true,
    os: { platform: os.platform(), label: osLabel(os.platform()), release: os.release(), arch: os.arch() },
    browsers,
    selected: configured,
    selectedPath: effective,
    selectedFound: browsers.some((b) => b.chosen),
    backend: backendId,
    scannedAt: new Date().toISOString(),
  };
}
