// 自更新（P1 拆分：从 lib/index.js 搬出，行为不变）。
// 检测 GitHub 上的新版本、一键拉取源码仓库并覆盖本插件安装目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskSecrets } from './text.mjs';
import { normalizeExePath, validateUpdateDir } from './self-update-paths.mjs';
import { readConfig } from './store.mjs';

// ── 自更新（检测 GitHub 上的新版本 / 一键拉取）────────────────────────────────
//
// 这个插件在 profile 里是**一份拷贝**（`node_modules/dsh-plugin-shop-accounts`），真正的
// 源码在别处一个 git 仓库里。所以「更新」= 在源码仓库 `git fetch` → 快进合并 →
// 把 lib/ package.json README.md test/ 覆盖到这份拷贝。
// 覆盖完必须重启宿主才生效：宿主启动时就把插件代码读进内存了，换文件不会热更新。

/** 本插件安装目录（含 package.json 的那一层）。 */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 某个安装目录里的版本号（默认 = 现在跑着的这份）。 */
export function versionOfDir(dir = PKG_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch { return ''; }
}

/** 当前跑着的这份代码的版本号。 */
export function ownVersion() { return versionOfDir(PKG_ROOT); }

/**
 * **本次启动真正加载进来的**版本号（模块加载那一刻记下来）。
 *
 * 为什么单独记一个：`ownVersion()` 每次读的是磁盘上的 package.json ——「更新到最新」把文件覆盖了、
 * 却没重启 DSH Desktop 的时候，它会显示新版本号，但内存里跑的还是旧代码。
 * 用户看到「版本已经是 0.6.7 了怎么还是老毛病」，就是被这个骗了（2026-10-19 千牛那次）。
 * 所以把加载时的版本固定下来，界面上一比就知道「文件更新了、但还没重启」。
 */
export const LOADED_VERSION = ownVersion();

/**
 * 跑一次 git（同步、带超时、绝不抛）。
 *
 * 加固项：
 *   · `GIT_TERMINAL_PROMPT=0`：凭据缺失时宁可失败也不要挂住；
 *   · `-c protocol.ext.allow=never`：禁掉 `ext::` 传输；
 *   · `-c core.fsmonitor=` / `-c core.sshCommand=ssh`：仓库自己的 `.git/config` 里
 *     这两个键会在 `status`/`fetch` 时执行命令 —— 更新源目录不可全信，一律覆盖成安全值；
 *   · 输出里的凭据打码（远端 URL 可能内嵌 token）。
 */
export function runGit(dir, args, timeoutMs = 30000) {
  try {
    const r = spawnSync('git', [
      '-c', 'protocol.ext.allow=never',
      '-c', 'core.fsmonitor=',
      '-c', 'core.sshCommand=ssh',
      '-c', 'core.hooksPath=',
      '-C', dir,
      ...args,
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return {
      ok: r.status === 0,
      out: maskSecrets(String(r.stdout || '').trim()),
      err: maskSecrets(String(r.stderr || '').trim() || (r.error ? String(r.error.message || r.error) : '')),
    };
  } catch (err) {
    return { ok: false, out: '', err: maskSecrets(err && err.message ? err.message : String(err)) };
  }
}

/**
 * 源码目录在哪：优先用设置里手填的；否则按「自己是不是 git 仓库」→「profile 的
 * `file:` / `link:` 依赖」两步猜。猜不到就返回 ''，让界面提示去填。
 */
export function detectUpdateDir() {
  const configured = String(readConfig().updateDir || '').trim();
  if (configured) {
    const abs = path.resolve(configured);
    // 更新源目录不可全信：它会被 `git` 读写、里面还有 `.git/config`。只接受绝对路径的目录。
    if (!path.isAbsolute(configured)) return '';
    return abs;
  }
  if (fs.existsSync(path.join(PKG_ROOT, '.git'))) return PKG_ROOT;
  try {
    const profileRoot = path.resolve(PKG_ROOT, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(profileRoot, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const m = /^(?:file|link):(.+)$/.exec(String(deps[name] || ''));
    if (m) {
      const dir = path.resolve(profileRoot, m[1]);
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    }
  } catch { /* 猜不到就交给用户填 */ }
  return '';
}

/** 比版本号（0.4.0 / 0.3.10 这种）；a>b 返回正数。 */
export function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 上游分支名（origin/main 之类）。 */
export function upstreamOf(dir) {
  const r = runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (r.ok && r.out) return r.out;
  const head = runGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out) return head.out;
  return 'origin/main';
}

/**
 * 查 GitHub 上有没有新版本（只 fetch + 比较，不动工作区）。
 * 返回 `{ ok, localVersion, remoteVersion, localHead, remoteHead, upstream, behind, upToDate, updateDir }`。
 */
export async function checkUpdate(opts = {}) {
  const target = path.resolve(opts.target || PKG_ROOT);
  const localVersion = versionOfDir(target);
  let dir;
  try {
    dir = opts.updateDir ? validateUpdateDir(opts.updateDir) : detectUpdateDir();
    if (dir) dir = validateUpdateDir(dir);
  } catch (err) {
    return { ok: false, localVersion, updateDir: '', error: String((err && err.message) || err) };
  }
  if (!dir) {
    return {
      ok: false,
      localVersion,
      updateDir: '',
      error: '找不到本插件的 git 源码目录 —— 在下面「更新源目录」里填一下（例如 D:\\plugins\\dsh-plugin-shop-accounts）',
    };
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { ok: false, localVersion, updateDir: dir, error: '更新源目录不是 git 仓库：' + dir };
  }
  const fetched = runGit(dir, ['fetch', '--prune', 'origin'], 45000);
  if (!fetched.ok) {
    return { ok: false, localVersion, updateDir: dir, error: 'git fetch 失败：' + (fetched.err || '未知原因') };
  }
  const upstream = upstreamOf(dir);
  const localHead = runGit(dir, ['rev-parse', '--short', 'HEAD']);
  const remoteHead = runGit(dir, ['rev-parse', '--short', upstream]);
  const behind = parseInt(runGit(dir, ['rev-list', '--count', `HEAD..${upstream}`]).out, 10) || 0;
  const ahead = parseInt(runGit(dir, ['rev-list', '--count', `${upstream}..HEAD`]).out, 10) || 0;
  const verOf = (ref) => {
    try { return String(JSON.parse(runGit(dir, ['show', `${ref}:package.json`]).out).version || ''); } catch { return ''; }
  };
  const sourceVersion = verOf('HEAD');
  const remoteVersion = verOf(upstream);
  // 「要不要更新」不能只看 git 落后几个提交：源码仓库可能领先 GitHub（本地已改未推），
  // 而真正跑着的是 profile 里那份**拷贝**（localVersion），它可能比源码还旧。
  const needsUpdate = behind > 0
    || cmpVersion(sourceVersion, localVersion) > 0
    || cmpVersion(remoteVersion, localVersion) > 0;
  return {
    ok: true,
    localVersion,
    sourceVersion,
    remoteVersion,
    localHead: localHead.out,
    remoteHead: remoteHead.out,
    upstream,
    behind,
    ahead,
    needsUpdate,
    upToDate: !needsUpdate,
    updateDir: dir,
  };
}

/**
 * 把源码目录里**已校验 commit** 的运行文件覆盖到目标目录。
 *
 * 为什么不再直接拷工作区（v0.8.3 修）：工作区可以被任何本机进程改脏，
 * 「更新」等于把未经验证的内容部署进插件目录（重启即执行）。
 * 现在先用 `git archive <ref>` 导出到一个临时目录，校验版本号与远端一致，再落盘。
 * 源码目录 == 目标时跳过。
 */
export function syncFromSource(dir, target = PKG_ROOT, opts = {}) {
  const dst = path.resolve(target);
  if (path.resolve(dir) === dst) return { copied: 0, target: dst, sameDir: true };
  const items = ['lib', 'test', 'package.json', 'README.md', 'CHANGELOG.md'];
  const ref = String(opts.ref || '').trim();
  const expectVersion = String(opts.expectVersion || '').trim();
  let srcRoot = dir;
  let stage = '';
  try {
    if (ref) {
      stage = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-sync-'));
      const tarball = path.join(stage, 'src.tar');
      const arch = runGit(dir, ['archive', '--format=tar', '-o', tarball, ref], 60000);
      if (!arch.ok) return { copied: 0, target: dst, sameDir: false, error: 'git archive 失败：' + (arch.err || '未知原因') };
      const ex = spawnSync('tar', ['-xf', tarball, '-C', stage], { windowsHide: true, timeout: 60000 });
      if (ex.status !== 0) {
        return { copied: 0, target: dst, sameDir: false, error: '解包 commit 内容失败：' + maskSecrets(String(ex.stderr || ex.error || '').trim()) };
      }
      srcRoot = stage;
      // 版本校验必须**无条件**成立：取不到版本（package.json 被删/没有 version）时不能"跳过校验照拷"，
      // 否则一个能改 commit 内容的人只要顺手删掉 package.json 就能绕过（2026-10-31 二次审查）。
      const stagedVersion = versionOfDir(stage);
      if (!expectVersion) {
        return { copied: 0, target: dst, sameDir: false, error: '上游 package.json 里没有 version，拒绝自动更新（无法校验版本）' };
      }
      if (!stagedVersion) {
        return { copied: 0, target: dst, sameDir: false, error: '这个 commit 里没有 package.json 的 version 字段，拒绝自动更新' };
      }
      if (stagedVersion !== expectVersion) {
        return {
          copied: 0, target: dst, sameDir: false,
          error: `commit 里的版本(${stagedVersion})和远端版本(${expectVersion})不一致，已中止（不覆盖工作目录）`,
        };
      }
    }
    let copied = 0;
    for (const item of items) {
      const src = path.join(srcRoot, item);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(dst, item), { recursive: true, force: true });
      copied += 1;
    }
    return { copied, target: dst, sameDir: false, sourceVersion: versionOfDir(srcRoot), fromCommit: Boolean(ref) };
  } catch (err) {
    return { copied: 0, target: dst, sameDir: false, error: maskSecrets(err && err.message ? err.message : String(err)) };
  } finally {
    if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 留给系统清理 */ } }
  }
}

/** 一键更新：快进合并 + 按已校验 commit 覆盖安装拷贝。返回最终状态（含 `updated` / `restartRequired`）。 */
export async function applyUpdate(opts = {}) {
  const target = path.resolve(opts.target || PKG_ROOT);
  const info = await checkUpdate(opts);
  if (!info.ok) return info;
  const dir = info.updateDir;
  if (!info.needsUpdate) {
    return { ...info, updated: false, copied: 0, restartRequired: false };
  }
  // 脏检查**无条件**做：以前只在 behind>0 时查，于是"源码已和远端同步但工作区被改过"会绕过检查，
  // 把未提交的内容当新版本部署（2026-10-31 安全审查）。
  const dirty = runGit(dir, ['status', '--porcelain']);
  if (!dirty.ok) return { ...info, ok: false, updated: false, error: '检查源码目录状态失败：' + (dirty.err || '未知原因') };
  if (dirty.out) {
    return { ...info, ok: false, updated: false, error: '源码目录里有未提交的改动，先处理干净再更新：' + dir };
  }
  let merged = false;
  if (info.behind > 0) {
    const m = runGit(dir, ['merge', '--ff-only', info.upstream], 60000);
    if (!m.ok) {
      return { ...info, ok: false, updated: false, error: '快进合并失败：' + (m.err || m.out || '未知原因') };
    }
    merged = true;
  }
  // 只部署「校验过的那个 commit」的内容，不碰工作区
  const pinned = runGit(dir, ['rev-parse', info.upstream]);
  if (!pinned.ok || !pinned.out) {
    return { ...info, ok: false, updated: false, error: '解析上游 commit 失败：' + (pinned.err || '未知原因') };
  }
  const synced = syncFromSource(dir, target, { ref: pinned.out, expectVersion: info.remoteVersion });
  if (synced.error) return { ...info, ok: false, updated: false, error: synced.error };
  // 拷贝已经把新的 package.json 落进安装目录了，重读才拿得到「更新后」的版本号；
  // 合并之后的 head/behind 也顺手重算，别把合并前的旧值回给界面。
  const afterVersion = versionOfDir(target);
  const afterHead = runGit(dir, ['rev-parse', '--short', 'HEAD']).out;
  const behindAfter = parseInt(runGit(dir, ['rev-list', '--count', `HEAD..${info.upstream}`]).out, 10) || 0;
  return {
    ...info,
    updated: true,
    merged,
    localHead: afterHead || info.localHead,
    behind: behindAfter,
    needsUpdate: false,
    upToDate: true,
    ...synced,
    localVersion: afterVersion || info.sourceVersion || info.localVersion,
    restartRequired: synced.copied > 0,
  };
}

// ── 账号表（读写的一层薄封装）───────────────────────────────────────────────

