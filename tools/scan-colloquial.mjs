import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const file = path.join(ROOT, 'README.md');
const src = fs.readFileSync(file, 'utf8');
const lines = src.split(/\r?\n/);

// 口语化 / 非正式表达：命中即报告
const PATTERNS = [
  ['第二人称', /你|您/],
  ['语气词', /啦|呀|嘛|呗|哇|哦|噢/],
  ['咱', /咱/],
  ['句末吧/呢', /吧[。！？，、\s]|呢[。！？，、\s]/],
  ['点一下类', /点一下|按一下|点开|点错|点俩|点个/],
  ['别X', /别被|别以为|别误会|别急|别猜|别用|别再|别想|别怕/],
  ['坑', /坑/],
  ['干活', /干活|活儿|活儿干/],
  ['摆设', /摆设/],
  ['打架', /打架/],
  ['讲道理', /讲道理|说人话|大白话/],
  ['炸', /当场炸|直接炸|会炸|炸了/],
  ['救', /救命|救回来|救场|能救/],
  ['顺手顺带', /顺手|顺带|顺便/],
  ['一不小心', /一不小心/],
  ['一堆', /一堆|一大堆/],
  ['钉死钉准', /钉死|钉准|钉住/],
  ['兜底', /兜底/],
  ['做足', /做足/],
  ['掉了没了', /掉了|没了|跑了|挂了/],
  ['猜', /猜/],
  ['骗', /骗/],
  ['拉起', /拉起来|拉起|拉个/],
  ['一会儿', /一会儿|一下下/],
  ['搞定', /搞定|弄好|搞好/],
  ['真的', /真事|真的是|真的会|真的能/],
  ['老问题', /老问题/],
  ['一模一样', /一模一样/],
  ['硬起', /硬起/],
  ['不碰', /不碰|绝不碰/],
  ['其实', /其实/],
  ['反正', /反正/],
  ['说白了', /说白了|简单说|说白了就是/],
  ['就够了', /就够了|就行|就可以了/],
  ['乖巧/乖乖', /乖乖|老实说/],
  ['挺X', /挺好|挺快|挺稳|挺准/],
  ['很容易/很难', /很容易|很难保证/],
  ['一遍', /过一遍|跑一遍|来一遍/],
  ['折腾', /折腾|搞|整成/],
  ['手忙脚乱', /手忙脚乱|心惊胆战/],
];

let hits = 0;
const byPattern = new Map();

lines.forEach((line, i) => {
  const trimmed = line.trim();
  for (const [name, re] of PATTERNS) {
    if (re.test(trimmed)) {
      hits += 1;
      if (!byPattern.has(name)) byPattern.set(name, []);
      byPattern.get(name).push({ n: i + 1, line: trimmed.slice(0, 160) });
    }
  }
});

for (const [name, list] of byPattern) {
  console.log(`\n### ${name} (${list.length})`);
  for (const h of list.slice(0, 12)) console.log(`  ${h.n}: ${h.line}`);
  if (list.length > 12) console.log(`  ... 共 ${list.length} 处`);
}

console.log(`\nTOTAL HIT LINES: ${new Set([...byPattern.values()].flat().map(x => x.n)).size}, HITS: ${hits}`);
