/**
 * vault.mjs —— 店铺账号密码的本机加密库。
 *
 * 设计口径：
 *   · **只在本机**：密码写进 `<数据目录>/account-secrets.enc`，不联网、不进 accounts.json、不进日志、
 *     不进 /state 响应 —— 账号表里只能看到 `hasPassword` / `passwordUpdatedAt` 这类布尔与时间戳。
 *   · **加密复用 secret.mjs**：同一把平台密钥后端（Windows DPAPI / macOS 钥匙串）保护的主密钥 + AES-256-GCM，
 *     与 cookie 罐同一套信封（`{v:2, enc:'aes-gcm-dpapi'}`）。密钥后端不可用时**整库不可用**，
 *     绝不退化成明文存密码（这一点与 cookie 罐不同：cookie 明文只是等于绕过浏览器加密，
 *     密码明文落盘则是把用户所有店铺的账号密码摊开）。
 *   · **用途单一**：只给「自动登录」代填用（用户显式点按钮触发），不做后台偷偷登录。
 *
 * 为什么密码不放进 accounts.json：那张表是"店铺索引"，会被导出的诊断信息、备份、同步盘带走，
 * 而且插件有 `/accounts` 的 GET/PUT 面 —— 密码一旦进去，迟早被某条路径吐出来。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.mjs';
import { sessionKey, sealJson, openJson, dpapiAvailable } from './secret.mjs';
import * as platform from './platform/index.mjs';
import { atomicWriteJson } from './store.mjs';

const FILE = 'account-secrets.enc';

export function vaultPath() { return path.join(dataDir(), FILE); }

/** 加密是否可用（密钥后端不可用 = 密码库整体不可用，不降级明文）。 */
export function vaultAvailable() {
  if (!dpapiAvailable()) return false;
  return Boolean(sessionKey(dataDir()));
}

function emptyVault() {
  return { version: 1, updatedAt: null, entries: {} };
}

/**
 * 读整库。返回 `{ version, entries }`；文件不存在返回空库；解不开返回空库并把原因挂在 `__error`。
 * 绝不抛：一个坏文件不该让设置页打不开。
 */
export function readVault() {
  const file = vaultPath();
  let raw;
  try {
    if (!fs.existsSync(file)) return emptyVault();
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ...emptyVault(), __error: `读取密码库失败：${(err && err.message) || err}` };
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { ...emptyVault(), __error: '密码库文件不是合法 JSON（可能被截断），已按空库继续' };
  }
  const key = sessionKey(dataDir());
  const payload = openJson(envelope, key);
  if (!payload || typeof payload !== 'object' || typeof payload.entries !== 'object' || payload.entries === null) {
    return {
      ...emptyVault(),
      __error: key
        ? `密码库解不开（本机密钥对不上：${platform.label} 上换过系统账号，或本文件来自别的机器）`
        : `密码库解不开：本机密钥后端（${platform.secretBackend || '无'}）不可用`,
    };
  }
  return { version: 1, updatedAt: payload.updatedAt || null, entries: payload.entries };
}

function writeVault(vault) {
  const key = sessionKey(dataDir());
  if (!key) throw new Error('VAULT_UNAVAILABLE: 本机 DPAPI 不可用，密码库已禁用（不会退化成明文保存）');
  const payload = { version: 1, updatedAt: new Date().toISOString(), entries: vault.entries || {} };
  const { sealed } = sealJson(payload, key);
  atomicWriteJson(vaultPath(), sealed);
  return payload;
}

/** 只给路由层用的入参校验：密码是**原样字符串**（不 trim、不 NFC 化，用户密码里什么都可能有）。 */
export function normalizePassword(value) {
  if (typeof value !== 'string') throw new Error('密码必须是字符串');
  if (value.length < 1) throw new Error('密码不能为空');
  if (value.length > 4096) throw new Error('密码太长（最多 4096 字符）');
  if (/[\u0000]/.test(value)) throw new Error('密码不能包含 NUL 字符');
  return value;
}

export function hasPassword(accountId) {
  const v = readVault();
  return Boolean(v.entries && v.entries[String(accountId)]);
}

export function passwordUpdatedAt(accountId) {
  const v = readVault();
  const e = v.entries && v.entries[String(accountId)];
  return e ? e.updatedAt || null : null;
}

/** 取明文密码：只允许自动登录流程调用。不存在返回 null。 */
export function getPassword(accountId) {
  const v = readVault();
  const e = v.entries && v.entries[String(accountId)];
  if (!e || typeof e.password !== 'string' || !e.password) return null;
  return e.password;
}

export function setPassword(accountId, password, meta = {}) {
  const id = String(accountId || '').trim();
  if (!id) throw new Error('缺少账号 id');
  const pw = normalizePassword(password);
  const vault = readVault();
  if (vault.__error && Object.keys(vault.entries || {}).length === 0) {
    // 读失败又写进去 = 把已有条目全抹掉；这里宁可报错让用户先备份/删文件
    if (/DPAPI/.test(vault.__error)) throw new Error('VAULT_UNREADABLE: ' + vault.__error);
  }
  vault.entries = { ...(vault.entries || {}) };
  vault.entries[id] = {
    password: pw,
    updatedAt: new Date().toISOString(),
    ...(meta.loginName ? { loginName: String(meta.loginName) } : {}),
    ...(meta.platform ? { platform: String(meta.platform) } : {}),
  };
  writeVault(vault);
  return { hasPassword: true, passwordUpdatedAt: vault.entries[id].updatedAt };
}

export function clearPassword(accountId) {
  const id = String(accountId || '').trim();
  const vault = readVault();
  const entries = { ...(vault.entries || {}) };
  const had = Boolean(entries[id]);
  delete entries[id];
  if (had) {
    vault.entries = entries;
    writeVault(vault);
  }
  return { hasPassword: false, removed: had };
}

/** 删账号时顺手清密码（避免"账号没了、密码还在库里"）。 */
export function removeAccountSecret(accountId) {
  try { return clearPassword(accountId); } catch { return { hasPassword: false, removed: false }; }
}

/** 给 /state 用的汇总（数量 + 可用性，不含任何密码内容）。 */
export function vaultInfo() {
  const v = readVault();
  return {
    available: vaultAvailable(),
    path: vaultPath(),
    count: Object.keys(v.entries || {}).length,
    error: v.__error || null,
  };
}
