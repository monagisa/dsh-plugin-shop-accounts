/**
 * platform/index.mjs —— 平台适配层的唯一入口（v0.10.0）
 *
 * 业务代码只从这里 import，**不要直接 import win32.mjs / darwin.mjs**，
 * 也不要在别处再写 `process.platform === 'win32'`。
 *
 * 统一契约（每个平台实现都要提供，缺一个就在单测里炸）：
 *   id                 平台标识（'win32' | 'darwin' | 其它）
 *   label              人话平台名（界面/报错里用）
 *   secretBackend      密钥后端标识（'dpapi' | 'keychain' | null = 没有可用后端）
 *   capabilities       能力位（给界面做降级展示用）
 *   secretProtect(dataDir, text)   -> 可落盘的字符串
 *   secretUnprotect(dataDir, blob) -> 明文
 *   secretRetryDelaySync()         解不开时的重试等待（同步）
 *   browserCandidates()            浏览器可执行文件候选路径
 *   isBrowserExecutable(basename)  文件名是否在白名单里
 *   browserProcessNames()          进程名列表
 *   isEgoExecutable(basename)      ego 可执行文件名是否合规
 *   killByProfileDir(dir)          -> Promise<{ok,out,error}>
 *   ownerOfPort(port)              -> Promise<string|null>
 *   killPidTree(pid)               杀进程树
 *   revealDir(dir)                 在文件管理器里打开目录
 *   egoCliCandidates() / egoAppCandidates()
 *   pathSeparator() / egoSupported() / systemDirs() / browserSpawnOptions()
 */
import * as win32 from './win32.mjs';
import * as darwin from './darwin.mjs';
import * as unsupported from './unsupported.mjs';

const IMPLS = { win32, darwin };

/** 当前会话生效的平台实现。`DSH_SA_PLATFORM=darwin` 可以在任意机器上跑 mac 分支的自检。 */
export function implFor(kind) {
  if (kind) return IMPLS[kind] || unsupported;
  const override = String(process.env.DSH_SA_PLATFORM || '').trim().toLowerCase();
  if (override) return IMPLS[override] || unsupported;
  return IMPLS[process.platform] || unsupported;
}

const impl = implFor();

/** 常量直接取当前实现的值（应用生命周期内不会变）。 */
export const id = impl.id;
export const label = impl.label;
export const secretBackend = impl.secretBackend;
export const capabilities = impl.capabilities;

/** 有没有可用的密钥后端（没有就不允许保存密码，界面降级为 manualOnly）。 */
export function secretAvailable() {
  return !!impl.secretBackend && !!impl.capabilities?.secret;
}

// ── 一律转发到当前实现 ───────────────────────────────────────────────────────

export const secretProtect = (...a) => impl.secretProtect(...a);
export const secretUnprotect = (...a) => impl.secretUnprotect(...a);
export const secretRetryDelaySync = (...a) => impl.secretRetryDelaySync(...a);

export const browserCandidates = (...a) => impl.browserCandidates(...a);
export const browserScanTargets = (...a) => impl.browserScanTargets(...a);
export const isBrowserExecutable = (...a) => impl.isBrowserExecutable(...a);
export const browserProcessNames = (...a) => impl.browserProcessNames(...a);
export const isEgoExecutable = (...a) => impl.isEgoExecutable(...a);

export const killByProfileDir = (...a) => impl.killByProfileDir(...a);
export const ownerOfPort = (...a) => impl.ownerOfPort(...a);
export const killPidTree = (...a) => impl.killPidTree(...a);
export const revealDir = (...a) => impl.revealDir(...a);

export const egoCliCandidates = (...a) => impl.egoCliCandidates(...a);
export const egoAppCandidates = (...a) => impl.egoAppCandidates(...a);
export const egoUserDataDirs = (...a) => impl.egoUserDataDirs(...a);

export const pathSeparator = (...a) => impl.pathSeparator(...a);
export const egoSupported = (...a) => impl.egoSupported(...a);
export const systemDirs = (...a) => impl.systemDirs(...a);
export const browserSpawnOptions = (...a) => impl.browserSpawnOptions(...a);
