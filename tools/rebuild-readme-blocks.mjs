// 重建 README 里由自检清单驱动的两块：自检代码块 + 合计项数。
// v0.19.6 起 README 改为功能向，更新日志移出到 CHANGELOG.md，本脚本不再改「目录结构」块。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const p = path.join(ROOT, 'README.md');
let rd = fs.readFileSync(p, 'utf8');

const SUITES = [
  ['smoke.mjs', 113, '平台判据 / 持久化 / 宿主 HTTP 面 / 排期 / ego 后端 / 客户端契约 / 安全边界'],
  ['features-v090.mjs', 31, '账号类型 / 密码库 / 账密代填 / 采集配置与调度 / 新路由'],
  ['features-v0101.mjs', 15, '登录账号查重 / 店铺配置导出导入（含坏数据与重复导入）'],
  ['features-v0110.mjs', 24, '采集数据层（台账缺口 / 导入校验与去重 / 空结果台账 / 查询）'],
  ['features-v0120.mjs', 23, '指标目录层（平台域名与指标数 / 跨平台校验 / metricId / /catalog）'],
  ['features-v0130.mjs', 27, '采集 DSL（编译 / 占位符 / 真实配方 / 登录守卫 / 产物 / HTTP 边界）'],
  ['features-v0140.mjs', 18, '下载落盘 + 采集作业编排（分批 / 重试 / 覆盖 / 交付）'],
  ['features-v0150.mjs', 22, '定时采集（mode 分流 / 待登录跳过 / 回写 / 登录过期自动代填）'],
  ['features-v0152.mjs', 12, '账号密码错的识别与暂停（提示分类 / 状态 / 超时保护）'],
  ['features-v0160.mjs', 19, '采集开关与时间统一到排期（迁移幂等 / tick 只认采集域）'],
  ['features-v0161.mjs', 35, '文案精简与占位符脱敏 / 小眼睛图标 / 下拉框样式 / 按钮尺寸稳定'],
  ['features-v0165.mjs', 20, '登录 iframe 内的账密代填（frame 候选顺序 / 真机壳页面）'],
  ['features-v0166.mjs', 20, '账号身份能力（拼多多不提供买家、抖音买家只走扫码 / 验证码）'],
  ['features-v0167.mjs', 13, '采集引擎四处修复（条件守卫 / 缺后处理能力 / 单日锚点 / 产物归集）'],
  ['features-v0168.mjs', 25, '后处理能力按需执行 / 页面数字字形还原 / 页面文字转指标'],
  ['features-v0169.mjs', 20, '补齐天猫 / 抖音 / 京东配方、登录过期按页面识别'],
  ['features-v0170.mjs', 18, '登录方式可选（账号密码代填 / 扫码或手动登录）'],
  ['features-v0171.mjs', 9, '抖店代填先切「邮箱登录」页签（真机对照实验）'],
  ['features-v0172.mjs', 13, '各平台「登录账号」提示 / 店铺 URL 接口'],
  ['features-v0173.mjs', 8, '代填时自动勾选「同意用户协议 / 隐私条款」'],
  ['features-v0174.mjs', 6, '六平台登录页实测 / 天猫买家入口改走淘宝登录页'],
  ['features-v0175.mjs', 7, '点「登录」按四条路径回退（按钮 / 文字 / 表单提交 / 回车）'],
  ['features-v0176.mjs', 8, '非标准选择器（`:visible` / `:text-is` / xpath `$`）与真实鼠标点击'],
  ['features-v0177.mjs', 9, '定时采集包含下载型配方（含缺陷复现）'],
  ['features-v0178.mjs', 11, '浏览器设置去掉说明性文案，只留可改的选项'],
  ['features-v0179.mjs', 12, '工具 output 声明 + 客户端报错落盘（设置页空白问题可定位）'],
  ['features-v0181.mjs', 12, '抖音买家入口是抖音精选（www.douyin.com/jingxuan）'],
  ['features-v0182.mjs', 12, 'ego 控制权硬停适配（不接管用户空间 / 备用窗口名）'],
  ['features-v0183.mjs', 12, '打开与检测按「平台 × 身份」取参数'],
  ['features-v0184.mjs', 18, '默认配置留给用户、登录态判据不再误判'],
  ['features-v0185.mjs', 9, 'ego 空间没有活页时新建一页（不再留下 https://x/ 空窗口）'],
  ['features-v0186.mjs', 12, 'ego 用户配置按平台共用（同平台同身份才分开）'],
  ['features-v0187.mjs', 19, '表单按平台+身份给提示（买家叫用户名 / 用户账户，卖家叫店铺名 / 登录账号）'],
  ['features-v0188.mjs', 11, '买家账号不做数据采集（不显示采集卡片、接口拒绝、定时只做检测）'],
  ['features-v0192.mjs', 9, '窗口在别处关掉后状态跟上（可见时每 10 秒对一次，不再一直显示「关闭浏览器」）'],
  ['features-v0198.mjs', 10, '窗口里已经登录时不再自动代填'],
  ['features-v0202.mjs', 10, '定时采集到点自己启动 ego（以前要手动先打开一次）'],
  ['features-v0197.mjs', 7, '浏览器设置面板的 hook 顺序（先跑 hook，再提前返回）'],
  ['platform.mjs', 12, '平台适配层契约 + macOS 分支（可在 Windows 上验证的部分）'],
];
const TOTAL = SUITES.reduce((n, s) => n + s[1], 0);

// ── 1) 「自检」代码块 ──────────────────────────────────────────────────────────
const codeStart = rd.indexOf('```powershell', rd.indexOf('## 自检'));
const codeEnd = rd.indexOf('\n```', codeStart);
if (codeStart < 0 || codeEnd < 0) throw new Error('找不到自检代码块');
const pad = (str, width) => str + ' '.repeat(Math.max(1, width - str.length));
const block = [
  ...SUITES.map(([file, n, desc]) => pad('node test/' + file, 31) + '# ' + n + ' 项：' + desc),
  'node test/live-probe.mjs pdd   # 真机链路：临时档案启动无头 Chrome，读取 cookie 后关闭 + 「慢跳转」回归',
  'node test/live-probe.mjs all   # 六个平台依次验证（建议逐个执行，共用档案会串 cookie）',
].join('\n');
rd = rd.slice(0, codeStart) + '```powershell\n' + block + rd.slice(codeEnd);

// ── 2) 「一次执行上述前 N 套」与合计项数 ──────────────────────────────────────
if (!rd.includes('`npm test` 一次执行上述前')) throw new Error('找不到「一次执行上述前 N 套」');
rd = rd.replace(/`npm test` 一次执行上述前 \d+ 套/, '`npm test` 一次执行上述前 ' + SUITES.length + ' 套');
if (!rd.includes('- 自检：**')) throw new Error('找不到顶部/尾部的合计项数行');
rd = rd.replace(/- 自检：\*\*\d+ 项\*\*/, '- 自检：**' + TOTAL + ' 项**');

fs.writeFileSync(p, rd, 'utf8');
console.log('TOTAL =', TOTAL, '| suites =', SUITES.length);
