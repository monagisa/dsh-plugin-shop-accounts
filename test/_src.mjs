// 自检脚本读取「宿主侧源码」的统一入口。
//
// 为什么要聚合：早期各套自检直接读 lib/index.js 的文本做切片断言，后来宿主按职责拆成多个模块，
// 单读 index.js 会读不到已搬走的代码。这里按「拆分前在原文件里的先后顺序」排列模块，
// 拼接结果对 includes / indexOf 顺序断言保持稳定。
import fs from 'node:fs';
import path from 'node:path';

// 顺序 = 拆分前各区块在 lib/index.js 里的位置（新增模块时按这个顺序插入）
export const SERVER_MODULES = [
  'lib/plugin-consts.mjs',
  'lib/http-json.mjs',
  'lib/text.mjs',
  'lib/login-modes.mjs',
  'lib/domains.mjs',
  'lib/diagnostics.mjs',
  'lib/cookies.mjs',
  'lib/self-update.mjs',
  'lib/accounts.mjs',
  'lib/http-guard.mjs',
  'lib/self-update-paths.mjs',
  'lib/port-ownership.mjs',
  'lib/index.js',
];

export function readServerSource(root) {
  const parts = SERVER_MODULES.map((rel) => {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) return '';
    return '// ===== ' + rel + ' =====\n' + fs.readFileSync(p, 'utf8');
  });
  return parts.join('\n\n');
}

export function readModule(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
