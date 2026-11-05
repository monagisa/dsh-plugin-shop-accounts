/**
 * v0.18.5 自检：新增店铺的表单按「平台 + 身份」给提示。
 *
 * 现场（2026-11-05，用户反馈）：选了「买家账号」，平台卡片下面还写着「千牛工作台（卖家端）」；
 * 「登录账号」一栏的标题/占位/报错是通用一句「手机号 / 旺旺名 / 邮箱」，抖店卖家明明必须填邮箱。
 * 现在：身份先选 → 平台卡片小字跟着身份变；「登录账号」的标题、占位、必填报错都按平台+身份给。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const P = await import(pathToFileURL(path.join(ROOT, 'lib/platforms.mjs')).href);
const clientSrc = read('lib/client.js');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  }
}

function versionAtLeast(actual, floor) {
  const a = String(actual).split('.').map(Number);
  const b = String(floor).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

const SELLER_TAGS = {
  pdd: '手机号 / 账号名',
  taobao: '旺旺名',
  tmall: '旺旺名',
  douyin: '登录邮箱',
  jd: '京麦账号',
  ali1688: '会员名',
};
const BUYER_TAGS = {
  taobao: '用户名 / 手机号',
  tmall: '用户名 / 手机号',
  jd: '用户名 / 手机号',
  ali1688: '会员名',
  douyin: '手机号',
};
// 买家提示里绝不能出现卖家/后台的说法：「卖家」「商家」「后台」「工作台」「千牛」「抖店」「京麦」
const SELLER_WORDS = /卖家|商家|后台|工作台|千牛|抖店|京麦/;

// ── A. 服务端：每个平台、每种身份都有各自的短标签 ───────────────────────────────

test('A1 卖家短标签按平台区分（抖店 = 登录邮箱）', () => {
  for (const [id, tag] of Object.entries(SELLER_TAGS)) {
    assert.equal(P.loginNameTagOf(id, 'seller'), tag, id + ' 的卖家短标签不对');
  }
});

test('A2 买家短标签按平台区分，且不含卖家说法', () => {
  for (const [id, tag] of Object.entries(BUYER_TAGS)) {
    const got = P.loginNameTagOf(id, 'buyer');
    assert.equal(got, tag, id + ' 的买家短标签不对');
    assert.ok(!SELLER_WORDS.test(got), id + ' 的买家短标签里出现了卖家说法：' + got);
  }
});

test('A3 买家短标签不继承卖家的那份（淘宝买家不是「旺旺名」）', () => {
  // variantOf 是 {...platform, ...buyer} 展开，展开后总会带上卖家的短标签 —— 买家必须单独取
  assert.notEqual(P.loginNameTagOf('taobao', 'buyer'), P.loginNameTagOf('taobao', 'seller'));
  assert.notEqual(P.loginNameTagOf('douyin', 'buyer'), P.loginNameTagOf('douyin', 'seller'));
  const src = read('lib/platforms.mjs');
  const at = src.indexOf('export function loginNameTagOf');
  assert.ok(at > 0, '找不到 loginNameTagOf');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.ok(body.includes('const buyer = BUYER_VARIANTS[id]'), '买家短标签没有直接读 BUYER_VARIANTS');
});

test('A4 没有买家身份的平台（拼多多）短标签为空，未知平台也为空', () => {
  assert.equal(P.loginNameTagOf('pdd', 'buyer'), '');
  assert.equal(P.loginNameTagOf('bogus', 'seller'), '');
});

test('A5 capabilitiesOf 把短标签一起下发（抖店卖家 = 登录邮箱、买家 = 手机号）', () => {
  assert.equal(P.capabilitiesOf('douyin', 'seller').loginNameTag, '登录邮箱');
  assert.equal(P.capabilitiesOf('douyin', 'buyer').loginNameTag, '手机号');
  assert.equal(P.capabilitiesOf('pdd', 'seller').loginNameTag, '手机号 / 账号名');
});

test('A6 平台卡片小字：卖家/买家两份文案都有，买家那份不含卖家说法', () => {
  const list = P.platformList();
  assert.equal(list.length, 6, '平台数量不是 6');
  for (const p of list) {
    assert.ok(String(p.accountHint || '').length > 0, p.id + ' 没有卖家 accountHint');
    assert.ok(String(p.buyerHint || '').length > 0, p.id + ' 没有 buyerHint');
    if (p.accountTypes.includes('buyer')) {
      assert.ok(p.buyerHint.includes('买家'), p.id + ' 的 buyerHint 没提买家：' + p.buyerHint);
      assert.ok(!SELLER_WORDS.test(p.buyerHint), p.id + ' 的 buyerHint 里出现了卖家说法：' + p.buyerHint);
    }
  }
  // 天猫买家的入口说明在既有测试里被断言过，别改掉
  assert.ok(P.platformList().find((p) => p.id === 'tmall').buyerHint.includes('淘宝登录页'));
  assert.ok(P.platformList().find((p) => p.id === 'pdd').buyerHint.includes('没有买家账号'));
});

test('A7 卖家 accountHint 带上了登录线索（抖音写邮箱）', () => {
  const list = P.platformList();
  for (const id of Object.keys(SELLER_TAGS)) {
    const p = list.find((x) => x.id === id);
    assert.ok(p.accountHint.includes('· '), id + ' 的卖家 accountHint 没带「· 」登录线索');
  }
  assert.ok(list.find((p) => p.id === 'douyin').accountHint.includes('邮箱'), '抖音卖家的 accountHint 没提邮箱');
});

// ── B. 客户端：身份在前，卡片小字/登录账号字段跟着变 ─────────────────────────────

test('B1 平台卡片小字走 platformCardHint（按身份取 accountHint / buyerHint）', () => {
  assert.ok(clientSrc.includes('function platformCardHint(platforms, p, type)'), '没有 platformCardHint');
  assert.ok(clientSrc.includes("(m && m.buyerHint) || p.buyerHint"), '买家小字没有优先用服务端 buyerHint');
  assert.ok(clientSrc.includes("(m && m.accountHint) || p.hint"), '卖家小字没有优先用服务端 accountHint');
  assert.ok(clientSrc.includes('platformCardHint(props.platforms, p, type)'), '平台卡片没接 platformCardHint');
});

test('B2 本文件里的 PLATFORMS 兜底也分卖家/买家两份', () => {
  const at = clientSrc.indexOf('var PLATFORMS = [');
  assert.ok(at > 0, '找不到 PLATFORMS');
  const block = clientSrc.slice(at, clientSrc.indexOf('];', at));
  const buyerHints = (block.match(/buyerHint:/g) || []).length;
  assert.equal(buyerHints, 6, 'PLATFORMS 里 buyerHint 只有 ' + buyerHints + ' 份');
});

test('B3 「账号类型」排在平台卡片之前（先选身份，小字才不会写错）', () => {
  const typeAt = clientSrc.indexOf("h(Field, { label: '账号类型' }");
  const cardsAt = clientSrc.indexOf("className: 'sa-plats'");
  assert.ok(typeAt > 0, '弹窗里找不到「账号类型」');
  assert.ok(cardsAt > typeAt, '「账号类型」仍排在平台卡片之后');
  // 旧的「登录密码」之后那份重复的账号类型已经删掉了，弹窗里只该剩一份
  const dialogStart = clientSrc.indexOf('function AccountDialog');
  const dialogEnd = clientSrc.indexOf('function AccountDetail');
  const inDialog = clientSrc.slice(dialogStart, dialogEnd);
  assert.equal((inDialog.match(/label: '账号类型'/g) || []).length, 1, '弹窗里「账号类型」出现了不止一次');
});

test('B4 弹窗标题跟着身份变（新增买家账号 / 新增卖家账号）', () => {
  assert.ok(clientSrc.includes("type === 'buyer' ? '新增买家账号' : '新增卖家账号'"), '弹窗标题没按身份分');
});

test('B5 「登录账号」表头只写必填，平台填什么放占位里', () => {
  assert.ok(clientSrc.includes('function loginTagOf(platforms, id, type)'), '没有 loginTagOf');
  assert.ok(clientSrc.includes('var loginTag = loginTagOf(props.platforms, platform, type);'), '新建弹窗没取 loginTag');
  assert.ok(clientSrc.includes("h(Field, { label: '登录账号（必填）' }"), '字段标题不是「登录账号（必填）」');
  assert.ok(!clientSrc.includes("' · ' + loginTag"), '表头里还拼着平台说明');
  assert.ok(clientSrc.includes("placeholder: loginTag ? ('例如：' + loginTag)"), '占位没带短标签');
  assert.ok(clientSrc.includes("props.onError('「登录账号」必填');"), '必填报错不够简短');
});

test('B8 登录方式排在表单最上面（在账号类型 / 平台之前）', () => {
  const mode1 = clientSrc.indexOf("canPassword && h(Field, { label: '登录方式' }");
  const mode2 = clientSrc.indexOf("!canPassword && h(Field, { label: '登录方式' }");
  const typeAt = clientSrc.indexOf("h(Field, { label: '账号类型' }");
  const cardsAt = clientSrc.indexOf("className: 'sa-plats'");
  assert.ok(mode1 > 0 && mode2 > 0, '找不到「登录方式」两种形态');
  assert.ok(mode1 < typeAt && mode2 < typeAt, '「登录方式」仍排在账号类型之后');
  assert.ok(mode1 < cardsAt && mode2 < cardsAt, '「登录方式」仍排在平台卡片之后');
});

test('B9 输入框下面不再挂长说明（登录账号那一行 + 平台选择那行）', () => {
  assert.ok(!clientSrc.includes('账号只用来区分是哪个登录身份，不要填密码'), '登录账号下面还挂着说明');
  assert.ok(!clientSrc.includes("'选择平台（'"), '平台卡片上面还挂着「选择平台（…）」');
  assert.ok(clientSrc.includes("h(Field, { label: '平台' }"), '平台这一块没有表头');
});

test('B6 详情页的「账号」一行也按平台+身份给占位', () => {
  assert.ok(clientSrc.includes('var loginTag = loginTagOf(props.platforms, a.platform, type);'), '详情页没取 loginTag');
  assert.ok(clientSrc.includes("loginTag ? ('例如：' + loginTag) : '登录账号名，例如 主账号;子账号'"), '详情页占位没按平台');
});

test('B7 身份选项只写「卖家账号 / 买家账号」，不再把解释塞进表头', () => {
  const at = clientSrc.indexOf('function accountTypeOptionLabel');
  assert.ok(at > 0, '找不到 accountTypeOptionLabel');
  const body = clientSrc.slice(at, clientSrc.indexOf('\n    }', at));
  assert.ok(body.includes("return type === 'buyer' ? '买家账号' : '卖家账号'"), '身份选项还带着解释文字');
  assert.ok(!body.includes('可上架'), '还留着带解释的卖家选项');
  assert.ok(!body.includes('只做浏览与采集'), '还留着带解释的买家选项');
});

// ── C. 文档 ───────────────────────────────────────────────────────────────────

test('C1 版本号已到 0.18.7', () => {
  assert.ok(versionAtLeast(pkg.version, '0.18.7'), '版本还停在 ' + pkg.version);
});

test('C2 CHANGELOG / README 写了这次改动', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('v0.18.5'), 'CHANGELOG 没写 v0.18.5');
  assert.ok(changelog.includes('买家') && changelog.includes('登录账号'), 'CHANGELOG 没说明表单提示的改动');
  assert.ok(changelog.includes('v0.18.7'), 'CHANGELOG 没写 v0.18.7 的精简');
  const readme = read('README.md');
  assert.ok(readme.includes('0.18.5'), 'README 没写 0.18.5');
  assert.ok(readme.includes('0.18.7'), 'README 没跟上 0.18.7');
  assert.ok(readme.includes('登录账号'), 'README 没提「登录账号」的提示');
});

console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败`);
  for (const f of failures) console.log('  - ' + f.name + ': ' + (f.err && f.err.message));
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
