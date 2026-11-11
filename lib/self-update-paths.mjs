// 自更新的路径与运行文件校验（P1 拆分：从 lib/index.js 搬出，行为不变）。
import fs from 'node:fs';
import path from 'node:path';
import * as osPlatform from './platform/index.mjs';

export function normalizeExePath(value, kind) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const label = kind === 'ego' ? 'ego 程序' : '浏览器';
  if (!path.isAbsolute(s)) throw new Error(label + '路径必须是绝对路径：' + s);
  if (!fs.existsSync(s)) throw new Error(label + '路径不存在：' + s);
  const base = path.basename(s).toLowerCase();
  const ok = kind === 'ego'
    ? osPlatform.isEgoExecutable(base)
    : osPlatform.isBrowserExecutable(base);
  if (!ok) {
    // v0.20.10：有人把 ego lite 的 ego.exe 填进「浏览器路径」，要给出确切的做法而不是只说文件名不对。
    if (kind !== 'ego' && osPlatform.isEgoExecutable(base)) {
      throw new Error('ego lite 不用填「浏览器路径」：把「浏览器后端」切成 ego lite 就行（这个路径只给 Chrome 后端用）');
    }
    throw new Error('这个文件名不在可用的' + label + '名单里：' + base);
  }
  return s;
}

/**
 * 更新源目录的校验：必须是绝对路径、存在、是 git 仓库，且**仓库根 package.json 的 name 是本插件**。
 * 不加这条，`updateDir` 指向任意仓库时 `applyUpdate()` 会把它的 `lib/` 覆盖进插件安装目录
 * （只要版本号比当前大），等于任意代码执行（2026-10-31 二次审查）。
 */
export function validateUpdateDir(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (!path.isAbsolute(raw)) throw new Error('更新源目录必须是绝对路径：' + raw);
  const abs = path.resolve(raw);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('更新源目录不存在：' + abs); }
  if (!st.isDirectory()) throw new Error('更新源目录不是文件夹：' + abs);
  if (!fs.existsSync(path.join(abs, '.git'))) throw new Error('更新源目录不是 git 仓库：' + abs);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')); } catch {
    throw new Error('更新源目录里读不到 package.json：' + abs);
  }
  if (String(pkg && pkg.name) !== 'dsh-plugin-shop-accounts') {
    throw new Error('更新源目录不是本插件的仓库（package.json name=' + String(pkg && pkg.name) + '）：' + abs);
  }
  // Windows 路径大小写不敏感；macOS 大小写敏感卷上大小写是有意义的，不能先折成小写再比
  const fold = osPlatform.id === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const norm = (p) => fold(String(p || '').replace(/[\\/]+$/, ''));
  const sysDirs = osPlatform.systemDirs().filter(Boolean).map(norm);
  if (sysDirs.some((d) => norm(abs) === d || norm(abs).startsWith(d + path.sep))) {
    throw new Error('更新源目录不能放在系统/程序目录里：' + abs);
  }
  return abs;
}

