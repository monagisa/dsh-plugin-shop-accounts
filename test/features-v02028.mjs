/**
 * v0.20.28 自检：工具参数里的「采集域」枚举 —— 修掉注册工具时的 COLLECTION_DOMAINS 未定义。
 *
 * 现场：宿主日志每次启动都有
 *   [shop-accounts] 注册工具 shop_accounts 失败：COLLECTION_DOMAINS is not defined
 * 根因两处，都在 `lib/server/tools.mjs`：
 *   1) 工具 schema 里写了 `enum: [...COLLECTION_DOMAINS, '竞争洞察']`，但这个文件从来没 import
 *      COLLECTION_DOMAINS —— schema 是在 registerTool 里求值的，所以只在宿主注册时才炸，
 *      单独 import 模块看不出来（界面正常，agent 少一个 shop_accounts 工具）。
 *   2) 修掉未定义后，宿主新版 defineTool 的 JSON Schema 校验又报
 *      「parameters.items.items.additionalProperties must be explicitly true or false」
 *      —— 三个对象型参数（items / params / results）没声明 additionalProperties。
 *
 * 做法：
 *   · import 补 COLLECTION_DOMAINS；
 *   · 枚举抽成 `collectionDomainEnums()`（注册时才求值，多一个可见的回归点）；
 *   · 对象型参数补 `additionalProperties: true`，让 defineTool 的严格校验能过。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const serverSrc = readServerSource(ROOT);
const changelog = read('CHANGELOG.md');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));
const toolsSrc = read('lib/server/tools.mjs');

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

const tools = await import(pathToFileURL(path.join(ROOT, 'lib/server/tools.mjs')).href);

console.log('\nv0.20.28 工具参数采集域枚举');

await test('A1 collectionDomainEnums() 返回五个采集域 + 竞争洞察', () => {
  const list = tools.collectionDomainEnums();
  assert.equal(list.length, 6);
  for (const id of ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约', '竞争洞察']) {
    assert.ok(list.includes(id), '缺采集域：' + id);
  }
});

await test('A2 tools.mjs 真的 import 了 COLLECTION_DOMAINS', () => {
  assert.ok(toolsSrc.includes("import { COLLECTION_DOMAINS,"), 'import 行没补 COLLECTION_DOMAINS');
});

await test('A3 schema 用 collectionDomainEnums()，不再直接展开 COLLECTION_DOMAINS', () => {
  const uses = toolsSrc.split('enum: collectionDomainEnums()').length - 1;
  assert.equal(uses, 2, '期望两处使用 collectionDomainEnums()，实际 ' + uses);
  assert.ok(!/enum: \[\s*\.\.\.COLLECTION_DOMAINS/.test(toolsSrc), '仍有裸展开 ...COLLECTION_DOMAINS');
});

await test('B1 三个对象型参数都声明 additionalProperties: true', () => {
  for (const anchor of ["items: { type: 'array', items: { type: 'object', additionalProperties: true }", "params: { type: 'object', additionalProperties: true", "results: { type: 'array', items: { type: 'object', additionalProperties: true }"]) {
    assert.ok(toolsSrc.includes(anchor), '缺 additionalProperties：' + anchor);
  }
});

await test('B2 registerTool 用桩 ctx 注册成功（defineTool 不可用时给出明确原因）', async () => {
  let captured = null;
  const ctx = { tools: { register(tool) { captured = tool; return () => {}; } }, __shopAccountsToolError: '' };
  const dispose = await tools.registerTool(ctx);
  if (dispose === null || captured === null) {
    assert.ok(ctx.__shopAccountsToolError, 'defineTool 不可用时应写 __shopAccountsToolError');
    return;
  }
  assert.equal(typeof dispose, 'function');
  assert.equal(captured.name, 'shop_accounts');
  assert.ok(captured.parameters && captured.parameters.properties, '注册后的 parameters 形状不对');
  assert.ok(captured.output && captured.output.schema && typeof captured.output.render === 'function');
  assert.ok(String(captured.parameters.properties.domain.enum.join(' ')).includes('竞争洞察'));
});

await test('C1 版本号已到 0.20.28', () => {
  const v = pkg.version.split('.').map((x) => parseInt(x, 10));
  assert.ok(v[0] >= 0 && (v[0] > 0 || v[1] >= 20) && (v[1] >= 20), '版本偏低：' + pkg.version);
  assert.ok(v[2] >= 28 || v[1] > 20, '版本偏低：' + pkg.version);
});

await test('C2 CHANGELOG 记录了这次修复', () => {
  assert.ok(changelog.includes('v0.20.28'));
  assert.ok(changelog.includes('COLLECTION_DOMAINS'));
});

await test('C3 README 的自检清单包含这一套', () => {
  assert.ok(readme.includes('features-v02028.mjs'));
});

await test('D1 服务端源码装配（readServerSource）能读到 tools.mjs 的新函数', () => {
  assert.ok(serverSrc.includes('export function collectionDomainEnums()'));
});

console.log('\n' + (failures.length ? failures.map((f) => '  ✗ ' + f.name + '\n      ' + (f.err && f.err.stack ? f.err.stack : '')).join('\n') : ''));
if (failures.length) process.exit(1);
