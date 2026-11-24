#!/usr/bin/env node
/**
 * 把老的 `collection/<账号id>/` 目录改名成可读的 `collection/<店名>_<平台>_<尾号>/`。
 *
 * 用法：
 *   node tools/migrate-collection-dirs.mjs --dry    # 只看计划
 *   node tools/migrate-collection-dirs.mjs          # 真的改
 *
 * 规则：
 *   - 账号已经用可读目录的跳过；
 *   - 老目录存在、可读目录不存在 → rename，并写 `.account.json` 归属标记；
 *   - 两个都存在 → 不合并、只报告（避免把历史数据搬散）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadAccounts } from '../lib/accounts.mjs';
import { collectionDirName, collectionRoot, ensureCollectionMarker } from '../lib/collection-dir.mjs';

const dry = process.argv.includes('--dry');

function main() {
  const root = collectionRoot();
  if (!fs.existsSync(root)) {
    console.log(`没有采集数据目录：${root}`);
    return;
  }
  const accounts = loadAccounts();
  let renamed = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const account of accounts) {
    const legacy = path.join(root, account.id);
    const target = path.join(root, collectionDirName(account));
    if (!fs.existsSync(legacy)) {
      if (fs.existsSync(target)) skipped += 1;
      continue;
    }
    if (fs.existsSync(target)) {
      conflicts += 1;
      console.log(`冲突：${account.name} 的老目录和可读目录同时存在，保持不动\n  老：${legacy}\n  新：${target}`);
      continue;
    }
    console.log(`${dry ? '将改名' : '改名'}：${path.basename(legacy)}  →  ${path.basename(target)}`);
    if (!dry) {
      fs.renameSync(legacy, target);
      ensureCollectionMarker(target, account.id);
    }
    renamed += 1;
  }
  console.log(`\n${dry ? '（预演，没有改动）' : '完成'}：改名 ${renamed} 个，已是新命名 ${skipped} 个，冲突 ${conflicts} 个。`);
  if (!dry && renamed) console.log('提示：改名只动手上的数据目录；已采数据、覆盖率台账、作业目录都会跟着走。');
}

main();
