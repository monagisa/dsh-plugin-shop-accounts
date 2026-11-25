import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sa-v02069-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = TMP;

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + String(extra))); }
}

const { normalizeBizDate, buildDashboard } = await import('file:///' + path.resolve('lib/dashboard.mjs').replace(/\\/g, '/'));
const { writeWorkbook } = await import('file:///' + path.resolve('lib/xlsx.mjs').replace(/\\/g, '/'));
const { collectionDirName, collectionRoot } = await import('file:///' + path.resolve('lib/collection-dir.mjs').replace(/\\/g, '/'));

console.log('A 日期归一');
check('A1 2026-11-24 原样', normalizeBizDate('2026-11-24') === '2026-11-24', normalizeBizDate('2026-11-24'));
check('A2 20261124 紧凑格式', normalizeBizDate('20261124') === '2026-11-24', normalizeBizDate('20261124'));
check('A3 2026/11/24 斜杠', normalizeBizDate('2026/11/24') === '2026-11-24', normalizeBizDate('2026/11/24'));
check('A4 空值返回空串', normalizeBizDate('') === '' && normalizeBizDate(null) === '');
check('A5 非法文本返回空串', normalizeBizDate('合计') === '');

console.log('B 构造样例工作簿');
const ACC = { id: 'acc_t1_v02069', name: '示例店铺', platform: 'taobao', accountType: 'seller' };
const dirName = collectionDirName(ACC);
const jobDir = path.join(collectionRoot(), dirName, 'jobs', 'job_20261125-1200_abc123_示例店铺_样例');
fs.mkdirSync(path.join(jobDir, 'artifacts'), { recursive: true });
const bookPath = path.join(jobDir, 'artifacts', '采集数据_20261125-1200_示例店铺.xlsx');
const header = ['统计日期', '店铺名称', '访客数', '支付金额', '支付买家数', '成功退款金额', '全站推广花费', '净支付金额'];
const rows = [header];
for (let i = 1; i <= 3; i += 1) {
  rows.push(['2026-11-' + String(20 + i).padStart(2, '0'), '示例店铺', String(100 * i), String(50 * i), String(5 * i), String(10 * i), String(20), String(40 * i)]);
}
const detailRows = [['统计日期', '商品ID', '成功退款金额'], ['2026-11-21', '1001', '99']];
const dimRows = [
  ['日期', '载体类型', '支付金额', '访客数'],
  ['20261121', '全部', '100', '10'],
  ['20261121', '部分', '999', '99'],
];
writeWorkbook(bookPath, [
  { name: '经营总览', rows },
  { name: '商品供给', rows: detailRows },
  { name: '经营总览-成交分析', rows: dimRows },
]);
check('B1 样例工作簿已生成', fs.existsSync(bookPath), bookPath);

console.log('C 看板聚合');
const board = buildDashboard({ accounts: [ACC], store: 'all', days: 7, to: '2026-11-23', now: new Date('2026-11-25T00:00:00') });
check('C1 ok=true', board.ok === true);
check('C2 有一家店进了 stores', board.stores.length === 1 && board.stores[0].name === '示例店铺', JSON.stringify(board.stores));
const byKey = {};
for (const c of board.cards) byKey[c.key] = c;
check('C3 8 张指标卡', board.cards.length === 8, board.cards.length);
check('C4 成交金额出数（经营总览三天 50+100+150 = 300）', byKey.gmv.complete === true && byKey.gmv.value === 300, byKey.gmv.value);
check('C5 退款金额出数（三天 10+20+30 = 60）', byKey.refund.complete === true && byKey.refund.value === 60, byKey.refund.value);
check('C6 推广花费出数（三天各 20 = 60）', byKey.adCost.value === 60, byKey.adCost.value);
check('C7 销售收入 = 成交 - 退款 = 240', byKey.income.value === 240, byKey.income.value);
check('C8 访客数合计 600', byKey.visitors.value === 600, byKey.visitors.value);
check('C9 支付买家数合计 30', byKey.buyers.value === 30, byKey.buyers.value);
check('C10 客单价 = 300/30 = 10', byKey.aov.value === 10, byKey.aov.value);
check('C11 转化率展示为百分数 5.00%', byKey.convRate.valueText === '5.00%', byKey.convRate.valueText);
check('C12 转化率内部是小数 0.05', byKey.convRate.value === 0.05, byKey.convRate.value);
check('C13 金额展示带 ¥', byKey.gmv.valueText === '¥300.00', byKey.gmv.valueText);
check('C14 商品明细表被跳过（退款只算 60，不含明细里的 99）', byKey.refund.value === 60, byKey.refund.value);
check('C15 维度表只算「全部」行且同日先到先得（成交不含 999）', byKey.gmv.value === 300, byKey.gmv.value);
check('C16 走势长度 = 7 天', byKey.gmv.series.length === 7, byKey.gmv.series.length);
check('C17 有走势数据点', byKey.gmv.series.some((v) => typeof v === 'number'), JSON.stringify(byKey.gmv.series));
check('C18 日期范围默认截止昨天', board.range.end === '2026-11-23', board.range.end);
check('C19 近 7 天起始 = 2026-11-17', board.range.start === '2026-11-17', board.range.start);
check('C20 上期区间存在', Boolean(board.prevRange && board.prevRange.start), JSON.stringify(board.prevRange));
check('C21 单店过滤生效', buildDashboard({ accounts: [ACC], store: 'acc_nope', days: 7, to: '2026-11-23' }).stores.length === 0);
check('C22 没有卖家账号时有 notes', buildDashboard({ accounts: [{ id: 'x', name: '买家', platform: 'douyin', accountType: 'buyer' }] }).notes.includes('还没有卖家店铺账号'));

console.log('D 路由与前端接线');
const routesSrc = fs.readFileSync(path.resolve('lib/server/routes.mjs'), 'utf8').replace(/\r\n/g, '\n');
check('D1 有 GET /dashboard 路由', routesSrc.includes("method === 'GET' && p === '/dashboard'"));
check('D2 路由调用 buildDashboard', routesSrc.includes('buildDashboard({'));
check('D3 路由支持 store/days/from/to', routesSrc.includes("q.get('store')") && routesSrc.includes("q.get('days')") && routesSrc.includes("q.get('from')"));
check('D4 routes.mjs 导入了 dashboard 模块', routesSrc.includes("from '../dashboard.mjs'"));
const clientSrc = fs.readFileSync(path.resolve('lib/client.js'), 'utf8').replace(/\r\n/g, '\n');
check('D5 前端有 DashboardPanel', clientSrc.includes('function DashboardPanel()'));
check('D6 前端调用 /dashboard', clientSrc.includes("api('/dashboard?days='"));
check('D7 前端有指标卡样式', clientSrc.includes('.sa-dashgrid{') && clientSrc.includes('.sa-dashcard{'));
check('D8 看板插在账号页面里', clientSrc.includes("!detail && h(DashboardPanel,"));
check('D9 占位态文案存在', clientSrc.includes('数据不完整') && clientSrc.includes('无法比较 上期'));
check('D10 页面页签存在', clientSrc.includes('多平台经营看板') && clientSrc.includes('单店数据看板'));

console.log('E 版本与文档');
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const ver = String(pkg.version || '');
const [maj, min, patch] = ver.split('.').map((x) => Number(x));
check('E1 版本 ≥ 0.20.69', maj > 0 || (min === 20 && patch >= 69), ver);
const change = fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8');
check('E2 CHANGELOG 有 0.20.69 段', /##\s+v?0\.20\.69/.test(change));
check('E3 CHANGELOG 说明数据看板', change.includes('数据看板'));
const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
check('E4 README 版本行与 package.json 一致', readme.includes('当前版本 **' + ver + '**'), ver);
check('E5 package.json 有 features81 别名', Boolean(pkg.scripts && pkg.scripts.features81));

console.log('\nfeatures-v02069: ' + pass + ' pass, ' + fail + ' fail');
if (fail > 0) process.exitCode = 1;
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
