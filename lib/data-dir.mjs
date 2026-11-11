/**
 * data-dir.mjs —— 数据目录的展示与迁移（v0.20.17）。
 *
 * 插件的数据（账号表、设置、密码库、采集记录、Chrome 档案）默认都在
 * `~/.dsh/shop-accounts`。这个模块负责：
 *
 *   - 告诉界面当前用的是哪个目录、默认目录是哪个、是不是环境变量指过来的；
 *   - 把「配置 + 采集数据」搬到新目录，再把指针文件指过去（重启后生效）。
 *
 * 刻意不默认搬浏览器档案（`profiles/` 可能有几个 GB）：那部分留在旧目录，
 * 账号表里的档案路径仍然指向旧位置，打开店铺照样能用。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDir,
  defaultDataDir,
  ensureDir,
  readDataDirPointer,
  setDataDirPointer,
} from './store.mjs';

/** 会被搬过去的东西（目录或文件）；`profiles/` 与 `*.log` 不在其中。 */
export const MIGRATE_ENTRIES = [
  'accounts.json',
  'config.json',
  'account-secrets.enc',
  'session-cookie.key',
  'runtime.json',
  'collection',
  'monitor',
  'client-errors.log',
];

/** 浏览器档案目录名（只有显式要求才搬）。 */
export const PROFILE_ENTRY = 'profiles';

export function dataDirInfo() {
  const current = dataDir();
  return {
    dir: current,
    default: defaultDataDir(),
    pointer: readDataDirPointer(),
    envOverride: Boolean(process.env.DSH_SHOP_ACCOUNTS_DIR && process.env.DSH_SHOP_ACCOUNTS_DIR.trim()),
    entries: MIGRATE_ENTRIES.slice(),
  };
}

function samePath(a, b) {
  const norm = (v) => path.resolve(String(v || '')).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 切换 / 迁移数据目录。
 *
 * @param {string} nextDir 绝对路径
 * @param {{ migrate?: boolean, includeProfiles?: boolean }} opts
 *   migrate=false 只改指针（新目录留空，插件重启后从零开始）；
 *   migrate=true 先把配置与采集数据复制过去（已存在的同名项跳过，不覆盖）。
 */
export function changeDataDir(nextDir, opts = {}) {
  const raw = String(nextDir || '').trim();
  if (!raw) throw new Error('请填一个目录');
  if (!path.isAbsolute(raw)) throw new Error('请填绝对路径（例如 D:\\shop-accounts）');
  const from = dataDir();
  const to = path.resolve(raw);
  if (samePath(from, to)) throw new Error('新目录和当前数据目录一样');

  ensureDir(to);
  const copied = [];
  const skipped = [];
  let bytes = 0;

  if (opts.migrate) {
    const entries = opts.includeProfiles ? MIGRATE_ENTRIES.concat([PROFILE_ENTRY]) : MIGRATE_ENTRIES;
    for (const name of entries) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) { skipped.push(name); continue; }
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
        bytes += dirBytes(dst);
      } else {
        fs.copyFileSync(src, dst);
        bytes += st.size;
      }
      copied.push(name);
    }
  }

  setDataDirPointer(to);

  return {
    ok: true,
    from: from,
    to: to,
    copied: copied,
    skipped: skipped,
    bytes: bytes,
    note: '数据目录已切换，重启 DSH Desktop 后生效。',
  };
}

function dirBytes(dir) {
  let total = 0;
  try {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else {
          try { total += fs.statSync(p).size; } catch { /* 跳过读不到的 */ }
        }
      }
    }
  } catch { /* 目录读不到就当 0 */ }
  return total;
}
