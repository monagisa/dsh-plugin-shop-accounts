/**
 * secret.mjs —— 本机敏感数据（会话 cookie 罐）的加密。
 *
 * 为什么需要：`dsh-session-cookies.json` 里是**带值的整罐 cookie**（淘宝 `unb`、拼多多 `PASS_ID` …）。
 * 浏览器自己的 cookie 库有 Chromium 的 App-Bound 加密保护（v20），而插件把同样的值明文写在旁边，
 * 等于把这道保护绕过去了：备份工具、同步盘、同机其它账号都能直接读。
 *
 * 做法（DPAPI 信封 + AEAD）：
 *   · 一条随机 32 字节主密钥，用 **Windows DPAPI（CurrentUser）** 保护后存在 `<数据目录>/session-cookie.key`；
 *   · cookie 罐用 AES-256-GCM 加密（`{v:2, enc:'aes-gcm-dpapi', iv, tag, data}`）；
 *   · DPAPI 只在「第一次生成密钥 / 本进程第一次解包密钥」时调一次 PowerShell，之后全在进程内做，
 *     不会让每次检测都多等一两秒。
 *   · 任何一步不可用（非 Windows / PowerShell 被策略挡 / 旧文件）都退回明文格式（`enc:'plain'`）
 *     —— 安全降级，但绝不能把功能挡死。
 *
 * 注意：DPAPI 是**按用户**的，换个 Windows 账号或把文件拷到别的机器就打不开（这正是我们要的）。
 * 同机同账号的恶意进程仍能解包 —— 那是本机信任边界，插件层面做不到更多。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'session-cookie.key';

/** PowerShell 里读 stdin → DPAPI 保护 → 输出十六进制保护串（与 ConvertFrom-SecureString 兼容）。 */
const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  '$in = [Console]::In.ReadToEnd()',
  'if ($null -eq $in) { $in = "" }',
  '$sec = ConvertTo-SecureString -String $in -AsPlainText -Force',
  '[Console]::Out.Write((ConvertFrom-SecureString -SecureString $sec))',
].join('\n');

/** 反向：十六进制保护串 → DPAPI 解包 → 原文写到 stdout。 */
const PS_UNPROTECT = [
  "$ErrorActionPreference = 'Stop'",
  '$in = [Console]::In.ReadToEnd()',
  'if ($null -eq $in -or $in.Trim().Length -eq 0) { throw "empty protected string" }',
  '$sec = $in | ConvertTo-SecureString',
  '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)',
  'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
].join('\n');

function runPowerShell(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: String(input == null ? '' : input),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
}

/** DPAPI 可用性（目前只有 Windows 有；失败过就记住，不再反复试）。 */
let dpapiBroken = false;
export function dpapiAvailable() {
  return process.platform === 'win32' && !dpapiBroken;
}

function dpapiProtect(text) {
  return runPowerShell(PS_PROTECT, text);
}

function dpapiUnprotect(blob) {
  return runPowerShell(PS_UNPROTECT, blob);
}

/** 进程内缓存：`dataDir -> Buffer(32)`；`null` 表示"这个进程里用不了（退明文）"。 */
const keyCache = new Map();

function keyPath(dataDir) {
  return path.join(dataDir, KEY_FILE);
}

/**
 * 取（必要时生成）主密钥。返回 32 字节 Buffer；用不了就返回 null（调用方退明文）。
 * 生成/解包只调一次 PowerShell，之后命中缓存。
 *
 * 两条保守规则（2026-10-31 二次审查）：
 *   · **只有密钥文件不存在时**才生成新密钥。文件存在但解不开（AV 锁、半写、换了 Windows 账号）
 *     绝不覆盖 —— 覆盖会让此前所有 cookie 备份永久不可解；本进程退明文，下次重启再试。
 *   · 读失败先重试几次（AV 扫描常造成短暂占用），仍失败才放弃。
 */
export function sessionKey(dataDir) {
  const dir = path.resolve(String(dataDir || '.'));
  if (keyCache.has(dir)) return keyCache.get(dir);
  let key = null;
  if (dpapiAvailable()) {
    const file = keyPath(dir);
    let exists = false;
    try { exists = fs.existsSync(file); } catch { exists = false; }
    if (exists) {
      for (let attempt = 0; attempt < 3 && !key; attempt += 1) {
        try {
          const raw = dpapiUnprotect(fs.readFileSync(file, 'utf8'));
          const buf = Buffer.from(String(raw).trim(), 'base64');
          if (buf.length === 32) key = buf;
        } catch {
          // 短暂占用就等一下再试；真坏了（换账号/换机器）就放弃，**不覆盖**已有密钥
          if (attempt < 2) {
            try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 150'], { timeout: 5000, windowsHide: true }); } catch { /* ignore */ }
          }
        }
      }
      if (!key) keyCache.set(dir, null); // 本进程退明文，但密钥文件原样保留
      else keyCache.set(dir, key);
      return key;
    }
    try {
      key = crypto.randomBytes(32);
      const protectedText = String(dpapiProtect(key.toString('base64'))).trim();
      fs.mkdirSync(dir, { recursive: true });
      try {
        // 'wx'：两个 DSH 进程同时首次生成密钥时，只有一个能写成，另一个读回已有的——
        // 否则后写的会覆盖前一个，前一个进程刚写下的 cookie 备份就再也解不开了。
        fs.writeFileSync(file, protectedText, { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          const raw = dpapiUnprotect(fs.readFileSync(file, 'utf8'));
          const buf = Buffer.from(String(raw).trim(), 'base64');
          key = buf.length === 32 ? buf : null;
        } else {
          throw err;
        }
      }
      try { fs.chmodSync(file, 0o600); } catch { /* Windows 上基本 no-op */ }
    } catch {
      dpapiBroken = true;
      key = null;
    }
  }
  keyCache.set(dir, key);
  return key;
}

/** 只给自检用：清掉缓存（模拟"新进程"）。 */
export function __resetKeyCache() { keyCache.clear(); }

/**
 * 把 cookie 罐密封成可落盘的对象。key 为 null 时退化成明文（`enc:'plain'`，字段与旧版兼容）。
 * @returns {{ sealed: object, encrypted: boolean }}
 */
export function sealCookieJar(payload, key) {
  if (!key) return { sealed: { v: 2, enc: 'plain', ...payload }, encrypted: false };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    encrypted: true,
    sealed: {
      v: 2,
      enc: 'aes-gcm-dpapi',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: ct.toString('base64'),
    },
  };
}

/**
 * 解一个落盘的 cookie 文件。兼容三种格式：
 *   · v2 + aes-gcm-dpapi（现在的默认）
 *   · v2 + plain（DPAPI 不可用时的降级）
 *   · 旧版 `{savedAt, cookies:[...]}` 明文（v0.8.3 及更早）
 * @returns {object|null} payload（含 cookies 数组）；解不开返回 null。
 */
export function openCookieJar(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  const version = obj.v;
  if (version !== undefined && version !== 1 && version !== 2) return null; // 未知格式一律不认
  if (obj.enc === 'aes-gcm-dpapi') {
    if (version !== 2) return null;
    if (!key) return null;
    try {
      const iv = Buffer.from(String(obj.iv || ''), 'base64');
      const tag = Buffer.from(String(obj.tag || ''), 'base64');
      const data = Buffer.from(String(obj.data || ''), 'base64');
      if (iv.length !== 12 || tag.length !== 16) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(plain);
      return parsed && typeof parsed === 'object' && Array.isArray(parsed.cookies) ? parsed : null;
    } catch {
      return null;
    }
  }
  // 明文格式（v0.8.3 及更早，或 DPAPI 不可用时的降级）：必须是"没有 enc 或 enc==='plain'"的 JSON 对象。
  // 只用于兼容旧文件；新写入走加密（见 sealCookieJar）。
  if (obj.enc !== undefined && obj.enc !== 'plain') return null;
  if (!Array.isArray(obj.cookies)) return null;
  return obj;
}
