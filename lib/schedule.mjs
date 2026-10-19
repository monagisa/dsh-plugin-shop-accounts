/**
 * schedule.mjs —— 定时检测的排期算法（纯函数、零依赖，方便自检脚本直接跑）。
 *
 * 规则（对齐界面上的「调整排期」）：
 *   1. 每天从 `startTime` 开始，把**全部店铺**按 `order` 排成一队（没排到的按创建时间接在后面）；
 *   2. 每 `groupSize` 个店铺一组，组与组之间间隔 `groupIntervalMin` 分钟 ——
 *      只有"组"占时间点，同一组里的店铺时间是同一个；
 *   3. 店铺自己的开关只决定**到点跑不跑**，不影响它占的那个时间点
 *      （所以暂停一个店铺不会让后面的店铺提前，预览里的时间也不会跳来跳去）；
 *   4. 错过时间不补跑：只有到点后 `graceMs`（默认 2 分钟）以内才执行；
 *      宿主一觉睡过去、隔天才开，就跳过，不在半夜补一堆检测。
 *
 * 这里刻意不碰浏览器、不碰文件、不碰时钟（now 一律由调用方传进来），
 * 这样"排期对不对"可以在自检里用固定时间点断言，而不是靠等。
 */

export const SCHEDULE_DEFAULTS = {
  /** 总开关：关着就只是展示排期，到点不跑 */
  enabled: false,
  /** 每天从几点开始（本地时间，HH:MM） */
  startTime: '10:00',
  /** 组间隔（分钟） */
  groupIntervalMin: 30,
  /** 每组几个店铺；0 = 自动（内存 ≤16GB 为 1，>16GB 为 2） */
  groupSize: 0,
  /** 店铺排队顺序（账号 id，数组）；不在里面的按创建时间接在后面 */
  order: [],
  /** 已经跑到哪一天了（本地日期 YYYY-MM-DD）——用来保证"同一天同一个点只跑一次" */
  lastDay: '',
  /** 那天各店铺跑过的时间点 { accountId: 'HH:MM' } */
  lastSlots: {},
};

export function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 'HH:MM' 归一化（接受 '9:5'、'09:05'）；非法值退回 fallback。 */
export function normalizeStartTime(value, fallback = SCHEDULE_DEFAULTS.startTime) {
  const m = String(value == null ? '' : value).trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return fallback;
  return pad2(h) + ':' + pad2(mi);
}

/** 'HH:MM' → 当天第几分钟 */
export function parseHm(value) {
  const t = normalizeStartTime(value, '00:00');
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** 当天第几分钟 → 'HH:MM'（超过一天就绕回去，比如 24:30 → 00:30） */
export function fmtHm(totalMinutes) {
  const m = ((Math.round(Number(totalMinutes) || 0) % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** 把 config 里读出来的排期洗成合法值（坏字段一律回默认，不抛）。 */
export function normalizeSchedule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const order = Array.isArray(r.order)
    ? [...new Set(r.order.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))]
    : [];
  const lastSlots = {};
  if (r.lastSlots && typeof r.lastSlots === 'object') {
    for (const [k, v] of Object.entries(r.lastSlots)) {
      if (typeof k === 'string' && k && typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v.trim())) {
        lastSlots[k] = normalizeStartTime(v, '00:00');
      }
    }
  }
  return {
    enabled: Boolean(r.enabled),
    startTime: normalizeStartTime(r.startTime, SCHEDULE_DEFAULTS.startTime),
    groupIntervalMin: clampInt(r.groupIntervalMin, 1, 24 * 60, SCHEDULE_DEFAULTS.groupIntervalMin),
    groupSize: clampInt(r.groupSize, 0, 50, 0),
    order,
    lastDay: typeof r.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.lastDay) ? r.lastDay : '',
    lastSlots,
  };
}

/**
 * 每组跑几个：用户填了正数就用它（上限 50），填 0 = 自动。
 * 自动规则按内存来 —— 静默检测是"一次只起一只无头 Chrome"，内存越大越敢并行排队。
 */
export function groupSizeFor(schedule, memGB) {
  const s = schedule || {};
  const fixed = clampInt(s.groupSize, 0, 50, 0);
  if (fixed > 0) return fixed;
  return Number(memGB) > 16 ? 2 : 1;
}

/** 店铺排队：先按 order 里仍然存在的 id，再把剩下的按创建时间正序接上。 */
export function resolveOrder(order, accounts) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && typeof a.id === 'string') : [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const out = [];
  for (const id of Array.isArray(order) ? order : []) {
    const a = byId.get(String(id));
    if (a && !out.includes(a)) out.push(a);
  }
  const rest = list
    .filter((a) => !out.includes(a))
    .sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')) || String(x.id).localeCompare(String(y.id)));
  return out.concat(rest);
}

/**
 * 算出整张排期表。
 * 返回 { groupSize, startTime, groupIntervalMin, rows: [{ id, name, platform, label, time, slotMinutes, group, enabled }] }
 * `enabled` 是"这个店铺到点跑不跑"（前台可以暂停），时间点照样占着。
 */
export function planSchedule({ schedule, accounts, memGB } = {}) {
  const s = normalizeSchedule(schedule);
  const groupSize = groupSizeFor(s, memGB);
  const startMinutes = parseHm(s.startTime);
  const queued = resolveOrder(s.order, accounts);
  const rows = queued.map((a, i) => {
    const group = Math.floor(i / groupSize);
    const slotMinutes = startMinutes + group * s.groupIntervalMin;
    return {
      id: a.id,
      name: a.name || '(未命名)',
      platform: a.platform || '',
      label: a.platformLabel || a.platform || '',
      group,
      slotMinutes,
      time: fmtHm(slotMinutes),
      /** 店铺自己的开关（缺省 = 开启） */
      enabled: a.schedEnabled !== false,
      /** 全局开关关着时，具体店铺也不会跑 —— 界面要能说清楚 */
      active: Boolean(s.enabled) && a.schedEnabled !== false,
    };
  });
  return { groupSize, startTime: s.startTime, groupIntervalMin: s.groupIntervalMin, enabled: Boolean(s.enabled), rows };
}

/** 本地日期键 YYYY-MM-DD（不能用 toISOString，那是 UTC，晚上 8 点后会错到前一天）。 */
export function dayKey(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 某个本地日期 + 'HH:MM' 的绝对时间点。 */
export function slotDate(day, hhmm) {
  const [y, m, d] = String(day).split('-').map(Number);
  const minutes = parseHm(hhmm);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0);
}

/**
 * 现在该跑哪些店铺：到点（含 graceMs 宽限）且今天这个时间点还没跑过。
 * 返回 rows（已按时间排序），可以直接顺序执行。
 */
export function dueRows({ schedule, accounts, now = new Date(), memGB, graceMs = 120000 } = {}) {
  const s = normalizeSchedule(schedule);
  if (!s.enabled) return [];
  const today = dayKey(now);
  const rows = planSchedule({ schedule: s, accounts, memGB }).rows;
  const due = [];
  for (const r of rows) {
    if (!r.enabled) continue;
    const at = slotDate(today, r.time);
    const delta = now.getTime() - at.getTime();
    if (delta < 0 || delta > graceMs) continue;
    // 同一天、同一个时间点跑过就不再跑（重启后也不会重复）
    if (s.lastDay === today && s.lastSlots[r.id] === r.time) continue;
    due.push(r);
  }
  return due.sort((x, y) => x.slotMinutes - y.slotMinutes);
}

/**
 * 下一次该跑的时间点（界面显示"下次：…"用）。
 * 返回 { at: ISO, time: 'HH:MM', rows: [该点该跑的店铺] } 或 null。
 */
export function nextRun({ schedule, accounts, now = new Date(), memGB } = {}) {
  const s = normalizeSchedule(schedule);
  if (!s.enabled) return null;
  const rows = planSchedule({ schedule: s, accounts, memGB }).rows.filter((r) => r.enabled);
  if (!rows.length) return null;
  const today = dayKey(now);
  const later = rows.filter((r) => slotDate(today, r.time).getTime() > now.getTime());
  if (later.length) {
    later.sort((x, y) => x.slotMinutes - y.slotMinutes);
    const at = slotDate(today, later[0].time);
    return { at: at.toISOString(), time: later[0].time, rows: later.filter((r) => r.time === later[0].time) };
  }
  // 今天的都过了 → 明天第一个点
  const first = rows.slice().sort((x, y) => x.slotMinutes - y.slotMinutes)[0];
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const at = slotDate(dayKey(tomorrow), first.time);
  return { at: at.toISOString(), time: first.time, rows: rows.filter((r) => r.time === first.time) };
}

/** 记一次执行：返回写回 config 的新排期（同一天同一个点只跑一次的证据）。 */
export function markRan(schedule, { accountIds = [], time, now = new Date() } = {}) {
  const s = normalizeSchedule(schedule);
  const today = dayKey(now);
  const lastSlots = s.lastDay === today ? { ...s.lastSlots } : {};
  for (const id of accountIds) lastSlots[String(id)] = normalizeStartTime(time, '00:00');
  return { ...s, lastDay: today, lastSlots };
}
