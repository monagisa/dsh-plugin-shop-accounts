/**
 * store.mjs —— 账号档案的持久化（零依赖，两个 JSON 文件，全部原子写）。
 *
 *   <数据目录>/config.json    —— 插件级设置（浏览器路径、档案根目录、起始端口）
 *   <数据目录>/accounts.json  —— 账号列表（每个账号一条：平台、名字、档案目录、端口、登录状态）
 *
 * 数据目录默认 `~/.dsh/shop-accounts`，`DSH_SHOP_ACCOUNTS_DIR` 可整体搬走
 * （自检脚本用它把测试数据圈进临时目录，绝不碰用户真实的账号表）。
 *
 * 原子写 = 先写同目录的 `.tmp-<pid>-<rand>`，再 `rename` 覆盖：
 * Windows 的 rename 对已存在目标也能原子替换（本插件不做跨卷移动，同目录必然同卷）。
 * 直接 `writeFileSync(target)` 在写一半时断掉会留下半个 JSON，而这份文件装的是
 * 用户所有店铺的登录档案索引 —— 坏一次的代价是"账号全没了"，这个代价不值得省。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDir() {
  const override = process.env.DSH_SHOP_ACCOUNTS_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'shop-accounts');
}

export function configPath() { return path.join(dataDir(), 'config.json'); }
export function accountsPath() { return path.join(dataDir(), 'accounts.json'); }

export function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 / 并发建 */ }
  return dir;
}

export function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 读 JSON；文件不存在 / 坏掉都返回 fallback（并在返回值里带上 .__error 供诊断，不抛）。 */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return parsed;
  } catch (err) {
    const f = fallback && typeof fallback === 'object' ? { ...fallback } : {};
    f.__error = `${file} 读取失败：${err && err.message ? err.message : String(err)}（已按默认值继续）`;
    return f;
  }
}

// ── 插件设置 ────────────────────────────────────────────────────────────────

export function defaultConfig() {
  return {
    /** 留空 = 自动探测（Chrome → Edge，见 chrome.mjs） */
    browserPath: '',
    /** 留空 = <数据目录>/profiles */
    profileRoot: '',
    /** 自动分配端口从这里往上找 */
    portBase: 9222,
    /** 打开账号时是否顺手把「发品/商品列表」页也开一个标签（false = 只开一个首页） */
    openWorkTab: false,
    /** 关窗时是否等 Chrome 自己退出（false = CDP 关不掉就直接强杀） */
    gracefulClose: true,
  };
}

export function readConfig() {
  const cfg = { ...defaultConfig(), ...readJson(configPath(), {}) };
  if (typeof cfg.portBase !== 'number' || !(cfg.portBase >= 1 && cfg.portBase <= 65535)) cfg.portBase = 9222;
  return cfg;
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...(patch || {}) };
  delete next.__error;
  atomicWriteJson(configPath(), next);
  return next;
}

// ── 账号 ────────────────────────────────────────────────────────────────────

export function readAccounts() {
  const data = readJson(accountsPath(), { version: 1, accounts: [] });
  const list = Array.isArray(data.accounts) ? data.accounts : [];
  // 只留下形状正确的条目：坏一条不该让整张表打不开
  const accounts = list.filter((a) => a && typeof a.id === 'string' && typeof a.platform === 'string');
  return { accounts, error: data.__error || null, path: accountsPath() };
}

export function writeAccounts(accounts) {
  atomicWriteJson(accountsPath(), { version: 1, updatedAt: new Date().toISOString(), accounts });
  return accounts;
}

// ── 运行期登记表（我们自己起的浏览器：哪个账号在哪个端口、用哪份档案） ─────────────
//
// 存在的意义：判断"这个端口上那只 Chrome 是不是这个账号的"。CDP 自己不肯说
// （Browser.getBrowserCommandLine 要 --enable-automation，而那个开关会把 navigator.webdriver
// 暴露给登录站点），所以自己起了就自己记着；记不上再退到进程命令行查询兜底。

export function runtimePath() { return path.join(dataDir(), 'runtime.json'); }

/** 读登记表：坏文件退化成空表，绝不抛。 */
export function readRuntime() {
  const data = readJson(runtimePath(), { version: 1, entries: {} });
  const entries = data && typeof data.entries === 'object' && data.entries ? data.entries : {};
  return entries;
}

/** 记下/清掉一个账号的运行期信息（entry 传 null 就是清掉）。 */
export function setRuntime(accountId, entry) {
  const id = String(accountId || '').trim();
  if (!id) return readRuntime();
  const entries = readRuntime();
  if (entry === null || entry === undefined) delete entries[id];
  else entries[id] = { ...entry, at: new Date().toISOString() };
  atomicWriteJson(runtimePath(), { version: 1, updatedAt: new Date().toISOString(), entries });
  return entries;
}

/** 档案根目录：配置优先，否则 <数据目录>/profiles。 */
export function profileRoot(cfg) {
  const c = cfg || readConfig();
  if (c.profileRoot && String(c.profileRoot).trim()) return path.resolve(String(c.profileRoot).trim());
  return path.join(dataDir(), 'profiles');
}

/**
 * 新建账号的档案目录。用 id 而不是店铺名当目录名：
 * 店铺名允许重复、允许中文、允许带 `\` 和 `:`，直接当路径会出各种 Windows 事故。
 */
export function profileDirFor(accountId, cfg) {
  return path.join(profileRoot(cfg), accountId);
}

export function newAccountId(platform) {
  return `acc_${String(platform || 'x').replace(/[^a-z0-9]/gi, '')}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
