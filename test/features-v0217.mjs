// 自检：数据目录（v0.20.17）—— 指针文件优先级、迁移时搬什么不搬什么、接口与界面接线。
// 需求：用户要求「怎么更改存储路径」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-data-dir-'));
const SAVED = { home: process.env.DSH_HOME, dir: process.env.DSH_SHOP_ACCOUNTS_DIR };
process.env.DSH_HOME = TMP;
delete process.env.DSH_SHOP_ACCOUNTS_DIR;

const clientSrc = read('lib/client.js');
const pkg = JSON.parse(read('package.json'));

let pts = 0;
async function test(name, fn) {
  await fn();
  pts += 1;
  console.log('  ✓ ' + name);
}

try {
  const S = await import(url('lib/store.mjs'));
  const D = await import(url('lib/data-dir.mjs'));

  console.log('1. 数据目录的优先级');

  await test('A1 默认目录 = <DSH_HOME>/shop-accounts，指针文件能改它，环境变量优先级最高', () => {
    const def = path.join(TMP, 'shop-accounts');
    assert.equal(S.dataDir(), def, '没改过时用默认目录');
    assert.equal(S.defaultDataDir(), def, '默认目录要能单独取出来');

    const other = path.join(TMP, 'shop-accounts-alt');
    S.setDataDirPointer(other);
    assert.equal(S.dataDir(), other, '写了指针就用指针');
    assert.equal(S.readDataDirPointer(), other, '指针要能读回来');

    S.setDataDirPointer('');
    assert.equal(S.dataDir(), def, '清掉指针回到默认目录');
    assert.equal(S.readDataDirPointer(), '', '清掉后读不到指针');

    process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'from-env');
    assert.equal(S.dataDir(), path.resolve(path.join(TMP, 'from-env')), '环境变量要压过指针与默认');
    delete process.env.DSH_SHOP_ACCOUNTS_DIR;
  });

  console.log('2. 换目录与迁移');

  await test('A2 迁移只搬配置与采集数据，不搬浏览器档案；旧目录原样保留', () => {
    const from = path.join(TMP, 'from');
    const to = path.join(TMP, 'to');
    fs.mkdirSync(from, { recursive: true });
    fs.writeFileSync(path.join(from, 'accounts.json'), '{"accounts":[]}', 'utf8');
    fs.writeFileSync(path.join(from, 'config.json'), '{"browser":"auto"}', 'utf8');
    fs.mkdirSync(path.join(from, 'collection', 'acc_1'), { recursive: true });
    fs.writeFileSync(path.join(from, 'collection', 'acc_1', 'records.jsonl'), '', 'utf8');
    fs.mkdirSync(path.join(from, 'profiles', 'big'), { recursive: true });
    fs.writeFileSync(path.join(from, 'profiles', 'big', 'Cache.bin'), 'x'.repeat(1024), 'utf8');

    S.setDataDirPointer(from);
    const out = D.changeDataDir(to, { migrate: true });

    assert.equal(out.ok, true, '切换要成功');
    assert.equal(fs.readFileSync(path.join(to, 'accounts.json'), 'utf8'), '{"accounts":[]}', '账号表要搬过去');
    assert.ok(fs.existsSync(path.join(to, 'collection', 'acc_1', 'records.jsonl')), '采集数据要搬过去');
    assert.ok(!fs.existsSync(path.join(to, 'profiles')), '浏览器档案不该搬过去');
    assert.ok(out.copied.includes('accounts.json'), '要报告搬了哪些');
    assert.ok(!out.copied.includes('profiles'), '报告里不该有 profiles');

    assert.ok(fs.existsSync(path.join(from, 'accounts.json')), '旧目录的数据要留着');
    assert.equal(S.readDataDirPointer(), path.resolve(to), '指针要改成新目录');
  });

  await test('A3 只改指针不迁移：新目录留空；同目录与相对路径被拒', () => {
    const from = path.join(TMP, 'to');
    const to2 = path.join(TMP, 'to2');
    S.setDataDirPointer(from);
    const out = D.changeDataDir(to2, { migrate: false });
    assert.equal(out.copied.length, 0, '不迁移时什么都不复制');
    assert.ok(!fs.existsSync(path.join(to2, 'accounts.json')), '新目录里不该有账号表');
    assert.equal(S.readDataDirPointer(), path.resolve(to2), '指针照样改过去');

    assert.throws(() => D.changeDataDir(to2, {}), /一样/, '同一个目录要拒绝');
    assert.throws(() => D.changeDataDir('relative\\dir', {}), /绝对路径/, '相对路径要拒绝');
    assert.throws(() => D.changeDataDir('', {}), /请填一个目录/, '空值要拒绝');
  });

  await test('A4 迁移时会跳过新目录里已经有的同名项（不覆盖现有数据）', () => {
    const from = path.join(TMP, 'from');
    const to = path.join(TMP, 'to3');
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'accounts.json'), '{"accounts":[{"id":"keep"}]}', 'utf8');
    S.setDataDirPointer(from);
    const out = D.changeDataDir(to, { migrate: true });
    assert.ok(out.skipped.includes('accounts.json'), '已存在的文件要跳过');
    assert.equal(fs.readFileSync(path.join(to, 'accounts.json'), 'utf8'), '{"accounts":[{"id":"keep"}]}', '不能覆盖');
  });

  console.log('3. 接口与界面');

  await test('A5 状态里下发数据目录信息（当前 / 默认 / 是否环境变量指定）', () => {
    const stateSrc = read('lib/server/state.mjs');
    assert.ok(stateSrc.includes('dataDirInfo()'), '状态要带上 data-dir 信息');
    assert.ok(stateSrc.includes("data: dataDir()"), 'paths 里要有数据目录本身');
  });

  await test('A6 有 GET/POST /data-dir 两个接口，POST 走 changeDataDir', () => {
    const routesSrc = read('lib/server/routes.mjs');
    const seg = routesSrc.slice(routesSrc.indexOf('// v0.20.17：数据目录'), routesSrc.indexOf("if (method === 'POST' && p === '/ego/start')"));
    assert.ok(seg.includes("if (method === 'GET' && p === '/data-dir')"), '要有只读接口');
    assert.ok(seg.includes("if (method === 'POST' && p === '/data-dir')"), '要有切换接口');
    assert.ok(seg.includes('changeDataDir('), 'POST 要走 changeDataDir');
    assert.ok(seg.includes('migrate: body && body.migrate === true'), '迁移开关要显式');
    assert.ok(seg.includes('sendJson(res, 400, { ok: false, error'), '非法目录要有 400 与错误文案');
  });

  await test('A7 界面上有「数据目录」这块：打开 / 复制路径 / 更改', () => {
    assert.ok(clientSrc.includes("'数据目录'"), '设置卡里要有数据目录这一块');
    assert.ok(clientSrc.includes("'复制路径'"), '要能复制路径');
    assert.ok(clientSrc.includes("'更改'"), '要能改目录');
    assert.ok(clientSrc.includes("api('/data-dir'"), '改目录走后端接口');
    assert.ok(clientSrc.includes('把现有配置与采集数据复制过去'), '迁移选项要写清楚搬什么');
    assert.ok(clientSrc.includes('重启 DSH Desktop 后生效'), '要提示重启生效');
    assert.ok(clientSrc.includes('ddBusy') && clientSrc.includes('ddEdit'), '表单要有忙碌态');
    assert.ok(clientSrc.includes('var [ddEdit, setDdEdit] = React.useState(false);'), 'hook 要声明');
  });

  console.log('4. 版本与文档');

  await test('C1 版本号已到 0.20.17', () => {
    const parts = String(pkg.version).split('.').map((x) => Number(x));
    assert.ok(parts[0] > 0 || (parts[0] === 0 && (parts[1] > 20 || (parts[1] === 20 && parts[2] >= 17))), '版本应 ≥ 0.20.17：' + pkg.version);
  });

  await test('C2 CHANGELOG 与 README 同步', () => {
    const changelog = read('CHANGELOG.md');
    assert.ok(changelog.includes('v0.20.17'), 'CHANGELOG 要有 v0.20.17');
    assert.ok(/数据目录/.test(changelog), 'CHANGELOG 要说明数据目录');
    assert.ok(read('README.md').includes(pkg.version), 'README 版本行没跟上 ' + pkg.version);
  });

  assert.ok(readServerSource(ROOT).includes('dataDirInfo'), '聚合源码里要能看到 data-dir 的实现');
} finally {
  if (SAVED.home === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = SAVED.home;
  if (SAVED.dir === undefined) delete process.env.DSH_SHOP_ACCOUNTS_DIR;
  else process.env.DSH_SHOP_ACCOUNTS_DIR = SAVED.dir;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

console.log('\n✓ 全部通过（' + pts + ' 项）');
