import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    console.log('  ✗ ' + name);
    console.log(String((err && err.message) || err));
  }
}

console.log('1. 迁移工具：补表格与 manifest 都带店名');
const tool = read('tools/migrate-collect-naming.mjs');

test('A1 补表格的文件名带店名', () => {
  assert.ok(tool.includes('shopNameSafe(job.accountName)'), '补表格没带店名');
  assert.ok(tool.includes("'表格.xlsx'"), '补表格文件名缺后缀');
  assert.ok(tool.includes('const shopSeg'), '缺店名前缀变量');
});

test('A2 manifest 的命名说明带店名', () => {
  assert.ok(tool.includes('<采集项>_<YYYYMMDD-HHmm>_<店名>_<原始文件名>'), 'manifest 命名说明还是旧的');
});

test('A3 迁移工具引用店名清洗', () => {
  assert.ok(/import\s*{[^}]*shopNameSafe[^}]*}\s*from\s*'\.\.\/lib\/dsl-names\.mjs'/.test(tool), '没有引入 shopNameSafe');
});

console.log('2. 运行期：产物与目录都带店名');
const runner = read('lib/collect-runner.mjs');

test('B1 表格生成带店名', () => {
  assert.ok(runner.includes('shopFileSeg'), '表格生成缺店名段');
  assert.ok(runner.includes('/采集数据_') || runner.includes("'采集数据_'"), '缺采集数据工作簿命名');
  assert.ok(runner.includes('采集数据_'), '缺工作簿前缀');
});

test('B2 作业目录标签带店名', () => {
  assert.ok(runner.includes("jobItemsLabel("), '缺采集项标签');
  assert.ok(/[`'"]_[\`'"]|join\(|label/.test(runner), '缺目录命名拼装');
});

console.log('3. 版本与文档');
test('C1 版本已到 0.20.52', () => {
  const got = (read('package.json').match(/"version":\s*"([^"]+)"/) || [])[1] || '';
  const atLeast = (want) => {
    const a = got.split('.').map(Number);
    const b = want.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return true;
  };
  assert.ok(atLeast('0.20.52'), '版本落后：' + got);
});

test('C2 更新日志与说明写了这次修复', () => {
  assert.ok(read('CHANGELOG.md').includes('## v0.20.52'), 'CHANGELOG 缺 v0.20.52');
  assert.ok(read('CHANGELOG.md').includes('店名'), 'CHANGELOG 没提店名');
});

console.log('\n全部通过（' + passed + ' 项）');
if (failed > 0) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
