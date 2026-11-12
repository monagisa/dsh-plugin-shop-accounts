/**
 * v0.20.25 自检：Edge 行改用官方图标、整行可点即切换。
 *
 * 背景（用户）：v0.20.24 的 Edge 图标是手画的简化图，与官方标志不像；
 * 切换浏览器只有展开后才看到按钮，容易以为「换不了」。
 *
 * 实现：
 *   · 界面内嵌官方 Edge 标志（64×64 透明底 PNG data URI），Edge 行不再手画；
 *   · 点浏览器列表里任意一行即切换（箭头按钮只展开路径与版本详情）；
 *   · 列表下方补一句说明。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const clientSrc = read('lib/client.js');
const changelog = read('CHANGELOG.md');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}

// 解析内嵌 PNG 的头（IHDR：宽、高、颜色类型）。
function pngHeader(dataUri) {
  const b64 = String(dataUri).split(',')[1] || '';
  const buf = Buffer.from(b64, 'base64');
  if (buf.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('不是 PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25], bytes: buf.length };
}

await test('A1 Edge 图标是内嵌 PNG，且带透明通道', () => {
  const m = clientSrc.match(/var EDGE_LOGO_URI = "([^"]+)";/);
  assert.ok(m, '缺少 EDGE_LOGO_URI');
  assert.ok(m[1].startsWith('data:image/png;base64,'), '不是内嵌 PNG');
  const h = pngHeader(m[1]);
  assert.equal(h.width, 64, '宽应为 64（行内 34px 显示）');
  assert.equal(h.height, 64, '高应为 64');
  assert.equal(h.colorType, 6, '应为 RGBA（带透明通道）');
  assert.ok(h.bytes < 12000, '图片过大：' + h.bytes + ' 字节');
});

await test('A2 Edge 分支用图片渲染，不再手画圆形底', () => {
  const i = clientSrc.indexOf("if (id === 'edge') {");
  assert.ok(i > 0, '缺少 Edge 分支');
  const seg = clientSrc.slice(i, i + 400);
  assert.ok(seg.includes('EDGE_LOGO_URI'), 'Edge 分支没有引用内嵌图标');
  assert.ok(!seg.includes("'#0b72c4'"), 'Edge 分支仍在手画图标');
  assert.ok(seg.includes("alt: 'Microsoft Edge'"), '缺少 alt');
});

await test('B1 整行可点：点没在用的那一行直接切换', () => {
  assert.ok(clientSrc.includes('onClick: function () { if (!chosen && !scanBusy) useBrowser(b); }'), '行头没有切换动作');
  assert.ok(clientSrc.includes("cursor: chosen || scanBusy ? 'default' : 'pointer'"), '没有指针样式');
});

await test('B2 箭头按钮不触发切换（只展开详情）', () => {
  assert.ok(clientSrc.includes("if (e && typeof e.stopPropagation === 'function') e.stopPropagation();"), '箭头没有阻止冒泡');
});

await test('B3 切换仍然只写 browserPath（不新增后端类型）', () => {
  const at = clientSrc.indexOf('function useBrowser(b)');
  assert.ok(at > 0, '缺少 useBrowser');
  const seg = clientSrc.slice(at, at + 800);
  assert.ok(seg.includes("{ browserPath: b.path, browser: 'chrome' }"), '切换没有写浏览器路径');
  assert.ok(!seg.includes("'edge'"), '不要给 Edge 单独造后端名');
});

await test('B4 列表下方给出切换说明', () => {
  assert.ok(clientSrc.includes("'点浏览器那一行即切换；箭头展开路径与版本'"), '缺少说明文案');
});

await test('C1 版本与文档一致', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(String(pkg.version)), '版本号格式不对');
  const [maj, min, pat] = String(pkg.version).split('.').map((n) => parseInt(n, 10));
  assert.ok(maj > 0 || (min === 20 && pat >= 25), '版本号应 ≥ 0.20.25，实际 ' + pkg.version);
  assert.ok(changelog.includes('v0.20.25'), 'CHANGELOG 缺 v0.20.25');
  assert.ok(readme.includes('点浏览器那一行'), 'README 没写新的切换方式');
});

if (failures.length) {
  console.log('\n✗ 失败 ' + failures.length + ' 项');
  process.exit(1);
}
console.log('\n✓ 全部通过（' + passed + ' 项）');
