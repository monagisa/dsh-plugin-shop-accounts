#!/usr/bin/env node
/**
 * features-v0161.mjs —— v0.16.1：界面文案精简 + 占位符不暴露用户信息
 *
 * 需求：去掉大段提示文字，输入框提示也不要透露本机信息。
 *
 * 两件事：
 *   1. 详情页/弹窗里那些三四行的大段说明（"密码只保存在本机（…文件 …），不进账号表、不上传。打开店铺时会…"）
 *      全删了，只留能指导操作的一句话；不该出现的整段直接去掉。
 *   2. 占位符里原来拿使用者的真实数据当例子（真实店铺名、人名、登录账号），还有本机路径
 *      （ego.cli / browser.path / 数据目录 / 源码目录）直接塞进 placeholder —— 都换成中性文案。
 *
 * 本套是**源码级回归**：以后谁再往界面里塞长段落或真实信息，这里会炸。
 * 跑法：node test/features-v0161.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('  \u2713 ' + name); }
  catch (err) { failures.push({ name, err }); console.log('  \u2717 ' + name + '\n      ' + (err && err.message ? err.message : String(err))); }
}
const section = (t) => console.log('\n' + t);

// ── A. 占位符不暴露用户信息 ─────────────────────────────────────────────────
section('A. 输入框占位符：不许出现真实店铺名 / 人名 / 本机路径');

test('占位符里没有本机绝对路径与邮箱', () => {
  for (const bad of ['C:\\Users\\', 'C:/Users/', '/Users/', '@qq.com', '@gmail.com']) {
    assert.equal(clientSrc.includes(bad), false, '占位符里还留着本机信息：' + bad);
  }
});

test('店铺名 / 备注 / 账号的占位符是中性的例子', () => {
  assert.match(clientSrc, /'例如：某品牌旗舰店（留空自动起名）'/);
  assert.match(clientSrc, /'例如：用户名（留空自动起名）'/);
  assert.match(clientSrc, /'例如：平台·店铺·运营（选填）'/);
  assert.match(clientSrc, /'例如：平台·用户·用途（选填）'/);
  assert.match(clientSrc, /'登录账号名，例如 主账号;子账号'/);
});

test('本机路径不再进占位符（ego.cli / browser.path / 数据目录 / 源码目录）', () => {
  assert.equal(clientSrc.includes('placeholder: ego.cli ||'), false, 'ego 路径还在占位符里');
  assert.equal(clientSrc.includes('placeholder: browser.path ||'), false, '浏览器路径还在占位符里');
  assert.equal(clientSrc.includes("placeholder: (state.data && state.data.dataDir"), false, '数据目录还在占位符里');
  assert.equal(clientSrc.includes('placeholder: detectedDir ||'), false, '源码目录还在占位符里');
  // 换成了固定文案
  assert.ok(clientSrc.split("placeholder: '留空 = 自动探测'").length - 1 >= 2, '路径类输入框要有统一的中性占位符');
  assert.ok(clientSrc.includes("placeholder: '留空 = <数据目录>\\\\profiles'"), '档案根目录要给中性占位符');
});

test('密码库里那条真实文件路径不再出现在界面上', () => {
  assert.equal(/props\.vault\.path/.test(clientSrc), false, '把本机密码库文件路径显示在界面上了');
});

// ── B. 大段说明已删除 ───────────────────────────────────────────────────────
section('B. 那些很大段的说明文字已经删掉');

const REMOVED = [
  ['账号与密码都必填（和', '新增店铺弹窗的三行密码说明'],
  ['卖家走千牛 / mms / 抖店 / 京麦 / 1688 卖家入口', '账号类型的两行说明'],
  ['填入已登录过的 Chrome 用户目录可以直接复用它的登录态', '浏览器目录说明'],
  ['上架流程靠这个端口复用登录态', '调试端口说明'],
  ['插件只维护「采什么、什么时候采」', '采集卡片开场说明'],
  ['下面只选「采哪些域」：', '采集卡片引导句'],
  ['目录库的域骨架', '目录概览长句'],
  ['买家账号：经营总览/流量转化/运营推广会被自动剔除', '买家账号说明段'],
  ['只调整执行时间，不保存或覆盖店铺开关、检测内容', '调整排期弹窗开场说明'],
  ['判定「已登录」后让页面多待这么久', '保活停留说明'],
  ['「定时采集」—— 和', '到点做什么的说明段'],
  ['已保存的账号密码会自动代填；要走扫码 / 短信', '待登录横幅说明段'],
  ['「检测更新」只查询 GitHub 有没有新提交', '更新说明段'],
  ['换机器（比如 Windows → mac）时用：导出只含店铺配置', '配置迁移说明段'],
  ['每个店铺一份独立的登录档案：用 ego lite（每店一个 profile', '顶部副标题长句'],
  ['还没有店铺账号 —— 点右上角「+ 新增店铺」', '空列表长句'],
];
for (const [text, what] of REMOVED) {
  test('已删除：' + what, () => {
    assert.equal(clientSrc.includes(text), false, '这段文案还在：' + text.slice(0, 20) + '…');
  });
}

// ── C. 该留的功能文案还在（别删过头） ───────────────────────────────────────
section('C. 该留的操作文案还在');

test('采集卡片：状态胶囊 + 同一个开关的按钮', () => {
  assert.match(clientSrc, /定时采集：已加入/);
  assert.match(clientSrc, /定时采集：已暂停/);
  assert.match(clientSrc, /加入定时采集/);
  assert.match(clientSrc, /暂停定时采集/);
  assert.match(clientSrc, /保存采集域/);
});

test('密码卡：一句话说明 + 操作按钮齐全', () => {
  assert.match(clientSrc, /只保存在本机（/);
  assert.match(clientSrc, /macOS 钥匙串/);
  assert.match(clientSrc, /保存密码/);
  assert.match(clientSrc, /删除密码/);
  assert.match(clientSrc, /重新登录（代填）/);
});

test('账号密码错的警示卡：只留一句', () => {
  assert.match(clientSrc, /已暂停自动代填/);
  assert.equal(clientSrc.includes('避免连续错误被锁号'), false, '警示卡还留着长解释');
});

test('指标目录规模还显示，但压成一行', () => {
  assert.match(clientSrc, /本地指标目录：/);
  assert.equal(clientSrc.includes('可采指标 / '), false, '目录那行还是长句');
});

test('顶部副标题确实换成一行短句', () => {
  assert.match(clientSrc, /一店一份独立登录档案（ego lite）/);
  assert.match(clientSrc, /一店一份独立登录档案（Chrome）/);
});

// ── E. 密码框的眼睛（v0.16.2） ───────────────────────────────────────────────
section('E. 密码框的「显示 / 隐藏」是小眼睛图标');

test('不再是「隐藏 / 显示」文字按钮，改成 sa-eye + SVG', () => {
  assert.equal(clientSrc.includes("showPw ? '隐藏' : '显示'"), false, '还是老的文字按钮');
  assert.ok(clientSrc.includes('eyeIcon(showPw)'), '新增店铺弹窗没用小眼睛');
  assert.ok(clientSrc.includes('eyeIcon(showPw2)'), '详情页没用小眼睛');
  assert.ok(clientSrc.includes('.sa-eye{'), '缺 .sa-eye 样式');
  assert.match(clientSrc, /aria-label': showPw \? '隐藏密码' : '显示密码'/);
});

test('睁眼/闭眼两个图标都有（闭眼带一道斜线）', () => {
  assert.ok(clientSrc.includes('M3 3l18 18'), '闭眼图标少了斜线');
  assert.ok(clientSrc.includes('M2.2 12S5.8 5.6 12 5.6'), '睁眼图标路径不在');
  assert.ok(clientSrc.includes("h('circle', { cx: 12, cy: 12, r: 3.1 })"), '睁眼图标少了瞳孔');
});

// ── F. 下拉框样式（v0.16.3） ────────────────────────────────────────────────
section('F. 下拉框：去掉原生外观 + 自绘箭头');

test('.sa-select：去原生外观、自绘 chevron、hover 与焦点环都有', () => {
  assert.ok(clientSrc.includes('.sa-select{appearance:none'), '没去掉 select 的原生外观');
  assert.ok(clientSrc.includes('background-image:url("data:image/svg+xml'), '没用自绘箭头');
  assert.ok(clientSrc.includes('background-position:right 8px center'), '箭头没靠右垂直居中');
  assert.ok(clientSrc.includes('.sa-select:hover'), '缺 hover 反馈');
  assert.ok(clientSrc.includes('.sa-select:focus{border-color'), '缺焦点样式');
  assert.ok(/\.sa-select:focus\{[^}]*box-shadow/.test(clientSrc), '焦点没有焦点环（键盘操作看不出落点）');
});

test('所有 <select> 都挂上了 sa-select（漏一个就会是原生丑箭头）', () => {
  const selects = (clientSrc.match(/h\('select'/g) || []).length;
  const styled = (clientSrc.match(/sa-input sa-select/g) || []).length;
  assert.ok(selects > 0, '源码里没有 select？');
  assert.equal(styled, selects, `有 ${selects} 个下拉框，但只有 ${styled} 个用了 sa-select`);
});

test('展开后的选项也给了底色（深色主题下不会白底黑字）', () => {
  assert.ok(clientSrc.includes('.sa-select option{'), '选项没有底色，深色主题下可能看不清');
});

// ── D. 提示行长度上限（防止再写长段落） ─────────────────────────────────────
section('D. 界面里不再有超长提示句');

test('client.js 里没有超过 100 字的中文界面文案（注释不算）', () => {
  // 逐行扫：跳过纯注释行，只看带引号的中文字面量
  const longOnes = [];
  for (const line of clientSrc.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    const re = /'([^'\n]*)'/g;
    let m;
    while ((m = re.exec(line))) {
      const v = m[1];
      if (!/[\u4e00-\u9fa5]/.test(v)) continue;
      if (v.length > 100) longOnes.push(v.slice(0, 60) + '…(' + v.length + '字)');
    }
  }
  assert.deepEqual(longOnes, [], '还有超长文案：\n      ' + longOnes.join('\n      '));
});

// ── G. 状态反馈只改颜色（v0.16.4） ─────────────────────────────────────────
section('G. 按压 / 选中 / hover 不允许改变按钮尺寸');

test('选中态不再加粗（加粗会让文字变宽、chip 尺寸跟着变）', () => {
  const rules = clientSrc.match(/\.sa-tab\[data-on="1"\]\{[^}]*\}/g) || [];
  assert.ok(rules.length > 0, '找不到 .sa-tab 的选中态样式');
  for (const r of rules) {
    assert.equal(/font-weight/.test(r), false, '选中态还在加粗：' + r);
    assert.equal(/font-size/.test(r), false, '选中态改了字号：' + r);
    assert.equal(/padding|border-width|transform|letter-spacing/.test(r), false, '选中态改了盒模型：' + r);
  }
});

test('按钮类元素都去掉了原生外观并显式继承字体（避免宿主/系统字体差异导致宽度跳变）', () => {
  for (const cls of ['.sa-btn', '.sa-tab', '.sa-schedbtn', '.sa-schedpill', '.sa-plat']) {
    // 同一个类可能出现在多处（比如窄面板的 @container 里只调字号），只要有一条
    // 规则同时带了 appearance:none 与 font-family:inherit 就算合格。
    const re = new RegExp(cls.replace('.', '\\.') + '\\{([^}]*)\\}', 'g');
    const bodies = [...clientSrc.matchAll(re)].map((m) => m[1]);
    assert.ok(bodies.length > 0, '缺样式 ' + cls);
    const ok = bodies.some((b) => /appearance\s*:\s*none/.test(b) && /font-family\s*:\s*inherit/.test(b));
    assert.ok(ok, cls + ' 没有同时声明 appearance:none 与 font-family:inherit');
  }
});

test('每个按钮都有按压反馈，且反馈里不含任何几何属性', () => {
  for (const cls of ['.sa-btn', '.sa-tab', '.sa-schedbtn', '.sa-schedpill', '.sa-plat']) {
    const re = new RegExp(cls.replace('.', '\\.') + ':active[^{]*\\{([^}]*)\\}');
    const m = re.exec(clientSrc);
    assert.ok(m, cls + ' 没有 :active 按压反馈');
    assert.equal(/padding|border-width|transform|scale|translate|font-size|font-weight/.test(m[1]), false, cls + ' 的按压反馈改了几何：' + m[1]);
  }
});

test('状态类规则里没有任何 font-weight / font-size 变化', () => {
  const stateRules = clientSrc.match(/\.sa-[a-z-]*(\[data-on="1"\]|:active|:hover)[^{]*\{[^}]*\}/g) || [];
  assert.ok(stateRules.length > 0, '找不到状态类规则');
  const bad = stateRules.filter((r) => /font-weight|font-size|padding|border-width|transform|scale/.test(r));
  assert.deepEqual(bad, [], '这些状态样式会改变按钮尺寸：\n      ' + bad.join('\n      '));
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('\n' + (failures.length ? '\u2717 失败 ' + failures.length + ' 项 / 共 ' + (passed + failures.length) : '\u2713 全部通过（' + passed + ' 项）'));
if (failures.length) {
  for (const f of failures) console.log('\n--- ' + f.name + '\n' + (f.err && f.err.stack ? f.err.stack : f.err));
  process.exit(1);
}
