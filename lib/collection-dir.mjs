/**
 * collection-dir.mjs —— 采集数据目录的命名与定位（v0.20.65）。
 *
 * 以前采集数据直接落在 `collection/<账号id>/`（形如 acc_taobao_mw05dt23d7jw），
 * 站在文件管理器里看不出是哪家店；现在目录名用「店名_平台_账号尾号」：
 *
 *   collection/示例店铺_taobao_23d7jw/
 *
 * 兼容：老目录（`collection/<账号id>/`）仍然可读可写，不会被自动搬动；
 * 目录里写一份 `.account.json` 记录归属账号，resolver 靠它反查。
 * 想统一改名用 `tools/migrate-collection-dirs.mjs`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, dataDir, ensureDir } from './store.mjs';
import { shopNameSafe } from './dsl-names.mjs';

const MARKER = '.account.json';

/** 账号 id 的末 6 位（只保留字母数字，够区分又不长）。 */
export function accountDirTag(accountId) {
  const s = String(accountId || '').replace(/[^a-z0-9]/gi, '');
  return (s.slice(-6) || 'shop').toLowerCase();
}

/** 采集数据目录名：`<店名>_<平台>_<尾号>`；店名缺失时用「店铺」。 */
export function collectionDirName(account) {
  const name = shopNameSafe((account && account.name) || '', 20) || '店铺';
  const platformRaw = String((account && account.platform) || '').trim();
  const platform = platformRaw.replace(/[^a-z0-9]/gi, '') || 'shop';
  return `${name}_${platform}_${accountDirTag(account && account.id)}`;
}

/** collection 根目录。 */
export function collectionRoot() {
  return path.join(dataDir(), 'collection');
}

/** 读目录里的归属标记（老目录没有标记就返回空串）。 */
function readMarker(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return String((raw && raw.accountId) || '').trim();
  } catch {
    return '';
  }
}

/** 直接读 accounts.json（避免 import accounts.mjs 造成循环依赖）。 */
function readAccountsFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir(), 'accounts.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.accounts) ? raw.accounts : []);
    return list.filter((a) => a && String(a.id || '').trim());
  } catch {
    return [];
  }
}

/** 在 collection 下按标记反查账号目录。 */
function findDirByMarker(accountId) {
  const root = collectionRoot();
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return '';
  }
  for (const name of names) {
    const dir = path.join(root, name);
    const owner = readMarker(dir);
    if (owner && owner === accountId) return dir;
  }
  return '';
}

/**
 * 解析某个账号的采集数据目录（不创建）。
 * 优先级：已有可读目录 → 已有老目录（`<账号id>`）→ 新的可读目录（尚未创建）。
 * @param {string|object} accountOrId
 * @param {object[]} [accounts] 已知账号列表（避免再读一次 accounts.json）
 * @returns {string}
 */
export function collectionDirOf(accountOrId, accounts) {
  const root = collectionRoot();
  let account = (accountOrId && typeof accountOrId === 'object') ? accountOrId : null;
  const accountId = String((account ? account.id : accountOrId) || '').trim();
  if (!accountId) throw new Error('账号 id 不合法：(空)');

  if (!account) {
    const list = Array.isArray(accounts) ? accounts : readAccountsFromDisk();
    account = list.find((a) => String(a.id || '').trim() === accountId) || null;
  }

  if (account) {
    const readable = path.join(root, collectionDirName(account));
    if (fs.existsSync(readable)) return readable;
  } else {
    const byMarker = findDirByMarker(accountId);
    if (byMarker) return byMarker;
  }

  const legacy = path.join(root, accountId);
  if (fs.existsSync(legacy)) {
    // 老目录优先继续用，避免同一账号的历史数据分裂成两份
    try { ensureCollectionMarker(legacy, accountId); } catch { /* 标记写不进去不影响使用 */ }
    return legacy;
  }

  if (account) return path.join(root, collectionDirName(account));

  // 没有账号对象、也没有老目录：按 id 退化成老命名（仅造目录场景，极少发生）
  return legacy;
}

/** 确保目录存在，并写好归属标记（幂等）。 */
export function ensureCollectionDir(accountOrId, accounts) {
  const dir = collectionDirOf(accountOrId, accounts);
  ensureDir(dir);
  ensureCollectionMarker(dir, String((accountOrId && accountOrId.id) || accountOrId || '').trim());
  return dir;
}

/** 目录的归属标记（只在缺失或内容不同时重写）。 */
export function ensureCollectionMarker(dir, accountId) {
  const id = String(accountId || '').trim();
  if (!id) return;
  const file = path.join(dir, MARKER);
  try {
    const current = readMarker(dir);
    if (current === id) return;
  } catch { /* fallthrough */ }
  atomicWriteJson(file, { version: 1, accountId: id });
}
