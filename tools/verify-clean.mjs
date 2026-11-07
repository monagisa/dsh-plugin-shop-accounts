import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 规则表自身就写着这些待查词，扫描时必须跳过（否则永远命中自己）。
const SKIP = ['tools/scan-colloquial.mjs', 'tools/verify-clean.mjs'];

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})(ROOT);

const RULES = [
  ['upstream-name', /\bAccio\b|accio|ACCIO/i],
  ['reverse-terms', /逆向|反编译|reverse[- ]engineer|decompil/i],
  ['upstream-cli', /ecomctl|commerce-domestic|ecommerce\.db|ecommerce-data-collect|browser_rpa_launch|ecommerce-automation-toolkit|ecommerce-cli/i],
  ['home-path', /\b(?:[A-Z]:[\\/]+Users[\\/]+mo\b|\/Users\/mo\b)/i],
  ['real-shop', /韩品兰坊|吸音隔热教授/],
  ['real-person', /阿柔|阿荣/],
  ['account-id', /\b(?:286936609|1781583189|1783039944|2500002180289|4500103088049)\b/],
  ['msg-ref', /\bm0\d{4}\b/],
  ['email', /[\w.+-]+@(?:qq|gmail|163|126|outlook)\.com/i],
  ['userquote', /用户原话|他机器/],
];

let total = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (SKIP.includes(rel)) continue;
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  txt.split('\n').forEach((line, i) => {
    for (const [name, re] of RULES) {
      const m = line.match(re);
      if (m) {
        // 允许：测试里主动断言这些字符串不存在
        const isGuard = /const bad of|includes\(bad\)|不该带|assert\.ok\(!raw|for \(const bad/.test(line);
        if (isGuard) return;
        total += 1;
        console.log(`[${name}] ${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
        break;
      }
    }
  });
}
console.log('\nTOTAL SUSPECT LINES:', total);
