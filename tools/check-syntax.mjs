// 语法检查：对 lib/ 与 test/ 下所有 .js/.mjs 跑一次 node --check。
// 不执行代码，只做 parse，能在几秒内发现漏括号、模板串没闭合这类问题。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(?:m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'tools'))];
const bad = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) bad.push({ file: path.relative(ROOT, f), out: String(r.stderr || r.stdout || '').slice(-500) });
}
console.log(`语法检查：${files.length} 个文件，失败 ${bad.length} 个`);
for (const b of bad) console.log(`[FAIL] ${b.file}\n${b.out}`);
if (bad.length) process.exitCode = 1;
