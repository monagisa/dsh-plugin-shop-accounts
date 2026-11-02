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
};

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
 */
export function normalizeCollection(input, prev = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const base = prev && typeof prev === 'object' ? prev : {};
  const enabled = src.enabled === undefined ? base.enabled === true : src.enabled === true;

  let domains;
  if (src.domains === undefined) {
    domains = Array.isArray(base.domains) ? base.domains.slice() : [];
  } else {
    if (!Array.isArray(src.domains)) throw new Error('采集域必须是数组');
    domains = src.domains.map((d) => String(d == null ? '' : d).trim()).filter(Boolean);
    domains = [...new Set(domains)];
    if (domains.length > MAX_DOMAINS) throw new Error(`采集域太多（最多 ${MAX_DOMAINS} 个）`);
    const bad = domains.filter((d) => !COLLECTION_DOMAINS.includes(d));
    if (bad.length) throw new Error(`未知采集域：${bad.join('、')}（可选：${COLLECTION_DOMAINS.join(' / ')}）`);
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

/** /state 里给界面用的采集域表。 */
export function domainList() {
  return COLLECTION_DOMAINS.map((id) => ({ id, label: COLLECTION_LABELS[id] || id }));
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

  const wanted = Array.isArray(cfg.domains) && cfg.domains.length ? cfg.domains : COLLECTION_DOMAINS;
  const buyerBusinessDomains = ['经营总览', '流量转化', '运营推广'];
  const effective = type === 'buyer' ? wanted.filter((d) => !buyerBusinessDomains.includes(d)) : wanted;
  const dropped = wanted.filter((d) => !effective.includes(d));

  const range = collectionRangeText(opts.now instanceof Date ? opts.now : new Date());
  const items = effective.map((d) => {
    const label = COLLECTION_LABELS[d] || d;
    return `“${label}”（采集目录：“${d}”，domain_id=${collectDomainId(a.platform, d)}）`;
  });

  const lines = [];
  lines.push('ecommerce-data-collect');
  lines.push('');
  if (!enabledOf(cfg)) {
    lines.push(`（注意：这个店铺的采集开关是关着的，以下内容仅供手动发起时参考）`);
    lines.push('');
  }
  lines.push(`采集 ${platformLabel} 店铺“${storeName}”的以下数据：${items.join('、')}。`);
  lines.push('');
  lines.push(`平台：${a.platform}${v.experimental ? '（买家入口为实验性支持）' : ''}；账号类型：${type === 'buyer' ? '买家账号' : '卖家账号'}${a.loginName ? `；登录账号：${a.loginName}` : ''}。`);
  lines.push(`采集范围固定为${range.text}，不需要再询问日期范围。`);
  lines.push('逐个目录调用 `collection plan --domain-id`，合并并去重后执行 await_collect；不要使用 --all-domains 扩大范围，也不要把界面名称当作目录 ID。每个目录包含全部下级目录及其已接入的数据源，具体指标以当前平台采集计划为准。');
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

function enabledOf(cfg) {
  return Boolean(cfg && cfg.enabled === true);
}

/** 某账号今天是否还没采（用于「今日待采集」与工具返回）。 */
export function isCollectionDue(account, now = new Date()) {
  const cfg = (account && account.collection) || {};
  if (!enabledOf(cfg)) return false;
  if (!Array.isArray(cfg.domains) || cfg.domains.length === 0) return false;
  const last = cfg.lastRunAt ? new Date(cfg.lastRunAt) : null;
  if (last && !Number.isNaN(last.getTime())) {
    const sameDay = last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate();
    if (sameDay && cfg.lastRunStatus !== 'failed') return false;
  }
  if (!cfg.time) return true; // 没设时间 = 今天就该采（由调用方决定何时跑）
  const [h, m] = String(cfg.time).split(':').map((x) => Number(x));
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  return now.getTime() >= due.getTime();
}

/** 汇总所有到期账号（设置页角标 + 工具用）。 */
export function dueCollections(accounts, now = new Date()) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => isCollectionDue(a, now));
  return list.map((a) => ({
    id: a.id,
    name: a.name || a.id,
    platform: a.platform,
    time: (a.collection && a.collection.time) || '',
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
