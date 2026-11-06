#!/usr/bin/env node
/**
 * features-v0168.mjs —— v0.16.8：采集后处理能力按需执行 + 页面数字解码 + 页面文字转指标
 *
 * 背景：拼多多的采集配方声明了一个「后处理能力」（页面把数字渲染成私有区字符，
 * 需要按字形还原成阿拉伯数字）。旧版本把这个声明当成「本插件不支持」，
 * 编译期就直接拒绝，于是这家店铺的定时采集**每次**都失败——即使当次页面里
 * 根本没有需要还原的字符。
 *
 * 本套覆盖：
 *   A. 私有区码位收集 / 映射解码 / 嵌套文本改写 / 页面文字转指标（纯函数）
 *   B. 能力从「一律拒绝」改成「能做就做，做不了如实报」；未知能力仍然编译期拒绝
 *   C. 产物归集：`raw_envelope` 没有键 = 整份原始产物即交付物；`text_metrics` 直接带指标
 *   D. 跑完按需决定：干净文本跳过、可认出的解码、认不全的如实失败
 *   E. 页面取字形脚本的结构与接线（浏览器后端与运行时后端两份执行器都覆盖）
 *   F. 配方声明 + 版本号
 *
 * 零依赖、不起浏览器。跑法：node test/features-v0168.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-accounts-v0168-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = path.join(TMP, 'data');
process.env.SHOP_ACCOUNTS_DSL_DIR = '';

const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  \u2717 ' + name + '\n      ' + (err && err.message ? err.message : String(err)));
  }
}
const section = (t) => console.log('\n' + t);

const rpa = await import(url('lib/rpa.mjs'));
const pkg = JSON.parse(src('package.json'));
const pddSeed = JSON.parse(src('lib/rpa/dsls/pdd/pdd_shop_overview.json'));

// 页面文字的样本（真实结构：指标名紧跟今日值，随后 24 字内可能出现「昨日 N」）
const PAGE_TEXT = [
  '成交金额0.00趋势昨日 0.00较前一日 -100.00%',
  '成交订单数0昨日 0',
  '商品访客数4昨日 6',
  '商品浏览量5昨日 9',
  '商品评价数0昨日 0',
  '待付款0待发货0待收货199',
].join(' ');

// ── A. 纯函数 ────────────────────────────────────────────────────────────
section('A. 私有区码位 / 映射解码 / 嵌套改写 / 页面文字转指标');

await test('privateUseCodes：只挑出私有区码位，按码位排序去重', () => {
  const codes = rpa.privateUseCodes('今日 \ue3f7 单 \uea76 笔 \ue3f7');
  assert.deepEqual(codes, ['U+E3F7', 'U+EA76']);
  assert.deepEqual(rpa.privateUseCodes('全是普通数字 123'), []);
});

await test('decodePrivateUseText：有映射就换成数字，映射键不带 U+ 前缀', () => {
  const mapping = { E3F7: '1', EA76: '8' };
  assert.equal(rpa.decodePrivateUseText('\ue3f7\uea76', mapping), '18');
  assert.equal(rpa.decodePrivateUseText('1\ue3f7', mapping), '11');
});

await test('decodePrivateUseText：映射缺位就留 [?U+XXXX]，不猜数字', () => {
  assert.equal(rpa.decodePrivateUseText('\ue3f7\ue111', { E3F7: '1' }), '1[?U+E111]');
});

await test('mapOutputTexts：嵌套对象/数组里的文本叶子逐个改写', () => {
  const root = { a: '\ue3f7', b: ['x\uea76', { c: '\ue3f7\uea76' }], n: 7 };
  const replaced = rpa.mapOutputTexts(root, (t) => rpa.decodePrivateUseText(t, { E3F7: '1', EA76: '8' }));
  assert.equal(replaced, 3);
  assert.equal(root.a, '1');
  assert.equal(root.b[0], 'x8');
  assert.equal(root.b[1].c, '18');
  assert.equal(root.n, 7);
});

await test('collectPrivateUseCodes：跨嵌套输出汇总码位', () => {
  const out = { home_text: '\ue3f7', nested: { list: ['\uea76', 'plain'] } };
  assert.deepEqual(rpa.collectPrivateUseCodes(out), ['U+E3F7', 'U+EA76']);
});

await test('parseTextMetrics：今日值与昨日值都取到', () => {
  const spec = {
    metrics: [
      { id: 'gmv', label: '成交金额' },
      { id: 'pay_ord_cnt', label: '成交订单数' },
      { id: 'uv', label: '商品访客数' },
      { id: 'pv', label: '商品浏览量' },
      { id: 'comment_cnt', label: '商品评价数' },
      { id: 'todo_unreceived', label: '待收货' },
    ],
  };
  const r = rpa.parseTextMetrics(PAGE_TEXT, spec);
  assert.equal(r.values.gmv, 0);
  assert.equal(r.values.uv, 4);
  assert.equal(r.values.pv, 5);
  assert.equal(r.values.comment_cnt, 0);
  assert.equal(r.values.todo_unreceived, 199);
  assert.equal(r.yesterday.uv, 6);
  assert.equal(r.yesterday.pv, 9);
  assert.deepEqual(r.missing, []);
});

await test('parseTextMetrics：页面上没有的指标进 missing，不编造 0', () => {
  const spec = { metrics: [{ id: 'uv', label: '商品访客数' }, { id: 'ad_cost', label: '推广花费' }] };
  const r = rpa.parseTextMetrics(PAGE_TEXT, spec);
  assert.equal(r.values.uv, 4);
  assert.ok(!Object.prototype.hasOwnProperty.call(r.values, 'ad_cost'));
  assert.deepEqual(r.missing, ['ad_cost']);
});

// ── B. 能力门控 ──────────────────────────────────────────────────────────
section('B. 后处理能力：能做就做，做不了如实报；未知能力仍然编译期拒绝');

await test('能力清单里有 pdd_decrypt（不再当成不支持）', () => {
  assert.equal(rpa.SUPPORTED_CAPABILITIES.has('pdd_decrypt'), true);
});

await test('编译拼多多配方不再抛错，且带上 postprocess 声明', () => {
  const compiled = rpa.compileExecution(pddSeed, { start: '2026-10-04', end: '2026-11-02', runId: 'r168' });
  assert.equal(compiled.dslId, 'pdd_shop_overview');
  assert.deepEqual(compiled.postprocess, ['pdd_decrypt']);
  assert.ok(compiled.ops.length > 0);
  assert.ok(Array.isArray(compiled.declaredArtifacts) && compiled.declaredArtifacts.length >= 2);
});

await test('声明了本插件确实没有的能力 → 编译期就拒（UNSUPPORTED_CAPABILITY）', () => {
  const seeded = JSON.parse(JSON.stringify(pddSeed));
  seeded.collection.capabilities.after = ['pdd_decrypt', 'unknown_fancy_decrypt'];
  assert.throws(
    () => rpa.compileExecution(seeded, { start: '2026-10-04', end: '2026-11-02', runId: 'r168b' }),
    (err) => err.code === 'UNSUPPORTED_CAPABILITY' && Array.isArray(err.unsupported) && err.unsupported.includes('unknown_fancy_decrypt'),
  );
});

// ── C. 产物归集 ──────────────────────────────────────────────────────────
section('C. 产物归集：raw_envelope 无键 = 整份产物；text_metrics 直接带指标');

await test('text_metrics：把页面文字解析成指标挂在 records 上', () => {
  const artifacts = pddSeed.collection.artifacts;
  const out = { home_text: PAGE_TEXT };
  const got = rpa.collectArtifacts({ collection: { artifacts } }, out);
  const tm = got.find((a) => a.kind === 'text_metrics');
  assert.ok(tm, '应当产出 text_metrics');
  assert.equal(tm.present, true);
  assert.equal(tm.domain, '经营总览');
  assert.equal(tm.records.values.uv, 4);
  assert.equal(tm.records.yesterday.uv, 6);
});

await test('raw_envelope 没有 output_key：只要有产物就算「观测到了」', () => {
  const artifacts = pddSeed.collection.artifacts;
  const got = rpa.collectArtifacts({ collection: { artifacts } }, { home_text: PAGE_TEXT });
  const env = got.find((a) => a.kind === 'raw_envelope');
  assert.ok(env);
  assert.equal(env.present, true);
  assert.ok(env.bytes > 0);
});

await test('raw_envelope 没有 output_key：一个产物都没有就算「空」', () => {
  const artifacts = pddSeed.collection.artifacts;
  const got = rpa.collectArtifacts({ collection: { artifacts } }, {});
  const env = got.find((a) => a.kind === 'raw_envelope');
  assert.equal(env.present, false);
  const tm = got.find((a) => a.kind === 'text_metrics');
  assert.equal(tm.present, false);
});

// ── D. 跑完按需决定 ──────────────────────────────────────────────────────
section('D. 跑完按需决定：干净文本跳过 / 可认出则解码 / 认不全则如实失败');

function textDriver(text, fontResult) {
  return {
    async goto(u) { return { url: u }; },
    async evaluate(expr) {
      const e = String(expr);
      if (e.includes('document.fonts')) return fontResult;
      return { found: true, text };
    },
    async find() { return { found: true }; },
    async click() { return { ok: true }; },
    async readText() { return { text }; },
    async sleep() {},
    async currentUrl() { return 'about:blank'; },
  };
}

const outOps = [{ op: 'eval', stepId: 'read-home', expr: 'x', outputKey: 'home_text' }];

await test('文本里没有私有区字符 → 后处理跳过（不下载字体、不瞎报错）', async () => {
  const compiled = { ops: outOps, postprocess: ['pdd_decrypt'], declaredArtifacts: pddSeed.collection.artifacts };
  const res = await rpa.runOps(compiled, textDriver(PAGE_TEXT, {}), {});
  assert.equal(res.ok, true);
  assert.equal(res.postprocess.pdd_decrypt.action, 'skip');
  assert.equal(res.postprocess.pdd_decrypt.reason, 'no-private-use-characters');
  assert.equal(res.outputs.home_text.includes('商品访客数4'), true);
});

await test('有私有区字符且字形认得全 → 解码后继续交付', async () => {
  const compiled = { ops: outOps, postprocess: ['pdd_decrypt'], declaredArtifacts: [] };
  const res = await rpa.runOps(compiled, textDriver('商品访客数\ue3f7昨日 \uea76', { ok: true, mapping: { E3F7: '4', EA76: '6' } }), {});
  assert.equal(res.ok, true);
  assert.equal(res.postprocess.pdd_decrypt.action, 'decrypt');
  assert.equal(res.outputs.home_text, '商品访客数4昨日 6');
});

await test('有私有区字符但没认出任何字形 → 报 PDD_FONT_DECRYPT_FAILED，不当业务数据', async () => {
  const compiled = { ops: outOps, postprocess: ['pdd_decrypt'], declaredArtifacts: [] };
  const res = await rpa.runOps(compiled, textDriver('商品访客数\ue3f7', { ok: true, mapping: {} }), {});
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PDD_FONT_DECRYPT_FAILED');
  assert.match(String(res.error), /字形/);
});

await test('认出一部分、剩下的还原不了 → 也算失败并列出残留码位', async () => {
  const compiled = { ops: outOps, postprocess: ['pdd_decrypt'], declaredArtifacts: [] };
  const res = await rpa.runOps(
    compiled,
    textDriver('客\ue3f7 单\ue111', { ok: true, mapping: { E3F7: '4' } }),
    {},
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PDD_FONT_DECRYPT_FAILED');
  assert.equal(res.postprocess.pdd_decrypt.action, 'decrypt-partial');
  assert.deepEqual(res.postprocess.pdd_decrypt.remaining, ['U+E111']);
});

// ── E. 页面取字形脚本与两份执行器 ────────────────────────────────────────
section('E. 页面取字形脚本的结构与两份执行器的接线');

await test('FONT_DECODE_EXPR_FN 是合法 JS，且只依赖页面已加载的字体', () => {
  assert.equal(typeof rpa.FONT_DECODE_EXPR_FN, 'string');
  const fn = new Function('return (' + rpa.FONT_DECODE_EXPR_FN + ');')();
  assert.equal(typeof fn, 'function');
  assert.match(rpa.FONT_DECODE_EXPR_FN, /document\.fonts/);
  assert.match(rpa.FONT_DECODE_EXPR_FN, /getImageData/);
  // 不落网络：不需要下载字体文件、不需要外部依赖
  assert.ok(!/fetch\(|XMLHttpRequest|require\(/.test(rpa.FONT_DECODE_EXPR_FN));
});

await test('fontDecodeExpression：把码位列表内联进表达式并直接调用', () => {
  const expr = rpa.fontDecodeExpression(['U+E3F7', 'U+EA76']);
  assert.match(expr, /"U\+E3F7"/);
  assert.match(expr, /"U\+EA76"/);
  assert.ok(expr.includes(rpa.FONT_DECODE_EXPR_FN));
});

await test('浏览器后端执行器里有后处理分支', () => {
  const s = src('lib/rpa.mjs');
  assert.ok(s.includes("SUPPORTED_CAPABILITIES = new Set(['pdd_decrypt'])"));
  assert.ok(s.includes('collectPrivateUseCodes(outputs)'));
  assert.ok(s.includes('decrypt-partial'));
});

await test('运行时后端（ego）那份执行器也带同样的后处理逻辑', () => {
  const s = src('lib/rpa.mjs');
  const egoPart = s.slice(s.indexOf('export const EGO_EXECUTOR_SOURCE'));
  assert.ok(egoPart.includes('__puaCodes'));
  assert.ok(egoPart.includes('__applyDecode'));
  assert.ok(egoPart.includes('postprocess'));
  assert.ok(egoPart.includes('PDD_FONT_DECRYPT_FAILED'));
});

await test('ego 跑配方时把 postprocess 声明与产物归集一起带上', () => {
  const s = src('lib/ego.mjs');
  assert.ok(s.includes('postprocess'));
  assert.ok(s.includes('collectArtifacts'));
});

await test('页面路由把配方元信息（dslId/declaredArtifacts/postprocess）传到执行器', () => {
  const s = src('lib/index.js');
  assert.ok(s.includes('compiledInfo = {}'));
  assert.ok(s.includes('postprocess: Array.isArray(task.postprocess)'));
});

// ── F. 配方声明与版本 ────────────────────────────────────────────────────
section('F. 配方声明与版本号');

await test('拼多多配方：页面文字 → 经营总览指标（14 项），并保留原始产物', () => {
  const arts = pddSeed.collection.artifacts;
  const tm = arts.find((a) => a.kind === 'text_metrics');
  assert.equal(tm.output_key, 'home_text');
  assert.equal(tm.domain, '经营总览');
  assert.equal(tm.metrics.length, 14);
  const ids = tm.metrics.map((m) => m.id);
  for (const id of ['gmv', 'pay_ord_cnt', 'ad_cost', 'uv', 'pv', 'comment_cnt', 'todo_unpaid', 'todo_unshipped', 'todo_unreceived', 'todo_tickets', 'goods_check_score', 'service_score', 'experience_star', 'consult_cvr']) {
    assert.ok(ids.includes(id), '缺指标 ' + id);
  }
  assert.ok(arts.some((a) => a.kind === 'raw_envelope'));
});

await test('版本号与文档已覆盖 0.16.8', () => {
  // 版本会用「≥」而不是钉死具体版本：后续版本不该把这条用例弄红（v0.16.9 就是这么修的）。
  const [maj, min, patch] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 16 || (min === 16 && patch >= 8)), '版本号应 ≥0.16.8，实际 ' + pkg.version);
  const changelog = src('CHANGELOG.md');
  assert.ok(changelog.includes('0.16.8'));
});

console.log('\n' + (failures.length ? '\u2717 ' + failures.length + ' failed' : '\u2713 all passed') + ' (' + passed + ' checks)');
if (failures.length) {
  console.error(failures.map((f) => f.name + ': ' + (f.err && f.err.stack ? f.err.stack : f.err)).join('\n\n'));
  process.exit(1);
}
