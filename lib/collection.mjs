/**
 * collection.mjs —— 店铺数据采集的「配置 + 编排」。
 *
 * 对齐 Accio Work 的做法（逆向结论）：**账号管理只维护「采什么、什么时候采」，真正的采集交给 agent skill 执行**。
 *   · 采集域固定 5 个，界面名与内部 id 同形（中文即 id），另有标签用于解释范围：
 *       经营总览 → 成交与客户 / 流量转化 → 访客与转化 / 运营推广 → 广告与营销
 *       商品供给 → 商品与动销 / 服务履约 → 售后与服务
 *     （Accio 还有一个「竞争洞察」不对外开放，这里同样不列出。）
 *   · 校验规则照抄：开启采集必须至少选一个采集域；域名必须来自白名单；域数量有上限。
 *   · 采集范围固定「最近 30 个完整自然日」（30 天前到昨天，不含今天），不询问用户日期。
 *   · 采集任务按店铺维度的 domain_id 传参（`<platform>-scheduler-<域>`，抖店用 doudian），
 *     保证与 Accio 的调度语义一致，便于以后对接同一套 skill。
 *
 * 插件**不自己抓页面**：抓取逻辑留在 skill 里（改版时只改 skill），插件只负责
 * 「哪个店铺、哪个域、什么时候该采」，以及把采集结果/失败记回账号表。
 */

import { platformOf, variantOf, normalizeAccountType } from './platforms.mjs';

/** 可选采集域（顺序即界面顺序）。 */
export const COLLECTION_DOMAINS = ['经营总览', '流量转化', '运营推广', '商品供给', '服务履约'];

/** 界面解释名（Accio 同款）。 */
export const COLLECTION_LABELS = {
  经营总览: '成交与客户',
  流量转化: '访客与转化',
  运营推广: '广告与营销',
  商品供给: '商品与动销',
  服务履约: '售后与服务',
  竞争洞察: '竞店竞品',
};

/** 目录层（v0.12.0）额外开放的域：只有淘宝/天猫有（其余平台目录里没有这一支）。 */
export const CATALOG_EXTRA_DOMAINS = ['竞争洞察'];

/** 校验失败时的可选域提示。 */
function domainHint(allowed) {
  return (Array.isArray(allowed) ? allowed : COLLECTION_DOMAINS).join(' / ');
}

const MAX_DOMAINS = 128;

/** 平台 → 采集调度里用的平台段（抖店在 Accio 里叫 doudian）。 */
export function collectPlatformKey(platformId) {
  const id = String(platformId || '').trim();
  return id === 'douyin' ? 'doudian' : id;
}

/** 采集域 → 调度 domain_id。 */
export function collectDomainId(platformId, domain) {
  return `${collectPlatformKey(platformId)}-scheduler-${domain}`;
}

/** 采集范围文案（固定 30 天，与 Accio 一致）。 */
export function collectionRangeText(now = new Date()) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  return { start: fmt(start), end: fmt(end), days: 30, text: `最近 30 个完整自然日（${fmt(start)} ~ ${fmt(end)}，不含今天）` };
}

/**
 * 校验并归一采集配置。
 * @param {object} input 形如 `{enabled, domains, time}`（time 是 `HH:mm`，可空=不定时）
 * @param {object} prev 旧配置（部分更新时兜底）
 * @param {object} opts `{allow: string[]}` —— 该平台目录里真实存在的域（不传则只允许默认 5 域）
 */
export function normalizeCollection(input, prev = {}, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const base = prev && typeof prev === 'object' ? prev : {};
  const allowed = Array.isArray(opts.allow) && opts.allow.length ? opts.allow : COLLECTION_DOMAINS;
  const enabled = src.enabled === undefined ? base.enabled === true : src.enabled === true;

  let domains;
  if (src.domains === undefined) {
    domains = Array.isArray(base.domains) ? base.domains.slice() : [];
  } else {
    if (!Array.isArray(src.domains)) throw new Error('采集域必须是数组');
    domains = src.domains.map((d) => String(d == null ? '' : d).trim()).filter(Boolean);
    domains = [...new Set(domains)];
    if (domains.length > MAX_DOMAINS) throw new Error(`采集域太多（最多 ${MAX_DOMAINS} 个）`);
    const bad = domains.filter((d) => !allowed.includes(d));
    if (bad.length) throw new Error(`未知采集域：${bad.join('、')}（可选：${domainHint(allowed)}）`);
  }
  if (enabled && domains.length === 0) throw new Error('开启采集时至少要选择一个采集域');

  let time = src.time === undefined ? String(base.time || '') : String(src.time || '').trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('采集时间格式必须是 HH:mm（例如 09:30）');

  return {
    enabled,
    domains,
    time,
    lastRunAt: base.lastRunAt || null,
    lastRunStatus: base.lastRunStatus || '',
    lastRunNote: base.lastRunNote || '',
    lastRunBy: base.lastRunBy || '',
  };
}

/** 默认 5 域的界面表（目录层不可用时的兜底；正常走 catalog.mjs 的 catalogDomains）。 */
export function domainList() {
  return COLLECTION_DOMAINS.map((id) => ({ id, label: COLLECTION_LABELS[id] || id, metricCount: 0 }));
}

/**
 * 生成「交给 agent/skill 的采集任务说明」。
 *
 * 与 Accio 的 prompt 同构：明确平台、店铺、账号类型、采集域（含 domain_id）、固定日期范围，
 * 并强调**不要擅自扩大范围**。买家账号只采「浏览侧」数据（经营类域对买家无意义），所以
 * 买家账号会把经营总览/流量转化/运营推广这类经营域过滤掉并说明原因。
 */
export function collectionPrompt(account, opts = {}) {
  const a = account || {};
  const platform = platformOf(a.platform);
  const type = normalizeAccountType(a.accountType);
  const v = variantOf(platform, type) || {};
  const cfg = a.collection || {};
  const platformLabel = (platform && platform.label) || a.platform || '';
  const storeName = String(a.name || '').trim() || a.id;

  // v0.12.0 目录层：域清单与指标规模由调用方传入（index.js 按平台查 catalog），
  // 不传就退回默认 5 域、不带指标数（保证老调用方行为不变）。
  const domainMeta = Array.isArray(opts.domainMeta) && opts.domainMeta.length ? opts.domainMeta : null;
  const defaultDomains = domainMeta ? domainMeta.map((d) => d.id) : COLLECTION_DOMAINS;
  const countOf = (d) => {
    if (!domainMeta) return 0;
    const hit = domainMeta.find((x) => x.id === d);
    return hit ? Number(hit.metricCount) || 0 : 0;
  };

  const wanted = Array.isArray(cfg.domains) && cfg.domains.length ? cfg.domains : defaultDomains;
  const buyerBusinessDomains = ['经营总览', '流量转化', '运营推广', '竞争洞察'];
  const effective = type === 'buyer' ? wanted.filter((d) => !buyerBusinessDomains.includes(d)) : wanted;
  const dropped = wanted.filter((d) => !effective.includes(d));

  const range = collectionRangeText(opts.now instanceof Date ? opts.now : new Date());
  const items = effective.map((d) => {
    const label = COLLECTION_LABELS[d] || d;
    const n = countOf(d);
    return `“${label}”（采集目录：“${d}”，domain_id=${collectDomainId(a.platform, d)}${n ? `，约 ${n} 项指标` : ''}）`;
  });

  const lines = [];
  lines.push('ecommerce-data-collect');
  lines.push('');
  if (!enabledOf(cfg)) {
    lines.push('（注意：这个店铺的采集域还没选，或排期开关是暂停的 —— 以下内容仅供手动发起时参考）');
    lines.push('');
  }
  lines.push(`采集 ${platformLabel} 店铺“${storeName}”的以下数据：${items.join('、')}。`);
  lines.push('');
  lines.push(`平台：${a.platform}${v.experimental ? '（买家入口为实验性支持）' : ''}；账号类型：${type === 'buyer' ? '买家账号' : '卖家账号'}${a.loginName ? `；登录账号：${a.loginName}` : ''}。`);
  lines.push(`采集范围固定为${range.text}，不需要再询问日期范围。`);
  if (domainMeta) {
    lines.push('每个域「要采哪些指标」以本地目录层为准（GET /catalog?platform=<平台> 或 shop_accounts action=catalog 查看指标名与所需字段），不要自己编指标名；'
      + '落库时把目录里的 metric_id 一起带上（collect-import 的 items 里加 metricId），不认识的目标会被拒绝。');
  }
  lines.push('执行顺序（v0.11.0 数据层，三步，别跳过）：');
  lines.push('  1) 先算缺口：shop_accounts action=collect-plan（或 POST /accounts/:id/collect-plan），返回 awaitCollect 里每个域的 missing 区间 —— 只采缺的那几天，已覆盖的别重采；');
  lines.push('  2) 再采集：逐个目录按 missing 区间去采（底层可用 ecommerce-data-collect / RPA 脚本），不要使用 --all-domains 扩大范围，也不要把界面名称当作目录 ID；');
  lines.push('  3) 采完写回：shop_accounts action=collect-import（或 POST /accounts/:id/collect-import），带 domain + items + coverageStart/coverageEnd。'
    + '**合法空结果也要导入**（items 传空数组 + 覆盖区间）：只记覆盖台账，否则下次还会重采同一段。');
  if (type === 'buyer') {
    lines.push('这是买家账号：只采浏览侧数据（商品/价格/评价/售后等），不要尝试采经营后台指标。');
  }
  if (dropped.length) {
    lines.push(`已自动剔除对买家账号无意义的经营域：${dropped.join('、')}。`);
  }
  lines.push('');
  lines.push(`登录态由店铺账号「${storeName}」的浏览器档案提供（插件 shop_accounts 工具可打开/检测该店铺）；登录失效时先让用户重新登录，不要尝试绕过。`);
  return lines.join('\n');
}

/**
 * v0.16.0：**这个店配了采集吗**（唯一判据 = 选了至少一个采集域）。
 *
 * 历史上「开采集」有两个开关（账号表里的排期开关 `schedEnabled`、采集配置里的
 * `collection.enabled`）和两处时间（全局排期的槽位时间、`collection.time`），
 * 同一个意思说两遍，用户自然会问「不是统一的吗」。现在统一为：
 *   · **跑不跑** → 账号的 `schedEnabled`（排期表里那个「开启 / 暂停」按钮），到点由 tickSchedule 决定；
 *   · **什么时候跑** → 全局排期（起跑时间 + 每组间隔 + 顺序），每店槽位时间见 `/state` 的 `schedTime`；
 *   · **采什么** → 这里的 `collection.domains`。
 * 老数据里的 `collection.enabled` / `collection.time` 仍然会被读到（不然升级后老账号行为突变），
 * 但只在"显式关闭（enabled === false）"时当作**退出定时采集**；`time` 已经不影响任何调度。
 */
export function collectionReady(account) {
  const cfg = (account && account.collection) || {};
  if (!Array.isArray(cfg.domains) || cfg.domains.length === 0) return false;
  if (cfg.enabled === false) return false; // 老数据的显式关闭，继续尊重
  return true;
}

function enabledOf(cfg) {
  return Boolean(cfg && cfg.enabled === true);
}

/**
 * 某账号今天是否还没采（用于「今日待采集」与工具返回）。
 * `opts.time` = 排期给这个店的槽位时间（`HH:mm`）；不传就退回老数据里的 `collection.time`。
 */
export function isCollectionDue(account, now = new Date(), opts = {}) {
  const cfg = (account && account.collection) || {};
  if (!collectionReady(account)) return false;
  const last = cfg.lastRunAt ? new Date(cfg.lastRunAt) : null;
  if (last && !Number.isNaN(last.getTime())) {
    const sameDay = last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate();
    if (sameDay && cfg.lastRunStatus !== 'failed') return false;
  }
  const time = opts.time != null && opts.time !== '' ? String(opts.time) : String(cfg.time || '');
  if (!time) return true; // 没设时间 = 今天就该采（由调用方决定何时跑）
  const [h, m] = time.split(':').map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return true;
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  return now.getTime() >= due.getTime();
}

/** 汇总所有到期账号（设置页角标 + 工具用）。`opts.timeOf(account) → 'HH:mm'` 可传排期槽位时间。 */
export function dueCollections(accounts, now = new Date(), opts = {}) {
  const timeOf = typeof opts.timeOf === 'function' ? opts.timeOf : (a) => (a.collection && a.collection.time) || '';
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => isCollectionDue(a, now, { time: timeOf(a) }));
  return list.map((a) => ({
    id: a.id,
    name: a.name || a.id,
    platform: a.platform,
    time: timeOf(a) || '',
    domains: (a.collection && a.collection.domains) || [],
  }));
}

/** 采集结果回写（tool 调用 collect-done 时用）。 */
export function applyCollectionResult(account, input = {}) {
  const cfg = normalizeCollection({}, (account && account.collection) || {});
  const status = String(input.status || '').trim();
  const allowed = ['ok', 'partial', 'failed'];
  if (!allowed.includes(status)) throw new Error(`采集结果只能是 ${allowed.join(' / ')}`);
  cfg.lastRunAt = new Date().toISOString();
  cfg.lastRunStatus = status;
  cfg.lastRunNote = String(input.note || '').slice(0, 500);
  cfg.lastRunBy = String(input.by || 'agent').slice(0, 80);
  return cfg;
}
