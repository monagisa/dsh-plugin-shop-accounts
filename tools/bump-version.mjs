// 升版辅助：把「版本号 + 描述 + CHANGELOG 段头 + README 版本行 + 自检清单」这五件机械动作做掉。
// 版本特有的正文（CHANGELOG 每条改动、README 更新说明小节）仍需人工补，脚本会打印待办。
//
// 用法：
//   node tools/bump-version.mjs 0.20.0
//   node tools/bump-version.mjs 0.20.0 "；v0.20.0 起 xxx"
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(ROOT, 'package.json');
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const readmePath = path.join(ROOT, 'README.md');

const version = process.argv[2];
const descTail = process.argv[3] || '';
if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) {
  console.error('用法：node tools/bump-version.mjs <版本号> ["描述追加内容"]');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
if (version === oldVersion) {
  console.error('版本号没变：' + oldVersion);
  process.exit(1);
}
pkg.version = version;
if (descTail) {
  pkg.description = String(pkg.description || '').replace(/；v[0-9a-z.-]+ 起[^；]*$/g, '') + descTail;
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// CHANGELOG：保留 BOM，顶部插段头 + 待填正文
let cl = fs.readFileSync(changelogPath, 'utf8');
const bom = cl.startsWith('\uFEFF') ? '\uFEFF' : '';
const body = cl.slice(bom.length);
const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const head = `## v${version}（${ymd}）\n\n（待补：需求 / 改动 / 验证）\n\n`;
if (!body.includes(`## v${version}`)) cl = bom + head + body;
fs.writeFileSync(changelogPath, cl, 'utf8');

// README：替换「当前版本 **X**」这一行
let rd = fs.readFileSync(readmePath, 'utf8');
const versionLine = rd.match(/当前版本 \*\*[^]*?\*\*/);
if (!versionLine) {
  console.warn('README 里没找到「当前版本 **X**」这一行，需手动改');
} else {
  rd = rd.replace(/当前版本 \*\*(\d+\.\d+\.\d+)\*\*/, `当前版本 **${version}**`);
  fs.writeFileSync(readmePath, rd, 'utf8');
}

const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'rebuild-readme-blocks.mjs')], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(String(r.stdout || ''));
if (r.status !== 0) process.stdout.write(String(r.stderr || ''));

console.log(`\n版本：${oldVersion} → ${version}`);
console.log('待办（脚本不做，需人工）：');
console.log('  1. package.json 的 scripts 里给新测试套件加一条链（若新增了 test/features-vXXXX.mjs）');
console.log('  2. CHANGELOG 段正文（需求 / 改动 / 验证）');
console.log('  3. README 的「更新说明」小节与 TOC 锚点（若这版有功能变化）');
console.log('  4. tools/rebuild-readme-blocks.mjs 的 SUITES 里补新套件，再跑一次 npm run readme');
