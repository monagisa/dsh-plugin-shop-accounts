import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] || ROOT;
const list = ['smoke']
  .concat(
    fs.readdirSync(path.join(root, 'test'))
      .filter((f) => /^features-v\d+\.mjs$/.test(f))
      .map((f) => f.replace(/\.mjs$/, ''))
      .sort(),
  )
  .concat(['platform']);
let total = 0;
const bad = [];
for (const name of list) {
  const file = path.join(root, 'test', name + '.mjs');
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 300000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  // 各套用例行前缀不统一（✓ / PASS / 无标记），先按汇总句取数，取不到再数用例行
  const pats = [/通过（(\d+)\s*项）/, /通过：(\d+)\s*项/, /(\d+)\s*项通过/, /(\d+)\s*项，通过/, /通过\s*(\d+)\s*项/, /OK\s*\/\s*(\d+)\s*项/, /通过\s*(\d+)\s*\/\s*(\d+)/];
  let n = 0;
  for (const re of pats) { const m = out.match(re); if (m) { n = Number(m[1]); break; } }
  if (!n) n = (out.match(/^\s{2}\u2713 /gm) || []).length;
  const ok = r.status === 0;
  if (!ok) bad.push({ name, code: r.status, tail: out.slice(-600) });
  total += n;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${n} 项`);
}
console.log(`\n合计 ${total} 项${bad.length ? '，失败套件 ' + bad.length : '，全部通过'}`);
for (const b of bad) console.log('--- ' + b.name + ' (exit ' + b.code + ')\n' + b.tail);
fs.writeFileSync(path.join(root, 'suite-result.txt'), JSON.stringify({ total, bad }, null, 1), 'utf8');
if (bad.length) process.exitCode = 1;
