/**
 * test/platform.mjs —— 平台适配层的自检（v0.10.0）
 *
 * 目标：在**一台 Windows 机器上**尽可能多地验证 macOS 分支的正确性。
 *   · 能纯函数验证的（路径表、进程命令行解析、目录归一化、Keychain service 命名）→ 直接跑；
 *   · 需要 macOS 硬件的（`/usr/bin/security`、`ps`、真的 Chrome）→ 只验证「代码形状对」和「会被正确调用」；
 *   · 同时验证**业务代码里不再有平台硬编码**（防止以后又把 explorer.exe / powershell.exe 写回来）。
 *
 * 运行：`node test/platform.mjs`
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as platform from '../lib/platform/index.mjs';
import * as win32 from '../lib/platform/win32.mjs';
import * as darwin from '../lib/platform/darwin.mjs';
import * as unsupported from '../lib/platform/unsupported.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${(err && err.message) || err}\n`);
  }
}

// ── 契约：三份实现必须导出同一组函数 ─────────────────────────────────────────

const CONTRACT = [
  'id', 'label', 'secretBackend', 'capabilities',
  'secretProtect', 'secretUnprotect', 'secretRetryDelaySync',
  'browserCandidates', 'isBrowserExecutable', 'browserProcessNames', 'isEgoExecutable',
  'killByProfileDir', 'ownerOfPort', 'killPidTree', 'revealDir',
  'egoCliCandidates', 'egoAppCandidates', 'egoUserDataDirs',
  'pathSeparator', 'egoSupported', 'systemDirs', 'browserSpawnOptions',
];

await test('三份平台实现都满足统一契约（缺一个就说明重构漏了）', () => {
  for (const [name, impl] of [['win32', win32], ['darwin', darwin], ['unsupported', unsupported]]) {
    for (const key of CONTRACT) {
      assert.ok(key in impl, `${name}.mjs 缺少契约成员：${key}`);
    }
    assert.equal(typeof impl.capabilities, 'object', `${name}.capabilities 必须是对象`);
  }
});

await test('index.mjs 按 process.platform 选实现，且支持 DSH_SA_PLATFORM 覆盖', () => {
  assert.equal(platform.implFor('darwin').id, 'darwin');
  assert.equal(platform.implFor('win32').id, 'win32');
  assert.equal(platform.implFor('linux').capabilities.secret, false, '未知平台必须落到 unsupported（没有密钥后端）');
  assert.equal(platform.id, process.platform === 'win32' ? 'win32' : platform.id, '默认实现应匹配当前平台');
  // 环境变量覆盖：起一个子进程验（模块级常量在 import 时就定死了，只能在子进程里换环境）
  const url = new URL('../lib/platform/index.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(m.id + '|' + m.secretBackend + '|' + m.secretAvailable());`], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DSH_SA_PLATFORM: 'darwin' },
  }).trim();
  assert.equal(out, 'darwin|keychain|true', 'DSH_SA_PLATFORM=darwin 时应加载 mac 实现（Keychain 后端可用）');
  const out2 = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(m.id + '|' + m.secretBackend + '|' + m.secretAvailable());`], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DSH_SA_PLATFORM: 'plan9' },
  }).trim();
  assert.equal(out2, `${process.platform}|null|false`, '不认识的 DSH_SA_PLATFORM 必须落到无密钥后端的兜底实现');
});

// ── Windows 实现（本机可完整验证）────────────────────────────────────────────

await test('win32：浏览器/ego 可执行文件白名单挡得住前缀骗法', () => {
  assert.ok(win32.browserCandidates().length >= 2, '候选表不能为空');
  assert.ok(win32.browserCandidates().every((p) => /\.exe$/i.test(p)), 'Windows 候选必须都是 .exe');
  assert.equal(win32.isBrowserExecutable('chrome.exe'), true);
  assert.equal(win32.isBrowserExecutable('MSEDGE.EXE'), true, '大小写不敏感');
  assert.equal(win32.isBrowserExecutable('chrome-evil.exe'), false, '前缀骗法必须挡掉');
  assert.equal(win32.isEgoExecutable('ego.exe'), true);
  assert.equal(win32.isEgoExecutable('not-ego.exe'), false);
  assert.equal(win32.pathSeparator(), ';');
  assert.ok(win32.systemDirs().length >= 1, '系统目录表不能为空（updateDir 校验要用）');
  assert.ok(win32.egoUserDataDirs().length >= 1);
  assert.equal(win32.capabilities.secretBackend, 'dpapi');
  assert.equal(win32.browserSpawnOptions().detached, true);
});

await test('win32：按 user-data-dir 杀进程拒绝空路径（防止误杀全机浏览器）', async () => {
  const r = await win32.killByProfileDir('');
  assert.equal(r.ok, false);
  assert.match(String(r.error || ''), /空路径/);
});

// ── macOS 实现（能纯函数验的部分）────────────────────────────────────────────

await test('darwin：浏览器候选都是 .app 包内二进制，白名单没有 .exe 后缀概念', () => {
  const cands = darwin.browserCandidates({ home: '/Users/tester', applications: '/Applications' });
  assert.ok(cands.length >= 4);
  assert.ok(cands.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '要找 Chrome.app 里的真实二进制');
  assert.ok(cands.some((p) => p.startsWith('/Users/tester/Applications/')), '也要看用户级 ~/Applications');
  assert.equal(darwin.isBrowserExecutable('Google Chrome'), true);
  assert.equal(darwin.isBrowserExecutable('google chrome'), true, 'macOS 上比较应大小写不敏感');
  assert.equal(darwin.isBrowserExecutable('chrome.exe'), false, 'mac 上不该认 Windows 的 exe 名');
  assert.equal(darwin.isBrowserExecutable('Google Chrome Helper'), false, 'Helper 进程不是浏览器主程序');
  assert.equal(darwin.isEgoExecutable('ego'), true);
  assert.equal(darwin.isEgoExecutable('ego-browser'), true);
  assert.equal(darwin.isEgoExecutable('ego.exe'), false);
  assert.equal(darwin.pathSeparator(), ':');
  assert.equal(darwin.capabilities.secretBackend, 'keychain');
  assert.equal(darwin.secretBackend, 'keychain');
  assert.ok(darwin.systemDirs().includes('/Applications'));
  assert.ok(darwin.egoUserDataDirs().every((p) => p.includes('Application Support') || p.includes('/Applications')));
});

await test('darwin：从 `ps` 命令行里抠 --user-data-dir（带引号/不带引号/尾斜杠都认）', () => {
  const { userDataDirOf, normDir } = darwin.__internals;
  assert.equal(userDataDirOf('Google Chrome --user-data-dir=/tmp/a --remote-debugging-port=9222'), '/tmp/a');
  assert.equal(userDataDirOf('Google Chrome --user-data-dir="/Users/t/My Data" --x=1'), '/Users/t/My Data');
  assert.equal(userDataDirOf('Google Chrome --no-first-run'), null);
  // 尾斜杠归一化后相等 —— 这是"精确匹配"能对上的关键
  assert.equal(normDir('/tmp/a/'), normDir('/tmp/a'));
  assert.equal(normDir('/tmp/a//'), '/tmp/a');
});

await test('darwin：Keychain service 名按数据目录稳定派生、不同目录不同名', () => {
  const { serviceFor } = darwin.__internals;
  const a = serviceFor('/Users/tester/.dsh/shop-accounts');
  const b = serviceFor('/Users/tester/.dsh/shop-accounts');
  const c = serviceFor('/Users/tester/other-dir');
  assert.equal(a, b, '同一目录必须派生出同一个 service（否则密码解不开）');
  assert.notEqual(a, c, '不同数据目录必须隔离（不能互相覆盖主密钥）');
  assert.match(a, /^dsh-shop-accounts-shop-accounts-[0-9a-f]{16}$/, 'service 名要可读且带短哈希');
  // 路径里的怪异字符不会漏进 service 名（security CLI 的参数安全）
  assert.match(serviceFor('/Users/t !@#$%^&*()/data dir'), /^dsh-shop-accounts-[a-zA-Z0-9._-]*-[0-9a-f]{16}$/);
});

await test('darwin：按 user-data-dir 杀进程拒绝空路径/根路径（防止误杀同一用户全部 Chrome）', async () => {
  const empty = await darwin.killByProfileDir('');
  assert.equal(empty.ok, false);
  const rootDir = await darwin.killByProfileDir('/');
  assert.equal(rootDir.ok, false);
  assert.match(String(rootDir.error || ''), /根路径/);
});

await test('darwin：secretProtect 走 /usr/bin/security，返回 keychain: 标记；解包从标记里取 service', () => {
  const src = read('lib/platform/darwin.mjs');
  assert.match(src, /const SECURITY = '\/usr\/bin\/security'/);
  assert.match(src, /'add-generic-password'/, '写入要 add-generic-password');
  assert.match(src, /'-U'/, '已存在时要 -U 更新（对应 Windows 上 wx 写失败读回的语义）');
  assert.match(src, /'find-generic-password'/, '读取要 find-generic-password');
  assert.match(src, /return `keychain:\$\{service\}`/, '落盘只存标记，不存密钥本身');
  // 标记格式必须能被解包端认出来
  assert.match(src, /raw\.startsWith\('keychain:'\)/);
});

// ── 业务代码不再有平台硬编码 ─────────────────────────────────────────────────

await test('lib 里不再散落 Windows 硬编码（powershell / explorer / Program Files / chrome.exe 白名单）', () => {
  const files = fs.readdirSync(path.join(root, 'lib')).filter((f) => /\.(mjs|js)$/.test(f));
  const offenders = [];
  for (const f of files) {
    const src = read(path.join('lib', f));
    // 允许出现在注释里；这里只找**代码行**里的调用/路径拼接
    const codeLines = src.split(/\r?\n/).filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    const code = codeLines.join('\n');
    if (/execFileSync\(\s*'powershell|execFile\(\s*'powershell|runPowerShell\(/.test(code)) offenders.push(`${f}: 直接调用 PowerShell`);
    if (/spawn\(\s*'explorer\.exe'/.test(code)) offenders.push(`${f}: 直接调用 explorer.exe`);
    if (/spawnSync\(\s*'taskkill'/.test(code)) offenders.push(`${f}: 直接调用 taskkill`);
    if (/'C:\\\\Program Files/.test(code)) offenders.push(`${f}: 硬编码 Program Files 路径`);
    if (/process\.env\.LOCALAPPDATA/.test(code)) offenders.push(`${f}: 直接读 LOCALAPPDATA`);
  }
  const secret = read('lib/secret.mjs');
  assert.ok(!/powershell\.exe/.test(secret.split(/\r?\n/).filter((l) => !/^\s*\*/.test(l)).join('\n')), 'secret.mjs 不该再自己调 PowerShell（已抽到平台层）');
  const vault = read('lib/vault.mjs');
  assert.ok(!/process\.platform\s*!==\s*'win32'/.test(vault), 'vault.mjs 不该再硬判 win32（否则 mac 上密码库永远不可用）');
  assert.deepEqual(offenders, [], '这些平台相关调用应该只在 lib/platform/ 里出现：\n' + offenders.join('\n'));
});

await test('平台相关的实现只出现在 lib/platform/ 里', () => {
  const platformFiles = fs.readdirSync(path.join(root, 'lib', 'platform')).sort();
  assert.deepEqual(platformFiles, ['darwin.mjs', 'index.mjs', 'unsupported.mjs', 'win32.mjs']);
});

await test('/state 会告诉界面当前平台与能力位（mac 上据此显示钥匙串文案）', () => {
  const src = read('lib/index.js');
  assert.match(src, /osPlatform: \{/, 'buildState 要带 osPlatform');
  assert.match(src, /secretBackend: osPlatform\.secretBackend/);
  const client = read('lib/client.js');
  assert.match(client, /props\.osPlatform/, '详情页要能按平台显示密钥文案');
  assert.match(client, /macOS 钥匙串/, 'mac 上要说明密码存进钥匙串，而不是含混的"系统加密"');
});

// ── 收尾 ─────────────────────────────────────────────────────────────────────

process.stdout.write(`\n${failed ? '✗ 失败' : '✓ 全部通过'}（${passed + failed} 项）\n`);
process.exit(failed ? 1 : 0);
