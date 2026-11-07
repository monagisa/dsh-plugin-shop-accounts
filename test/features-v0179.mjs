// v0.17.9 自检：工具声明的 output（宿主新版 tools.register 要求）+ 客户端报错落盘。
//
// 背景：设置页在真实宿主里一片空白 —— 宿主用 SlotErrorBoundary 兜住了条目抛异常，
// 把内容换成空 div，而渲染进程的 console 不进宿主日志。v0.17.9 在页面侧装上报钩子，
// 把异常写进 <数据目录>/client-errors.log；同时补上工具缺失的 output 声明
// （缺少它时 defineTool 直接抛 "Cannot read properties of undefined (reading 'render')"）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { readServerSource } from './_src.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = path.resolve(here, '..');
const readSrc = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const pkg = JSON.parse(readSrc('package.json'));
const clientSrc = readSrc('lib/client.js');
const indexSrc = readServerSource(repo);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  }
}

// ── 进程内 HTTP harness（与 v0170 / v0177 同一套）──────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v0179-'));
process.env.DSH_SHOP_ACCOUNTS_DIR = tmpDir;

const mod = await import(pathToFileURL(path.join(repo, 'lib/index.js')).href);
const host = (mod.default && typeof mod.default.apply === 'function') ? mod.default : mod;
const registered = [];
await host.apply({
  webServer: { register: (route) => { registered.push(route); return () => {}; } },
  logger: () => () => {},
});
await new Promise((r) => setTimeout(r, 60));
assert.ok(registered.length > 0, '插件没有注册任何路由');

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.end = (body) => { res.body = body; res.emit('finish'); };
  return res;
}

async function call(method, pathname, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  req.headers = {
    host: '127.0.0.1:43120',
    'x-dsh-shop-accounts': '1',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
  };
  if (body !== undefined) req.body = Buffer.from(JSON.stringify(body), 'utf8');
  const res = makeRes();
  const done = new Promise((resolve) => res.once('finish', resolve));
  registered[0].handler(req, res);
  if (body !== undefined) process.nextTick(() => { req.emit('data', req.body); req.emit('end'); });
  else process.nextTick(() => req.emit('end'));
  await done;
  const text = res.body || '';
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.statusCode, json, text };
}

// ── A. 工具声明的 output ──────────────────────────────────────────────────────

await test('A1 工具声明带 output { schema, render }（宿主新版 tools.register 必需）', () => {
  const at = indexSrc.indexOf('name: \'shop_accounts\'');
  assert.ok(at > 0, '没找到 shop_accounts 的工具声明');
  const tail = indexSrc.slice(at, at + 3000);
  assert.match(tail, /output: \{/, '工具声明里缺 output');
  assert.match(tail, /schema: \{ type: 'object', additionalProperties: true \}/, 'output.schema 形状不对');
  assert.match(tail, /render: \(_args, value\) => \[\{ type: 'text', text: JSON\.stringify\(value\) \}\]/, 'output.render 形状不对');
});

await test('A2 工具需要 output 的原因写进了注释（避免以后又被删掉）', () => {
  assert.match(indexSrc, /tools\.register 要求每个工具声明 output/, '没写清楚为什么要 output');
  assert.match(indexSrc, /Cannot read properties of undefined \(reading 'render'\)/, '没记下缺 output 时的报错原文');
});

// ── B. 客户端报错上报 ────────────────────────────────────────────────────────

await test('B1 客户端装了 console.error / window.error / unhandledrejection 三个钩子', () => {
  assert.match(clientSrc, /function installClientErrorReporting\(/, '缺 installClientErrorReporting');
  assert.match(clientSrc, /console\.error = function \(\)/, '没接管 console.error');
  assert.match(clientSrc, /addEventListener\('error'/, '没监听 window error');
  assert.match(clientSrc, /addEventListener\('unhandledrejection'/, '没监听 unhandledrejection');
  assert.match(clientSrc, /window\.__dshShopAccountsErrorHook/, '没做重复安装保护');
});

await test('B2 apply 里真的调了上报安装（只写函数不算）', () => {
  const at = clientSrc.indexOf('exports.apply = function apply(ctx)');
  assert.ok(at > 0);
  assert.match(clientSrc.slice(at, at + 400), /installClientErrorReporting\(\);/, 'apply 里没调安装');
});

await test('B3 上报会去重（同一条错误只发一次，避免刷爆请求）', () => {
  assert.match(clientSrc, /reportedClientErrors\[key\]/, '没有去重表');
  assert.match(clientSrc, /if \(reportedClientErrors\[key\]\) return;/, '没有提前返回');
});

await test('B4 上报走 POST /client-error（与设置页读 /state 分开）', () => {
  assert.ok(clientSrc.includes("api('/client-error', {"), '没走 /client-error 路由');
  assert.match(clientSrc, /method: 'POST'/, '没写 POST');
});

// ── C. 服务端接收与落盘 ──────────────────────────────────────────────────────

await test('C1 POST /client-error 把错误写进数据目录的 client-errors.log', async () => {
  const r = await call('POST', '/shop-accounts/client-error', {
    source: 'console.error', where: 'console',
    message: "slot entry crashed in 'settings.section': TypeError: x is undefined",
    stack: 'TypeError: x is undefined\n    at ShopAccountsSection',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const file = path.join(tmpDir, 'client-errors.log');
  assert.ok(fs.existsSync(file), '没写出 client-errors.log');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /slot entry crashed in 'settings\.section'/, '日志里没有原始错误');
  const row = JSON.parse(text.split('\n').filter(Boolean).pop());
  assert.equal(row.source, 'console.error');
  assert.equal(row.where, 'console');
  assert.ok(row.stack.includes('ShopAccountsSection'));
});

await test('C2 GET /client-errors 读回最近的错误（按 JSON 数组返回）', async () => {
  const r = await call('GET', '/shop-accounts/client-errors');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.errors) && r.json.errors.length >= 1, '读不到错误记录');
  assert.ok(r.json.errors[r.json.errors.length - 1].message.includes('settings.section'));
});

await test('C3 超长字段被截断（不许一条错误撑爆日志）', async () => {
  const long = 'x'.repeat(20000);
  const r = await call('POST', '/shop-accounts/client-error', { source: 'window.error', message: long, stack: long });
  assert.equal(r.status, 200);
  const file = path.join(tmpDir, 'client-errors.log');
  const row = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).pop());
  assert.ok(row.message.length <= 400, 'message 没截断');
  assert.ok(row.stack.length <= 4000, 'stack 没截断');
});

await test('C4 空错误不写日志（但接口仍然成功，客户端不应因此报错）', async () => {
  const before = fs.readFileSync(path.join(tmpDir, 'client-errors.log'), 'utf8').split('\n').filter(Boolean).length;
  const r = await call('POST', '/shop-accounts/client-error', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.logged, false);
  const after = fs.readFileSync(path.join(tmpDir, 'client-errors.log'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before, '空错误也写了日志');
});

// ── D. 版本与文档 ────────────────────────────────────────────────────────────

await test('D1 版本号已到 0.17.9', () => {
  const [maj, min, patch] = String(pkg.version).split('.').map(Number);
  assert.ok(maj === 0 && (min > 17 || (min === 17 && patch >= 9)), 'package.json 版本还是 ' + pkg.version);
});

await test('D2 CHANGELOG / README 提到本次修复', () => {
  const changelog = readSrc('CHANGELOG.md');
  const readme = readSrc('CHANGELOG.md');
  assert.match(changelog, /v0\.17\.9/, 'CHANGELOG 没有 v0.17.9');
  assert.match(changelog, /client-errors\.log|空白|SlotErrorBoundary/, 'CHANGELOG 没写这次的问题');
  assert.match(readme, /0\.17\.9/, 'README 没更新版本');
});

console.log('\n' + passed + ' 项通过' + (failures.length ? '，' + failures.length + ' 项失败' : ''));
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 可能还占着 */ }
if (failures.length) process.exit(1);
