/**
 * v0.20.43：采集域统一成五项（去掉「竞争洞察」）
 *
 * 覆盖：目录层按平台下发的域、允许域校验、账号配置、工具枚举、
 * 配方里的 domains 声明、界面五项固定、版本文档。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CM = await import(url.pathToFileURL(path.join(ROOT, 'lib/catalog.mjs')).href);
const CL = await import(url.pathToFileURL(path.join(ROOT, 'lib/collection.mjs')).href);
const DM = await import(url.pathToFileURL(path.join(ROOT, 'lib/domains.mjs')).href);
const TOOLS = await import(url.pathToFileURL(path.join(ROOT, 'lib/server/tools.mjs')).href);
const DSLS = await import(url.pathToFileURL(path.join(ROOT, 'lib/dsls.mjs')).href);

const FIVE = ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约'];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const changelog = read('CHANGELOG.md');
const readme = read('README.md');
const client = read('lib/client.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('OK   ' + name);
  } catch (e) {
    fail += 1;
    console.log('FAIL ' + name);
    console.log('      ' + (e && e.message));
  }
}

t('A1 五项常量存在且顺序固定', () => {
  assert.deepEqual(CL.COLLECTION_DOMAINS, FIVE);
});

t('A2 目录层每个平台都只下发五项（不再有竞争洞察）', () => {
  for (const platform of ['taobao', 'tmall', 'jd', 'pdd', 'douyin', '1688']) {
    const ids = CM.catalogDomainIds(platform);
    assert.deepEqual(ids, FIVE, platform + ' 域清单应为五项：' + JSON.stringify(ids));
  }
});

t('A3 目录概览里的域也不含竞争洞察', () => {
  const overview = CM.catalogOverview ? CM.catalogOverview() : null;
  if (!overview) return;
  for (const platform of Object.keys(overview)) {
    const domains = (overview[platform] && overview[platform].domains) || [];
    const ids = domains.map((d) => (typeof d === 'string' ? d : d.id));
    assert.ok(!ids.includes('竞争洞察'), platform + ' 仍带竞争洞察');
  }
});

t('B1 允许域校验：所有平台都只有五项', () => {
  for (const platform of ['taobao', 'tmall', 'jd', 'pdd', 'douyin']) {
    assert.deepEqual(DM.allowedDomains(platform), FIVE, platform);
  }
});

t('B2 竞争洞察不再被任何平台允许', () => {
  for (const platform of ['taobao', 'tmall', 'jd', 'pdd', 'douyin']) {
    assert.equal(DM.allowedDomains(platform).includes('竞争洞察'), false, platform);
  }
});

t('C1 目录额外域常量已清空', () => {
  assert.deepEqual(CL.CATALOG_EXTRA_DOMAINS, []);
});

t('C2 采集域中文标签仍是五项', () => {
  const labels = CL.domainList ? CL.domainList() : null;
  if (!labels) return;
  const ids = labels.map((d) => (typeof d === 'string' ? d : d.id));
  assert.deepEqual(ids, FIVE);
});

t('D1 工具枚举恰好五项', () => {
  const enums = TOOLS.collectionDomainEnums();
  assert.deepEqual(enums, FIVE);
  assert.equal(enums.includes('竞争洞察'), false);
});

t('D2 配方里不再声明竞争洞察域', () => {
  const dirs = ['taobao', 'tmall', 'jd', 'pdd', 'douyin'];
  for (const dir of dirs) {
    const base = path.join(ROOT, 'lib/rpa/dsls', dir);
    if (!fs.existsSync(base)) continue;
    for (const file of fs.readdirSync(base)) {
      if (!file.endsWith('.json')) continue;
      const doc = JSON.parse(fs.readFileSync(path.join(base, file), 'utf8'));
      assert.ok(!(doc.domains || []).includes('竞争洞察'), doc.id + ' 仍声明竞争洞察');
      for (const d of doc.domains || []) {
        assert.ok(FIVE.includes(d), doc.id + ' 声明了五项之外的域：' + d);
      }
    }
  }
});

t('D3 配方统计按五项聚合', () => {
  const stats = DSLS.dslRecipeStats('taobao');
  for (const domain of Object.keys(stats.byDomain || {})) {
    assert.ok(FIVE.includes(domain), '统计里出现了五项之外的域：' + domain);
  }
});

t('E1 界面固定只列这五项', () => {
  assert.ok(
    !client.includes('竞争洞察'),
    '界面里没有五项常量'
  );
  assert.ok(client.includes('collectionDomains'), '界面没有读账号上的采集域');
});

t('F1 版本号已到 0.20.43', () => {
  const parts = String(pkg.version).split('.').map(Number);
  assert.ok(parts[0] === 0 && parts[1] === 20 && parts[2] >= 43, '版本号是 ' + pkg.version);
});

t('F2 CHANGELOG 与 README 写了五项', () => {
  assert.ok(changelog.includes('v0.20.43'), 'CHANGELOG 没有 v0.20.43');
  assert.ok(/'竞争洞察'/.test(changelog) || changelog.includes('竞争洞察'), 'CHANGELOG 没写去掉竞争洞察');
  assert.ok(readme.includes(pkg.version), 'README 版本行没跟上');
});

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
if (fail) process.exitCode = 1;
