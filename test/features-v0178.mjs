/**
 * v0.17.8 自检：浏览器设置简化（去掉介绍性文案）。
 *
 * 用户反馈：打开浏览器设置时看着乱，选项太多、夹着「回退」「检测」之类的解释，
 * 只想看到能改的东西。所以这一版把设置卡里的说明性文案收口：
 *   - 「浏览器后端」下拉框不再挂长悬停解释；
 *   - 胶囊不再挂长悬停说明；
 *   - 不再写「当前用 Chrome / 没检测到 ego lite」这类状态句（状态由胶囊与选项本身表达）；
 *   - 分组标题不再出现「回退」字样；
 *   - 起始端口的说明挪进 placeholder，勾选项文案缩短；
 *   - 店铺配置迁移、版本更新的说明句也去掉。
 *
 * 这个自检把这层语义钉死：可改的控件必须都在，多余的解释必须不在。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: String((err && err.message) || err) }); }
}

// 设置卡区域：从「浏览器设置」标题到「版本与更新」卡片之间
const start = clientSrc.indexOf("'浏览器设置'");
assert.ok(start > 0, '没找到「浏览器设置」这张卡片');
const end = clientSrc.indexOf("'版本与更新'", start);
assert.ok(end > start, '没找到「版本与更新」这张卡片（定位设置卡区域失败）');
const card = clientSrc.slice(start, end);

check('A1 设置卡里不再出现「回退」字样', () => {
  assert.ok(!card.includes('回退'), '「回退」这类说法应当去掉');
});

check('A2 设置卡里不再有任何常驻说明行，也没有「当前用…/生效：」这类状态句', () => {
  assert.ok(!card.includes('sa-hint'), '设置卡里不该再留常驻说明行');
  for (const bad of ['当前用 Chrome', '没检测到 ego lite']) {
    assert.ok(!card.includes(bad), `不该再出现「${bad}」这类说明句`);
  }
  for (const bad of ['当前用 Chrome', '生效：']) {
    assert.ok(!clientSrc.includes(bad), `客户端里不该再出现「${bad}」`);
  }
});

check('A3 下拉框与胶囊不挂长悬停解释', () => {
  assert.ok(!card.includes("title: '自动 = "), '后端下拉框不该再挂长解释');
  assert.ok(!card.includes("sa-chip', title:"), '胶囊不该再挂长解释');
  assert.ok(!card.includes('title: egoText'), '胶囊不该引用 egoText');
  // 该区域只允许「ego profile 名字」这一处 title（那是数据，不是解释）
  const titles = (card.match(/title:/g) || []).length;
  assert.ok(titles <= 1, `设置卡里 title 太多（${titles} 处），应当只留 profile 名字那一处`);
});

check('A4 「起始端口」的说明挪进 placeholder，不再单独起一行', () => {
  assert.ok(card.includes("placeholder: '9222 起顺延'"), '起始端口应有 placeholder 提示');
  assert.ok(!card.includes('留空 = 9222 起顺延'), '不该再在输入框下面另起一行写说明');
  assert.ok(!/h\('span', \{ style: subStyle \}, '留空 = 9222/.test(card), '不该再有多余的说明行');
});

check('A5 两个勾选项的文案缩短', () => {
  assert.ok(card.includes("'打开商品列表页'"), '打开时的勾选应短文案');
  assert.ok(card.includes("'正常退出浏览器'"), '关闭时的勾选应短文案');
  assert.ok(!card.includes('顺带打开商品列表页'), '旧的啰嗦文案应当去掉');
  assert.ok(!card.includes('先让浏览器自己退出'), '旧的啰嗦文案应当去掉');
});

check('A6 店铺配置迁移 / 版本更新不再写说明句', () => {
  assert.ok(!card.includes('只含店铺配置，不含密码与登录态。'), '迁移说明句应当去掉');
  assert.ok(!card.includes('还没检测过 ——'), '「还没检测过」这句应当去掉');
});

check('A7 该区域没有超过 40 个中文字符的说明字符串', () => {
  const literals = (card.match(/'[^'\n]{40,}'/g) || []).filter((s) => /[\u4e00-\u9fa5]/.test(s));
  const bad = literals.filter((s) => {
    // 允许的唯一长字符串是「没探测到 Chrome / Edge，请填完整路径」这类必要报错
    return !s.includes('请填完整路径');
  });
  assert.equal(bad.length, 0, `还有长段说明：${bad.join(' / ')}`);
});

check('B1 可改的控件都还在（v0.20.13 起后端由「用户浏览器」里选中的那一行决定，不再有下拉）', () => {
  const must = [
    "'用户浏览器'", "'重新扫描'", "'设为默认'",
    "'路径与高级选项'", "'ego-browser'", "'Chrome / Edge'", "'档案根目录'",
    "'起始端口'", "'打开时'", "'关闭时'", "'信息'", "'数据目录'",
    "'店铺配置迁移'", "'导出店铺配置'", "'导入店铺配置'", "'保存设置'",
  ];
  for (const m of must) assert.ok(card.includes(m), `设置卡少了控件：${m}`);
  assert.ok(!card.includes("label: '浏览器后端'"), '不该再有「浏览器后端」下拉');
});

check('B2 胶囊仍然显示当前生效后端（Chrome / ego lite）', () => {
  assert.ok(card.includes('chipText'), '胶囊文案变量应当保留');
  assert.ok(/var chipText = egoOn/.test(clientSrc), '胶囊文案应当按后端取值');
  assert.ok(clientSrc.includes(": 'Chrome';"), '胶囊在 Chrome 模式下要显示 Chrome');
});

check('C1 版本号 ≥ 0.17.8', () => {
  const [maj, min, pat] = String(pkg.version).split('.').map((n) => Number(n));
  assert.ok(maj === 0 && (min > 17 || (min === 17 && pat >= 8)), `版本号还是 ${pkg.version}`);
});

check('C2 变更记录与说明写了这一条', () => {
  assert.ok(changelog.includes('0.17.8'), 'CHANGELOG 里没有 0.17.8');
  assert.ok(changelog.includes('浏览器设置'), 'CHANGELOG 里没说明浏览器设置');
  assert.ok(readme.includes('0.17.8'), 'CHANGELOG 里没有 0.17.8');
});

const failed = results.filter((r) => !r.ok);
console.log(results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' — ' + r.error}`).join('\n'));
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) process.exit(1);
