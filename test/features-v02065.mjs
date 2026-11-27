// v0.20.65：采集数据目录按店名命名（`collection/<店名>_<平台>_<尾号>`）。
//
// 背景：以前采集数据直接落在 `collection/<账号id>/`（形如 acc_taobao_mw05dt23d7jw），
// 在文件管理器里看不出是哪家店。现在目录名用店名，老目录仍然兼容（不自动搬动），
// 并提供 `tools/migrate-collection-dirs.mjs` 一键改名。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v02065-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = TMP;

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const libUrl = (name) => url.pathToFileURL(path.join(ROOT, 'lib', name)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const { accountDirTag, collectionDirName, collectionDirOf, ensureCollectionDir, collectionRoot } = await import(libUrl('collection-dir.mjs'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}

const TAOBAO = { id: 'acc_demo_taobao_123456', name: '示例店铺', platform: 'taobao' };
const PDD = { id: 'acc_demo_pdd_654321', name: '示例拼多多店', platform: 'pdd' };
const DY = { id: 'acc_demo_douyin_abcdef', name: '示例抖音店', platform: 'douyin' };

// ── A 组：目录名的形状
ok(accountDirTag(TAOBAO.id) === '123456', 'A1 账号尾号取末 6 位');
ok(accountDirTag(DY.id) === 'abcdef', 'A2 纯字母尾号也正确');
ok(accountDirTag('') === 'shop', 'A3 空 id 退化成 shop');
ok(collectionDirName(TAOBAO) === '示例店铺_taobao_123456', 'A4 可读目录名 = 店名_平台_尾号');
ok(collectionDirName(PDD) === '示例拼多多店_pdd_654321', 'A5 拼多多店名同样可读');
ok(collectionDirName({ id: 'acc_x_123456', name: '', platform: 'taobao' }) === '店铺_taobao_123456', 'A6 没店名时用「店铺」');
ok(collectionDirName({ id: 'acc_t1_abcdef', name: 'a/b:c*d', platform: 'taobao' }) === 'abcd_taobao_abcdef', 'A7 店名里的非法字符被清掉');

// ── B 组：目录创建与归属标记
const dir = ensureCollectionDir(TAOBAO);
ok(dir === path.join(collectionRoot(), '示例店铺_taobao_123456'), 'B1 目录建在 collection/<可读名>');
ok(fs.existsSync(dir), 'B2 目录真的建出来了');
const marker = JSON.parse(fs.readFileSync(path.join(dir, '.account.json'), 'utf8'));
ok(marker.accountId === TAOBAO.id, 'B3 目录里有归属标记 .account.json');
ok(collectionDirOf(TAOBAO.id) === dir, 'B4 只有账号 id 时能靠标记反查到目录');
ok(collectionDirOf(TAOBAO) === dir, 'B5 传账号对象也解析到同一个目录');
ok(ensureCollectionDir(PDD) === path.join(collectionRoot(), '示例拼多多店_pdd_654321'), 'B6 第二家店是独立目录');

// ── B7/B8：没有目录、只有 accounts.json 时也能算出可读目录（作业目录走这条路径）
fs.writeFileSync(path.join(TMP, 'accounts.json'), JSON.stringify([TAOBAO, PDD, DY]), 'utf8');
ok(collectionDirOf('acc_demo_taobao_123456') === dir, 'B7 账号 id 能从 accounts.json 里查到店名并解析到同一目录');
const freshDir = collectionDirOf('acc_new_shop_999999');
ok(freshDir === path.join(collectionRoot(), 'acc_new_shop_999999'), 'B8 账号表里没有的 id 退回老命名（不会猜错店名）');

// ── C 组：老目录兼容（不自动搬）
const legacyDir = path.join(collectionRoot(), DY.id);
fs.mkdirSync(legacyDir, { recursive: true });
fs.writeFileSync(path.join(legacyDir, 'records.jsonl'), '', 'utf8');
ok(collectionDirOf(DY) === legacyDir, 'C1 老目录存在时继续用它（数据不分裂）');
ok(JSON.parse(fs.readFileSync(path.join(legacyDir, '.account.json'), 'utf8')).accountId === DY.id, 'C2 老目录被补上归属标记');
ok(collectionDirOf(DY.id) === legacyDir, 'C3 老目录也能靠标记反查');

// ── D 组：各处都改用新解析
const datastoreSrc = read('lib/datastore.mjs');
const runnerSrc = read('lib/collect-runner.mjs');
const supportSrc = read('lib/collect-support.mjs');
ok(/collectionDirOf\(requireAccountId\(accountId\)\)/.test(datastoreSrc), 'D1 datastore 的 collectionStoreDir 改用新解析');
ok(/collection-dir\.mjs/.test(datastoreSrc), 'D2 datastore 引入 collection-dir');
ok(/ensureCollectionDir\(account\)/.test(supportSrc), 'D3 采集下载目录按店铺可读目录走');
ok(/ensureCollectionDir\(requireAccount\(accountId\)\)/.test(runnerSrc) && /'jobs'/.test(runnerSrc), 'D4 作业目录挂在店铺可读目录下');
ok(/dsl-coverage\.json/.test(runnerSrc) && !/path\.join\(dataDir\(\), 'collection', requireAccount\(accountId\), 'dsl-coverage/.test(runnerSrc), 'D5 配方台账也用可读目录');

// ── E 组：迁移工具
const migSrc = read('tools/migrate-collection-dirs.mjs');
ok(/--dry/.test(migSrc), 'E1 迁移工具支持 --dry 预演');
ok(/fs\.renameSync\(legacy, target\)/.test(migSrc), 'E2 迁移工具做 rename');
ok(/ensureCollectionMarker\(target, account\.id\)/.test(migSrc), 'E3 迁移后写归属标记');
ok(/冲突/.test(migSrc), 'E4 老目录与新目录同时存在时不合并、只报告');

// ── F 组：版本与变更记录
const pkg = JSON.parse(read('package.json'));
function vcAtLeast(v, want) {
  const a = String(v || '').split('.').map(Number);
  const b = String(want || '').split('.').map(Number);
  for (let i = 0; i < b.length; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}
ok(vcAtLeast(pkg.version, '0.20.65'), 'F1 package.json 版本 ≥ 0.20.65（当前 ' + pkg.version + '）');
const changelog = read('CHANGELOG.md');
ok(changelog.includes('## v0.20.65'), 'F2 CHANGELOG 有 v0.20.65 段');
ok(changelog.includes('collection') || changelog.includes('采集数据目录'), 'F3 CHANGELOG 说明目录命名');
ok(typeof pkg.scripts.features77 === 'string', 'F4 package.json 有 features77 别名');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nfeatures-v02065: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
