import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const p = path.join(ROOT, 'README.md');
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);

// GitHub 风格锚点：小写、去标点（保留 Unicode 字母/数字/下划线/连字符）、空格转 -
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const headings = [];
let fence = 0;
const fences = [];
lines.forEach((l, i) => {
  if (/^```/.test(l.trim())) { fence += 1; fences.push(i + 1); return; }
  if (fence % 2 === 1) return; // 代码块内
  const m = /^(#{1,6})\s+(.*)$/.exec(l);
  if (m) headings.push({ level: m[1].length, text: m[2], n: i + 1 });
});

const anchorSet = new Set(headings.map(h => slug(h.text)));

// 收集 TOC 链接
const links = [];
let fence2 = 0;
lines.forEach((l, i) => {
  if (/^```/.test(l.trim())) { fence2 += 1; return; }
  if (fence2 % 2 === 1) return;
  const re = /\[([^\]]+)\]\(#([^)]+)\)/g;
  let m;
  while ((m = re.exec(l))) links.push({ text: m[1], anchor: m[2], n: i + 1 });
});

const bad = links.filter(x => !anchorSet.has(x.anchor));
console.log(`headings: ${headings.length}, toc links: ${links.length}`);
if (bad.length) {
  console.log('!! 失效锚点:');
  for (const b of bad) console.log(`   line ${b.n}: [${b.text}](#${b.anchor})`);
  // 打印近似候选
  for (const b of bad) {
    const near = headings.filter(h => slug(h.text).slice(0, 6) === b.anchor.slice(0, 6)).map(h => slug(h.text));
    if (near.length) console.log(`      候选: ${near.join(' | ')}`);
  }
} else {
  console.log('所有目录锚点均有效');
}

// 代码围栏配对
if (fences.length % 2 !== 0) console.log(`!! 代码围栏未闭合，共 ${fences.length} 个`);
else console.log(`代码围栏闭合：${fences.length / 2} 块`);

// 表格列数一致性
let inTable = false, cols = 0, tableBad = [];
lines.forEach((l, i) => {
  const isRow = /^\s*\|.*\|\s*$/.test(l);
  if (!isRow) { inTable = false; return; }
  const c = l.trim().replace(/^\||\|$/g, '').split('|').length;
  if (!inTable) { inTable = true; cols = c; return; }
  if (c !== cols && !/^\s*\|[\s:|-]+\|\s*$/.test(l)) tableBad.push({ n: i + 1, expect: cols, got: c });
});
if (tableBad.length) { console.log('!! 表格列数不一致:'); for (const t of tableBad.slice(0, 10)) console.log(`   line ${t.n}: 期望 ${t.expect} 列, 实际 ${t.got} 列`); }
else console.log('表格列数一致');

// 顶层章节列表
console.log('\n顶层章节:');
headings.filter(h => h.level === 2).forEach(h => console.log(`  - ${h.text}`));
