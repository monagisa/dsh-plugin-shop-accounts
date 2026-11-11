/**
 * dsl-names.mjs —— 采集项的中文名（v0.20.21）。
 *
 * 配方 id 是英文（douyin_shop_transaction），但用户看到的应该是「抖店-成交分析」：
 * 文件名、manifest、界面上的「上次采集」都用这份映射标出来。
 * 没有映射的配方退回 id 本身（第三方配方目录里新加的配方也能用，只是名字还是英文）。
 */

export const DSL_ITEM_NAMES = {
  douyin_shop_transaction: '抖店-成交分析',
  douyin_shop_income_expense: '抖店-收支分析',
  jd_shop_overview: '京东-店铺概览',
  jd_traffic_overview: '京东-流量概览',
  pdd_shop_overview: '拼多多-店铺概览',
  tb_shop_overview: '淘宝-店铺概览',
  tmall_shop_overview: '天猫-店铺概览',
};

/** 采集项的中文名（没有映射就用配方 id）。 */
export function dslItemName(dslId) {
  const id = String(dslId == null ? '' : dslId).trim();
  if (!id) return '采集项';
  return String(DSL_ITEM_NAMES[id] || '').trim() || id;
}

/** 文件名里能用的采集项名：去掉 Windows 不允许的字符，压掉空白。 */
export function dslItemFileSafe(dslId) {
  const raw = dslItemName(dslId)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (raw || 'item').slice(0, 40);
}

/** Excel 工作表名：不含 []:*?/\，最多 31 个字符（Excel 的硬限制）。 */
export function sheetNameSafe(dslId) {
  const raw = dslItemName(dslId)
    .replace(/[\[\]:*?/\\\r\n\t]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return (raw || 'Sheet1').slice(0, 31);
}
