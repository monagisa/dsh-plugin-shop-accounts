// 账号表、导入导出与档案目录（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 只用 store.mjs 提供的数据层原语，不碰浏览器与路由。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountsPath, configPath, dataDir, ensureDir, newAccountId, profileDirFor, readAccounts,
  readConfig, readRuntime, setRuntime, writeAccounts, writeConfig, isInsideProfileRoot,
  normalizeImportedProfileDir, validAccountId,
} from './store.mjs';
import { normalizeAccountType, platformOf } from './platforms.mjs';
import { normalizeCollection } from './collection.mjs';
import { ownVersion } from './self-update.mjs';
import { backendFor, normalizeEgoProfileId } from './ego.mjs';
import { capStr } from './text.mjs';
import { safeNavUrl } from './chrome.mjs';
import { allowedDomains } from './domains.mjs';

export function loadAccounts() { return readAccounts().accounts; }
export function saveAccounts(list) { return writeAccounts(list); }

export function findAccount(id) {
  // 账号 id 只可能是插件自己生成的形状；坏 id（含 `/`、`..` 之类）一律当"不存在"，
  // 不让它有机会参与后面的路径拼接。
  if (!validAccountId(id)) return null;
  return loadAccounts().find((a) => a.id === id) || null;
}

export function patchAccount(id, patch) {
  const list = loadAccounts();
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, id: list[i].id, updatedAt: new Date().toISOString() };
  saveAccounts(list);
  return list[i];
}

// ── 登录账号查重（v0.10.1）──────────────────────────────────────────────────
// 登录账号唯一性：同一个平台 + 同一个账号 = 同一个人，建两条只会让「代填哪个密码、采集算谁的」对不上。
// 比较前先做 NFC 归一化，
// 这里多折叠一次大小写 —— 手机号/邮箱大小写不同是同一个账号，正是最容易重复建号的情形。

export function loginNameKey(value) {
  return String(value == null ? '' : value).normalize('NFC').trim().toLowerCase();
}

/** 在给定列表里找同平台 + 同登录账号的记录（excludeId 用于编辑时排除自己）；空账号不参与查重。 */
export function findDuplicateInList(list, platform, loginName, excludeId) {
  const key = loginNameKey(loginName);
  if (!key) return null;
  return (list || []).find(
    (a) => a.id !== excludeId && a.platform === platform && loginNameKey(a.loginName) === key,
  ) || null;
}

export function findDuplicateLoginName(platform, loginName, excludeId) {
  return findDuplicateInList(loadAccounts(), platform, loginName, excludeId);
}

// ── 店铺配置导出 / 导入（v0.10.1）───────────────────────────────────────────
// 目的：换机器（尤其 Windows → mac）时不用一条条重填。**只搬配置，不搬秘密**：
// 密码永不出现在导出文件里（它在密码库/钥匙串里、且被本机密钥绑定，搬过去也解不开），
// 登录态（浏览器档案、cookie 罐）、端口、运行时状态同样不进包 —— 这些都是"这台机器上的东西"。

export const EXPORT_FORMAT = 'dsh-shop-accounts/stores';
export const EXPORT_VERSION = 1;
export const EXPORT_MAX_ACCOUNTS = 500;

export function exportStores() {
  const accounts = loadAccounts().map((a) => ({
    platform: a.platform,
    accountType: a.accountType || 'seller',
    name: String(a.name || '').trim(),
    url: String(a.url || '').trim(),
    loginName: String(a.loginName || '').trim(),
    note: String(a.note || ''),
    egoProfile: String(a.egoProfile || ''),
    collection: a.collection || null,
  }));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    pluginVersion: ownVersion(),
    count: accounts.length,
    // 明确写在文件里，免得以后有人以为"导出漏了密码"是 bug：
    note: '本文件只含店铺配置，不含密码与登录态；在新机器导入后请在每家的详情页重新设置密码。',
    accounts,
  };
}

/**
 * 导入店铺配置。逐条校验、能建就建、建不了就跳过并说明原因 —— 一次导入里有一条坏数据，
 * 不该把好的那些也一起废掉。
 * @returns {{imported:number, skipped:Array<{name:string,reason:string}>, accounts:Array<object>}}
 */
export function importStores(payload) {
  const raw = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.accounts) ? payload.accounts : null);
  if (!raw) throw new Error(`导入文件里没有 accounts 数组（应该是本插件「导出店铺配置」生成的 ${EXPORT_FORMAT} 文件）`);
  if (raw.length > EXPORT_MAX_ACCOUNTS) throw new Error(`一次最多导入 ${EXPORT_MAX_ACCOUNTS} 条，这个文件里有 ${raw.length} 条`);

  const cfg = readConfig();
  const egoMode = backendFor(cfg) === 'egolite';
  const next = loadAccounts().slice();
  const imported = [];
  const skipped = [];

  for (const item of raw) {
    const obj = item && typeof item === 'object' ? item : {};
    const platform = platformOf(String(obj.platform || ''));
    const loginName = String(obj.loginName || '').trim();
    const label = capStr(String(obj.name || '').trim(), 80) || loginName || '(未命名)';
    if (!platform) {
      skipped.push({ name: label, reason: `平台「${String(obj.platform || '')}」不认识` });
      continue;
    }
    if (!loginName) {
      skipped.push({ name: label, reason: '缺登录账号（导出文件里 loginName 为空，无法对应到人）' });
      continue;
    }
    if (findDuplicateInList(next, platform.id, loginName, '')) {
      skipped.push({ name: label, reason: `${platform.label} 上已有同一登录账号「${loginName}」的记录` });
      continue;
    }
    let collection = null;
    try { collection = normalizeCollection(obj.collection || {}, {}, { allow: allowedDomains(platform.id) }); } catch { collection = { enabled: false, domains: [], time: '09:00' }; }
    // URL 走同一个白名单（只收 http/https）：导入的文件是外部输入，不能直接进 Chrome 命令行。
    let url = '';
    try { url = String(obj.url || '').trim() ? safeNavUrl(obj.url) : ''; } catch { url = ''; }
    let egoProfile = '';
    try { egoProfile = normalizeEgoProfileId(obj.egoProfile); } catch { egoProfile = ''; }

    let name = label;
    // ego 后端下店铺名就是 TaskSpace 名，重名会串台 —— 自动往后排号而不是整条丢掉。
    if (egoMode) {
      let seq = 2;
      const base = name;
      while (next.some((a) => String(a.name || '').trim() === name)) {
        name = `${base} (${seq})`;
        seq += 1;
        if (seq > 99) break;
      }
    }
    const id = newAccountId(platform.id);
    const account = {
      id,
      platform: platform.id,
      name,
      note: String(obj.note || '').trim(),
      url,
      loginName,
      accountType: normalizeAccountType(obj.accountType),
      collection,
      // 档案目录一律本机重新派生：导出包里的路径是另一台机器的，不能拿来做路径拼接。
      profileDir: profileDirFor(id, cfg),
      port: 0,
      egoProfile,
      egoSpace: '',
      imported: false,
      pendingLogin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastCheck: null,
      lastCheckAt: null,
      lastLoginAt: null,
    };
    next.push(account);
    imported.push({ id, name, platform: platform.id, platformLabel: platform.label, loginName });
  }

  if (imported.length) saveAccounts(next);
  return { imported: imported.length, skipped, accounts: imported };
}

/** 档案目录：优先用账号上记的（可能是"导入已有目录"），否则按 id 推。 */
export function accountProfileDir(account, cfg) {
  if (account && account.profileDir && String(account.profileDir).trim()) return String(account.profileDir);
  return profileDirFor(account.id, cfg);
}

/**
 * **可被递归删除**的档案目录：必须同时满足
 *   · 在档案根目录之内（`isInsideProfileRoot`，含 realpath 解 junction）；
 *   · 目录名正好是这个账号的 id（插件自己派生的形状 `<root>/<id>`）。
 *
 * 只判"在根目录下"不够：`profileRoot` 本身能被 `PUT /config` 改，攻击者把根设成
 * `C:\Users\<某人>` 就能删同级目录；加上"名字必须是账号 id"之后，可删的目标只剩
 * `profiles/acc_xxx` 这一种形状，误删/滥用都没有落脚点。
 */
export function deletableProfileDir(account, cfg) {
  if (!account || !account.id) return null;
  const dir = accountProfileDir(account, cfg);
  if (!isInsideProfileRoot(dir, cfg)) return null;
  let base = '';
  try { base = path.basename(path.resolve(dir)); } catch { return null; }
  if (base.toLowerCase() !== String(account.id).toLowerCase()) return null;
  return dir;
}

/**
 * 档案根目录的写入校验：必须是绝对路径，且不能是盘根/家目录/系统目录/程序目录。
 * 它是删除动作的信任锚之一，不能由接口随便指到危险位置（2026-10-31 二次审查）。
 */
export function normalizeProfileRoot(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (!path.isAbsolute(s)) throw new Error('档案根目录必须是绝对路径：' + s);
  const abs = path.resolve(s);
  const norm = (p) => String(p || '').toLowerCase().replace(/[\\/]+$/, '');
  const root = path.parse(abs).root;
  if (norm(abs) === norm(root)) throw new Error('档案根目录不能是盘符根目录：' + abs);
  // 用户主目录本身不行（但**主目录里面**可以：很多人把档案放在 ~/shop-profiles）
  if (norm(abs) === norm(os.homedir())) throw new Error('档案根目录不能是用户主目录：' + abs);
  // 系统/程序目录（含其子目录）不行：那里不该写浏览器档案
  const systemDirs = [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter(Boolean).map(norm);
  if (systemDirs.some((d) => norm(abs) === d || norm(abs).startsWith(d + '\\'))) {
    throw new Error('档案根目录不能放在系统/程序目录里：' + abs);
  }
  return abs;
}

/** 可选目录配置（如 ego User Data）：留空表示"自动探测"；非空必须是已存在的目录。 */
export function normalizeOptionalDir(value, label) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (!path.isAbsolute(s)) throw new Error(label + '必须是绝对路径：' + s);
  const abs = path.resolve(s);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(label + '不存在：' + abs); }
  if (!st.isDirectory()) throw new Error(label + '不是文件夹：' + abs);
  return abs;
}

/**
 * 反 DNS rebinding 用的 Host 白名单：只接受
 *   · localhost / localhost.；
 *   · IP 字面量（127.0.0.1、127.1、10.0.0.5、[::1]、[fe80::1%eth0]）；
 *   · 本机主机名（含 .local/.lan，方便用 `my-pc:43120` 打开）。
 * 域名（rebinding 后浏览器发来的 Host）一律不行。
 */
