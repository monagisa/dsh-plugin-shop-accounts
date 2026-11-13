/**
 * v0.20.29 自检：ego lite 升级后 CLI 找不到 —— 界面点 ego lite 却仍标 Chrome。
 *
 * 现场：设置页点 ego lite 那一行提示「已切到 ego lite」，但「默认」徽标还停在 Chrome、
 * ego lite 自己写着「未设为默认」。
 *
 * 根因：本机 ego lite 从 0.6.2.8 升级到 0.6.2.10 后，
 *   `%USERPROFILE%\.local\share\ego\active_version_dir` 这条链接仍指向旧的 `Application\0.6.2.8`，
 * 而实际主程序在 `Application\0.6.2.10\ego-browser.exe`。
 *   `resolveEgoCli()` 只看固定位置 → 返回 null → `backendFor()` 认为「没装 ego lite」退回 chrome
 *   → `/browser-scan` 按解析后的后端标记，于是 Chrome 仍是「使用中」。
 *
 * 做法：`egoCliCandidates()` 先扫安装目录下的版本子目录（版本最高的在前），
 *   固定链接只作兜底；这样升级/换版本目录后依然能找到 CLI。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const changelog = read('CHANGELOG.md');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

const platform = await import(pathToFileURL(path.join(ROOT, 'lib/platform/win32.mjs')).href);
const ego = await import(pathToFileURL(path.join(ROOT, 'lib/ego.mjs')).href);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}

function versionAtLeast(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

console.log('\nv0.20.29 ego lite CLI 位置（升级后仍能找到）');

await test('A1 egoCliVersionDirs() 按版本从新到旧列出版本目录里的主程序', async () => {
  const tmp = path.join(os.tmpdir(), 'shop-accounts-v0229-' + Date.now());
  try {
    const appDir = path.join(tmp, 'Application');
    for (const v of ['0.6.2.8', '0.6.2.10', '0.7.1']) {
      fs.mkdirSync(path.join(appDir, v), { recursive: true });
      fs.writeFileSync(path.join(appDir, v, 'ego-browser.exe'), '', 'utf8');
    }
    const dirs = platform.egoCliVersionDirs(appDir);
    assert.equal(dirs.length, 3, '应该列出三个版本目录');
    assert.ok(dirs[0].includes(path.join('Application', '0.7.1')), '版本最高的应排第一：' + dirs[0]);
    assert.ok(dirs[1].includes(path.join('Application', '0.6.2.10')), '第二应是 0.6.2.10：' + dirs[1]);
    assert.ok(dirs[2].includes(path.join('Application', '0.6.2.8')), '最后应是 0.6.2.8：' + dirs[2]);
    assert.ok(dirs.every((p) => path.basename(p) === 'ego-browser.exe'), '候选必须是 ego-browser.exe');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('A2 egoCliVersionDirs() 目录不存在时返回空数组，不抛错', () => {
  const dirs = platform.egoCliVersionDirs(path.join(os.tmpdir(), 'shop-accounts-not-installed-' + Date.now()));
  assert.deepEqual(dirs, []);
});

await test('A3 egoCliCandidates() 把版本目录候选排在固定链接之前', () => {
  const src = read('lib/platform/win32.mjs');
  const first2 = src.indexOf('egoCliVersionDirs(path.join(pf,');
  const legacy = src.indexOf("path.join(home, '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe')");
  assert.ok(first2 > -1, 'egoCliCandidates 没扫版本目录');
  assert.ok(legacy > -1, '固定链接候选被删掉了（老机器还要用）');
  assert.ok(first2 < legacy, '版本目录候选必须排在固定链接前面');
});

await test('B1 本机装了 ego lite 时，明确选 egolite 的后端就是 egolite', () => {
  const cli = ego.resolveEgoCli('');
  if (!cli) { console.log('      （本机没装 ego lite，跳过）'); return; }
  assert.equal(ego.backendFor({ browser: 'egolite' }), 'egolite', '装了 ego lite 却退回 chrome');
  assert.ok(cli.includes('ego-browser'), '解析到的 CLI 路径不像 ego-browser：' + cli);
});

await test('B2 配置里写错的 CLI 路径不会被采用（回退到自动探测或空）', () => {
  const bogus = path.join(os.tmpdir(), 'no-such-ego-browser.exe');
  const resolved = ego.resolveEgoCli(bogus);
  assert.notEqual(resolved, bogus, '不该返回配置里那个不存在的路径');
  assert.ok(resolved === null || fs.existsSync(resolved), '返回的路径必须真的存在：' + resolved);
});

await test('C1 版本号已到 0.20.29', () => {
  assert.ok(versionAtLeast(pkg.version, '0.20.29'), 'package.json 版本是 ' + pkg.version);
});

await test('C2 CHANGELOG 记录了这次修复', () => {
  assert.ok(changelog.includes('v0.20.29'), 'CHANGELOG 缺 v0.20.29');
  assert.ok(changelog.includes('active_version_dir') || changelog.includes('版本目录'), 'CHANGELOG 没讲 ego lite 版本目录');
});

await test('C3 README 的自检清单包含这一套', () => {
  assert.ok(readme.includes('features-v02029.mjs'), 'README 自检块缺 features-v02029.mjs');
});

console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' / 通过 ' + passed : '\u2713 全部通过（' + passed + ' 项）'));
process.exit(failures.length ? 1 : 0);
