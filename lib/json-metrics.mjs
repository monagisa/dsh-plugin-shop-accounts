/**
 * v0.20.30：JSON 型采集配方的指标解析。
 *
 * 为什么需要：淘宝 / 天猫的「店铺概览」配方不是抓页面上的文字，而是直接读生意参谋的
 * 趋势接口（`/portal/coreIndex/new/trend/v3.json`）。它返回的是一份三十天、六十来个字段
 * 的 JSON：`content.data.self` 里每个字段都是一条日序列。以前这份 JSON 只原样存进
 * `job.json`，表格只能落进「字段 / 值」的兜底格式，看起来像没采到数据。
 *
 * 这里的做法：把 `self` 里每个数值字段取**最后一天**的值当「今日值」，倒数第二天当
 * 「昨日值」，字段名换成能看懂的指标名（没收录的字段就保留原字段名，不猜）。
 */

/** 生意参谋店铺概览字段 → 中文指标名。没收录的字段保留原名。 */
export const SYCM_FIELD_LABELS = {
  // 成交
  payAmt: '成交金额',
  payOrdCnt: '支付订单数',
  payByrCnt: '支付买家数',
  payItmCnt: '成交商品件数',
  payRate: '支付转化率',
  subPayOrdAmt: '子订单支付金额',
  subPayOrdSubCnt: '子订单数',
  netPaymentAmount: '净支付金额',
  olderPayAmt: '老买家支付金额',
  rePurchasePayAmount: '复购支付金额',
  noBuyPayGmv: '未支付成交金额',
  hasBuyPayGmv: '有支付成交金额',
  // 流量
  uv: '访客数',
  pv: '浏览量',
  consultingUv: '咨询访客数',
  consultRate: '咨询率',
  stayTime: '停留时长',
  contentStayTime: '内容停留时长',
  followStayTime: '关注停留时长',
  interestPortalUv: '兴趣访客数',
  hasPurchaseNewUv: '新客访客数',
  hasPurchaseUbyCntRate: '新客成交转化率',
  // 加购 / 收藏
  cartCnt: '加购件数',
  cartItemCnt: '加购商品件数',
  cartByrCnt: '加购买家数',
  cltItmCnt: '收藏商品件数',
  // 花费
  feedCharge: '内容花费',
  admCostFamtQzt: '广告花费',
  p4pExpendAmt: '直通车花费',
  zzExpendAmt: '钻展花费',
  tkExpendAmt: '淘客花费',
  adStrategyAmt: '投放策略花费',
  livePayAmt: '直播成交金额',
  // 客户
  shopCustomer: '店铺客户数',
  cstUserCnt: '客服接待人数',
  cstTransRate: '客服转化率',
  payOldByrCnt: '老买家数',
  noPurchaseBuyCnt: '未支付买家数',
  // 退款 / 服务
  rfdSucAmt: '退款成功金额',
  payShopRfdAmt: '店铺退款金额',
  ordRfdRate: '订单退款率',
  payAmtRfdRate: '支付金额退款率',
  realPayrealRfdRate: '实付退款率',
  sucRefundRate: '退款成功率',
  rfdFinshDur: '退款完成时长',
  disputeDutyRatio: '纠纷责任率',
  gotInTime48hRate: '48小时揽收率',
  postTimeLenHour: '发货时长',
  avgSignTimeHh: '平均签收时长',
  wwReplyManualAvgTimeLen: '旺旺人工回复时长',
  wwGoodCstEvaRate: '好评率',
  sign_ord_cnt_1d_001: '单日签收订单数',
  // 商品 / 内容
  releaseItmCnt: '在架商品数',
  postVideoCheckCnt: '发布视频数',
  allContentSupplyScale: '内容供给量',
  productCoverage: '商品覆盖率',
  cubeAmt: '立方体金额',
};

/** 生意参谋的 statDate 是毫秒时间戳（也可能是 'YYYY-MM-DD' 文本），统一成 YYYY-MM-DD。 */
function dateLabel(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' || /^\d{10,}$/.test(String(value))) {
    const d = new Date(Number(value));
    if (Number.isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  return String(value);
}

/** 40 个字符，够区分字段，也不至于把表格撑歪。 */
function labelOf(field) {
  return SYCM_FIELD_LABELS[field] || String(field);
}

/** 取数组末位；标量原样返回；非数值返回 undefined。 */
function tailValue(value, back) {
  if (Array.isArray(value)) {
    const idx = value.length - 1 - (back || 0);
    return idx >= 0 ? value[idx] : undefined;
  }
  return back ? undefined : value;
}

/**
 * 解析生意参谋趋势 JSON，返回 `{ values, yesterday, dates }`；结构不认识返回 null。
 * `values` 的键是中文指标名（未收录字段用原字段名），值是数字。
 */
export function parseSycmMetrics(input) {
  let root = input;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      return null;
    }
  }
  if (!root || typeof root !== 'object') return null;
  const data = (root.content && root.content.data) || root.data || null;
  const self = data && data.self;
  if (!self || typeof self !== 'object' || Array.isArray(self)) return null;

  const dates = Array.isArray(self.statDate) ? self.statDate.map(dateLabel).filter(Boolean) : [];
  const values = {};
  const yesterday = {};
  let fields = 0;
  for (const field of Object.keys(self)) {
    if (field === 'statDate' || field === 'userId') continue;
    const today = tailValue(self[field], 0);
    const prev = tailValue(self[field], 1);
    if (typeof today !== 'number' || !Number.isFinite(today)) continue;
    const label = labelOf(field);
    values[label] = today;
    if (typeof prev === 'number' && Number.isFinite(prev)) yesterday[label] = prev;
    fields += 1;
  }
  if (!fields) return null;

  // v0.20.32：整段日序列，用于「第一行是指标、第一列是日期」的表格布局。
  const series = { dates: [], columns: {} };
  if (dates.length > 1) {
    series.dates = dates;
    for (const field of Object.keys(self)) {
      if (field === 'statDate' || field === 'userId') continue;
      const arr = self[field];
      if (!Array.isArray(arr) || arr.length !== dates.length) continue;
      const nums = arr.map((v) => (Number.isFinite(Number(v)) ? Number(v) : ''));
      if (!nums.some((n) => n !== '')) continue;
      series.columns[labelOf(field)] = nums;
    }
  }

  return {
    values,
    yesterday,
    dates,
    series,
    asOf: dates.length ? dates[dates.length - 1] : '',
    prevDate: dates.length > 1 ? dates[dates.length - 2] : '',
  };
}

/** 表格里「今日 / 昨日」两列的表头；拿不到日期就用默认文案。 */
export function headerFor(asOf, prevDate) {
  return ['指标', asOf ? asOf + ' 值' : '今日值', prevDate ? prevDate + ' 值' : '昨日值'];
}
