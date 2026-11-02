/**
 * platform/unsupported.mjs —— 其他平台（Linux 等）的兜底实现（v0.10.0）
 *
 * 目标不是"跑得起来"，而是**明确地不可用**而不是崩：
 *   · 没有密钥后端 → 密码库整体禁用（调用方据此把密码必填降级为"仅扫码"）
 *   · 找浏览器 / 进程匹配 / 打开目录 → 一律返回空或报错，让界面提示"本平台尚未适配"
 *
 * 想支持新平台时的做法：照 win32.mjs / darwin.mjs 的接口写一份 xxx.mjs，然后在 index.mjs 里挂上。
 */
import os from 'node:os';
import path from 'node:path';

export const id = process.platform || 'unknown';
export const label = `未适配平台（${id}）`;

export const secretBackend = null;

export const capabilities = {
  platform: id,
  platformLabel: label,
  secret: false,
  secretBackend: null,
  browser: false,
  ego: false,
  reveal: false,
};

function unavailable() {
  throw new Error(`本平台（${id}）尚未适配：缺少密钥后端 / 浏览器探测 / 进程管理实现`);
}

export function secretProtect() { unavailable(); }
export function secretUnprotect() { unavailable(); }
export function secretRetryDelaySync() { /* no-op */ }

export function browserCandidates() { return []; }
export function isBrowserExecutable() { return false; }
export function browserProcessNames() { return []; }
export function isEgoExecutable() { return false; }

export async function killByProfileDir() {
  return { ok: false, out: '', error: `本平台（${id}）尚未适配进程匹配` };
}
export async function ownerOfPort() { return null; }
export function killPidTree() { /* no-op */ }

export function revealDir() { unavailable(); }

export function egoCliCandidates() { return []; }
export function egoAppCandidates() { return []; }
export function egoUserDataDirs() { return []; }
export function pathSeparator() { return process.platform === 'win32' ? ';' : ':'; }
export function egoSupported() { return false; }
export function systemDirs() { return [os.tmpdir(), path.parse(os.homedir()).root].filter(Boolean); }
export function browserSpawnOptions() { return { detached: true, stdio: 'ignore' }; }
