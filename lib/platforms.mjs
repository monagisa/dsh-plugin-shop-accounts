/**
 * platforms.mjs —— 平台字典（宿主与客户端共用的「真相」）。
 *
 * 每个平台要回答三件事：
 *   1. **去哪登录**（loginUrl）：新增账号时弹出的那个 Chrome 窗口打开的第一页；
 *   2. **怎么判断已登录**（sessionCookies + cookieDomains）：登录态只认
 *      「只会在登录后出现的身份 cookie」，不认 `cna` / `_m_h5_tk` 这类匿名跟踪 cookie
 *      —— 后者在未登录的首页上就已经存在，拿它当判据会把每个空档案都判成"已登录"；
 *   3. **登录后长什么样**（homeUrl + loginUrlHints）：CDP 拿 cookie 失败时（例如浏览器
 *      不是本插件起的、没带 `--remote-allow-origins=*`）退化成 URL 判据 —— 它比 cookie
 *      判据弱，所以只当作兜底，并且在界面上如实标注「依据：网址」。
 *
 * 判据口径是**宁可漏判不可错判**：不确定就报「未登录」并说明原因，让用户点「检测」
 * 或重新登录；把未登录的档案说成已登录，代价是上架流程在别人家的登录页上失败。
 */

/** 平台条目。id 是持久化在 accounts.json 里的稳定键，改名会丢账号，别改。 */
export const PLATFORMS = [
  {
    id: 'pdd',
    label: '拼多多',
    accountHint: '拼多多商家后台（mms）',
    loginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=' + encodeURIComponent('https://mms.pinduoduo.com/'),
    homeUrl: 'https://mms.pinduoduo.com/home/',
    /** 上架/发品页，用于「打开」时直接落到工作台 */
    workUrl: 'https://mms.pinduoduo.com/goods/goods_list',
    cookieDomains: ['pinduoduo.com'],
    sessionCookies: ['PASS_ID', 'SUB_PASS_ID', 'mms_b84d1838'],
    /** 至少要命中几个身份 cookie 才算数（见 judgeLogin 的说明） */
    minCookieHits: 2,
    /**
     * 2026-10-31 审查补：原来只要求命中 1 个 cookie，而未登录页也可能被种下 mms_b84d1838
     * （index.js 检测路径的注释自认过这件事）→ 会把"没登录"说成"已登录"。
     * 现在要求「至少 2 个 sessionCookies 命中」且「至少命中一个真身份 cookie」。
     */
    identityCookies: ['PASS_ID', 'SUB_PASS_ID'],
    loginUrlHints: ['/login'],
  },
  {
    id: 'taobao',
    label: '淘宝',
    accountHint: '千牛工作台（卖家端）',
    /**
     * 2026-10-14 真机实测（临时 URL 探针，见 git 历史里的 .tmp-urlcheck.mjs）：
     * `qn.taobao.com/home.htm` 和 `myseller.taobao.com/home.htm` 都跳到
     * **loginmyseller.taobao.com**（页面标题「千牛工作台 - 商家一站式经营阵地」）。
     * 淘宝的**卖家端**登录入口是 loginmyseller；`login.taobao.com/member/login.jhtml`
     * 是买家端，登进去是 C 端账号，上架时照样没权限 —— 这两家不能混。
     */
    loginUrl:
      'https://loginmyseller.taobao.com/?from=taobaoindex&f=top&style=&sub=true&redirect_url=' +
      encodeURIComponent('https://qn.taobao.com/home.htm'),
    homeUrl: 'https://qn.taobao.com/home.htm',
    /** 千牛工作台首页。上架页（千牛 → 商品 → 发布商品）等有真账号登录后再钉准，不猜地址。 */
    workUrl: 'https://qn.taobao.com/home.htm',
    cookieDomains: ['taobao.com', 'tmall.com'],
    sessionCookies: ['cookie2', 'unb', '_tb_token_', 'sgcookie'],
    /** 淘宝要两个：`_tb_token_` 是 csrf，登录态过期后它可能还在，单命中会误判 */
    minCookieHits: 2,
    /**
     * 「登录后才会有」的硬身份 cookie。实测：空档案停在千牛登录页时 cookie 罐里就已经有
     * cookie2 / _tb_token_（匿名跟踪 + csrf），刚好凑够 minCookieHits=2 —— 只看条数会把
     * 「没登录」说成「已登录」。所以淘宝再加一道：必须命中 unb / sgcookie 之一。
     */
    identityCookies: ['unb', 'sgcookie'],
    loginUrlHints: [
      'loginmyseller.taobao.com',
      'login.taobao.com',
      'login.tmall.com',
      'login.alibaba.com',
      'login.m.taobao.com',
    ],
  },
  {
    id: 'tmall',
    label: '天猫',
    accountHint: '天猫商家中心（千牛，与淘宝同一套账号）',
    /**
     * 2026-10-14 真机实测：
     *   tmall.seller.taobao.com      → DNS 都解析不出来（这个域名不存在）
     *   sell.tmall.com               → error.taobao.com/tbpc/error.html（老天猫后台已下线）
     *   myseller.taobao.com/home.htm → loginmyseller.taobao.com（标题「千牛工作台 - 商家一站式经营阵地」）
     * 结论：**天猫商家用的就是千牛**，和淘宝卖家是同一套账号体系、同一套 cookie 判据；
     * 这个条目单独存在，是为了让天猫店单独成组、点「打开」直接落到天猫商家中心入口。
     */
    loginUrl:
      'https://loginmyseller.taobao.com/?from=taobaoindex&f=top&style=&sub=true&redirect_url=' +
      encodeURIComponent('https://myseller.taobao.com/home.htm'),
    homeUrl: 'https://myseller.taobao.com/home.htm',
    workUrl: 'https://myseller.taobao.com/home.htm',
    cookieDomains: ['taobao.com', 'tmall.com'],
    sessionCookies: ['cookie2', 'unb', '_tb_token_', 'sgcookie'],
    minCookieHits: 2,
    identityCookies: ['unb', 'sgcookie'],
    loginUrlHints: [
      'loginmyseller.taobao.com',
      'login.taobao.com',
      'login.tmall.com',
      'login.alibaba.com',
      'login.m.taobao.com',
    ],
  },
  {
    id: 'douyin',
    label: '抖音',
    accountHint: '抖店（fxg.jinritemai.com）',
    loginUrl: 'https://fxg.jinritemai.com/login/common',
    homeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
    workUrl: 'https://fxg.jinritemai.com/ffa/g/list',
    cookieDomains: ['jinritemai.com', 'douyin.com', 'bytedance.com'],
    /**
     * 注意：`ttwid` 和 `passport_csrf_token` 故意不在表里 —— 2026-10-14 真机实测（test/live-probe.mjs）：
     * 空档案停在抖店登录页时，cookie 罐里**只有** passport_csrf_token 一个，把它当判据会把"没登录"说成"已登录"。
     */
    sessionCookies: ['passport_assist_user', 'sessionid', 'sessionid_ss', 'passport_uid'],
    minCookieHits: 1,
    loginUrlHints: ['/login', 'sso.douyin.com', 'sso.bytedance.com'],
  },
  {
    id: 'jd',
    label: '京东',
    accountHint: '京麦工作台（京东商家端）',
    /**
     * 2026-10-14 真机实测：
     *   passport.shop.jd.com/login/index.action/jdm?ReturnUrl=… → 标题「京麦工作台-京东商家一站式工作台」
     *   jm.jd.com  → jm.jd.com/index/index.html，标题「京麦-京东商家一站式智能工作台」
     *   dianpu.jd.com → www.jd.com/error2.aspx（老域名已废）
     * 京东是统一 SSO，登录态在 **pt_key / pt_pin** 这对 cookie 上。实测未登录的登录页上这两个
     * **都没有**，但已经有 sdtoken / JSESSIONID / 3AB9D23F7A4B3C9B / __jda… 这些设备与匿名 cookie
     * —— 所以它们都不能当判据（sdtoken 在没登录时就有）。
     */
    loginUrl:
      'https://passport.shop.jd.com/login/index.action/jdm?ReturnUrl=' + encodeURIComponent('https://jm.jd.com/'),
    homeUrl: 'https://jm.jd.com/index/index.html',
    /** 京麦首页。上架页（京麦 → 商品管理）等有真账号登录后再钉准，不猜地址。 */
    workUrl: 'https://jm.jd.com/index/index.html',
    cookieDomains: ['jd.com'],
    sessionCookies: ['pt_key', 'pt_pin', 'pin', 'thor'],
    minCookieHits: 1,
    identityCookies: ['pt_key', 'pt_pin'],
    loginUrlHints: ['passport.shop.jd.com', 'login/index.action', 'jdm?returnurl'],
  },
  {
    id: 'ali1688',
    label: '1688',
    accountHint: '1688 卖家工作台（商家端）',
    /**
     * 2026-10-14 真机实测：
     *   login.1688.com/member/signin.htm 与 work.1688.com 都跳 login.taobao.com
     *   （redirect_url 带着 1688 的 marketSigninJump，Done=work.1688.com/home/page/index.htm）；
     *   myseller.1688.com 直接「验证码拦截」（反爬），所以不用它。
     * 未登录时 cookie 罐里就已经有 cookie2 / _tb_token_ / t / XSRF-TOKEN，还有 **__cn_logon__=false**
     *   —— 名字在、值是 false，光看名字会误判成已登录，所以这里用 identityCookieValues 卡值。
     * 登录后的身份 cookie 是 _nk_（会员 nick）或 __cn_logon__=true。
     */
    loginUrl: 'https://login.1688.com/member/signin.htm',
    homeUrl: 'https://work.1688.com/home/page/index.htm',
    workUrl: 'https://work.1688.com/home/page/index.htm',
    cookieDomains: ['1688.com', 'taobao.com'],
    sessionCookies: ['cookie2', '_tb_token_', 't', '_nk_', '__cn_logon__', 'sn'],
    minCookieHits: 2,
    identityCookies: ['_nk_', '__cn_logon__'],
    /** 名字在 identityCookies 里的 cookie，值也必须对：__cn_logon__=false 是「没登录」的铁证。 */
    identityCookieValues: { __cn_logon__: ['true', '1'] },
    loginUrlHints: [
      'login.1688.com/member/signin',
      'login.1688.com/member/jump',
      'marketsigninjump',
      'login.taobao.com',
    ],
  },
];

// ── 账号类型：卖家 / 买家 ────────────────────────────────────────────────────
//
// 对齐 Accio Work「账号管理」的 accountType（seller / buyer）：**同一个平台、两种身份，
// 登录入口、登录态判据、能干什么都不一样**。最典型的坑就是淘宝：
//   · 卖家端 = loginmyseller.taobao.com / qn.taobao.com（千牛），登进去才有上架权限；
//   · 买家端 = login.taobao.com，登进去是 C 端账号，**上架照样没权限**。
// 以前插件只有「商家端」一种入口，账号类型只是一段自由文本（默认"商家账号"），
// 所以买家账号既建不出来、也没法按身份做能力过滤。

export const ACCOUNT_TYPES = [
  { id: 'seller', label: '卖家账号', hint: '商家后台（千牛 / mms / 抖店 / 京麦 / 1688 卖家）' },
  { id: 'buyer', label: '买家账号', hint: 'C 端账号（淘宝 / 天猫 / 京东 / 1688 买家），只做采集与浏览，不做上架' },
];

/**
 * 把各种历史写法收敛到 'seller' | 'buyer'。
 * 老账号里存的是自由文本（`商家账号` / 空 / 其它），一律当卖家 —— 那时本来就只有卖家入口。
 */
export function normalizeAccountType(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return 'seller';
  if (s === 'buyer' || s === '买家' || s === '买家账号' || s.includes('买家') || s.includes('buyer')) return 'buyer';
  return 'seller';
}

/** 账号类型是否合法（入参校验用：只收上面两种写法归一后的结果）。 */
export function isValidAccountType(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return true; // 允许省略 = 默认卖家
  return ['seller', 'buyer', '卖家', '卖家账号', '商家账号', '商家', 'buyer', '买家', '买家账号'].includes(s);
}

export function accountTypeLabel(value) {
  const t = normalizeAccountType(value);
  const hit = ACCOUNT_TYPES.find((x) => x.id === t);
  return hit ? hit.label : t;
}

/**
 * 买家变体：只写**与卖家不同**的字段，其它继承平台条目。
 *
 * 卖家端和买家端在 cookie 判据上大多同源（淘宝/天猫/1688 都是同一套 `cookie2/unb/_tb_token_/sgcookie`，
 * 京东都是 `pt_key/pt_pin`），所以这里主要改的是**登录页、主页、上手页**；
 * 拼多多/抖音的 C 端入口没有真机验证，标 `experimental` —— 界面会提示，判据也放宽到 1 个 cookie。
 */
export const BUYER_VARIANTS = {
  taobao: {
    accountHint: '淘宝买家（C 端，login.taobao.com）',
    loginUrl: 'https://login.taobao.com/havanaone/login/login.htm',
    homeUrl: 'https://www.taobao.com/',
    workUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
    loginUrlHints: ['login.taobao.com', 'login.tmall.com', 'login.m.taobao.com', 'havanaone'],
  },
  tmall: {
    accountHint: '天猫买家（C 端，login.tmall.com）',
    loginUrl: 'https://login.tmall.com/',
    homeUrl: 'https://www.tmall.com/',
    workUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
    loginUrlHints: ['login.tmall.com', 'login.taobao.com', 'havanaone'],
  },
  jd: {
    accountHint: '京东买家（C 端，passport.jd.com）',
    loginUrl: 'https://passport.jd.com/new/login.aspx',
    homeUrl: 'https://www.jd.com/',
    workUrl: 'https://order.jd.com/center/list.action',
    loginUrlHints: ['passport.jd.com', 'plogin.m.jd.com', 'new/login.aspx'],
  },
  ali1688: {
    accountHint: '1688 买家（C 端）',
    loginUrl: 'https://login.1688.com/member/signin.htm',
    homeUrl: 'https://www.1688.com/',
    workUrl: 'https://www.1688.com/',
  },
  pdd: {
    experimental: true,
    accountHint: '拼多多买家（C 端，实验性）',
    loginUrl: 'https://mobile.yangkeduo.com/login.html',
    homeUrl: 'https://mobile.yangkeduo.com/',
    workUrl: 'https://mobile.yangkeduo.com/',
    cookieDomains: ['pinduoduo.com', 'yangkeduo.com'],
    sessionCookies: ['pdd_user_id', 'PDDAccessToken', 'PASS_ID', 'api_uid'],
    minCookieHits: 1,
    identityCookies: ['pdd_user_id', 'PDDAccessToken'],
    loginUrlHints: ['/login', 'yangkeduo.com/login'],
  },
  douyin: {
    experimental: true,
    accountHint: '抖音买家（C 端，实验性）',
    loginUrl: 'https://www.douyin.com/',
    homeUrl: 'https://www.douyin.com/',
    workUrl: 'https://www.douyin.com/user/self',
    cookieDomains: ['douyin.com'],
    sessionCookies: ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_assist_user'],
    minCookieHits: 1,
    identityCookies: ['sessionid', 'sessionid_ss', 'sid_tt'],
    loginUrlHints: ['/login', 'sso.douyin.com', 'passport'],
  },
};

/**
 * 平台 + 账号类型 → 有效判据/入口（卖家直接返回平台条目，买家叠加变体）。
 *
 * 所有用到 loginUrl / homeUrl / workUrl / sessionCookies 的地方都应该先过这一层，
 * 否则买家账号会被按卖家判据判成「未登录」，或者被带到千牛登录页上去。
 */
export function variantOf(platform, accountType) {
  if (!platform) return null;
  const type = normalizeAccountType(accountType);
  if (type === 'seller') return { ...platform, accountType: 'seller' };
  const buyer = BUYER_VARIANTS[platform.id];
  // 没有买家变体的平台（目前都写了，防御性兜底）：沿用卖家入口，但如实标出来
  if (!buyer) return { ...platform, accountType: 'buyer', experimental: true, buyerVariantMissing: true };
  return { ...platform, ...buyer, accountType: 'buyer' };
}

/**
 * 这个「平台 + 身份」能干什么。
 *
 * 对齐 Accio 的两条硬规则：
 *   · 店铺 URL（storeUrl）只有**卖家**账号才有意义，且拼多多不支持（`supportsStoreUrl`）；
 *   · 上架/发品/采集配置这类经营动作只对卖家开放；买家账号只做浏览与采集。
 */
export const STORE_URL_PLATFORMS = ['taobao', 'tmall', 'ali1688', 'jd', 'douyin'];

export function capabilitiesOf(platform, accountType) {
  const id = String((platform && platform.id) || platform || '');
  const type = normalizeAccountType(accountType);
  const seller = type === 'seller';
  return {
    accountType: type,
    upload: seller,
    storeUrl: seller && STORE_URL_PLATFORMS.includes(id),
    collection: true,
    passwordLogin: true,
  };
}

/** 平台 id → 条目。未知 id 返回 null（不抛：坏数据不该炸整页）。 */
export function platformOf(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

/** 面向界面的精简平台表（客户端另有一份同样的表，两处都必须与这里一致）。 */
export function platformList() {
  return PLATFORMS.map((p) => ({
    id: p.id,
    label: p.label,
    accountHint: p.accountHint,
    buyerHint: (BUYER_VARIANTS[p.id] && BUYER_VARIANTS[p.id].accountHint) || '',
    buyerExperimental: Boolean(BUYER_VARIANTS[p.id] && BUYER_VARIANTS[p.id].experimental),
    capabilities: { seller: capabilitiesOf(p, 'seller'), buyer: capabilitiesOf(p, 'buyer') },
  }));
}

/** cookie 域名是否命中平台（`mms.pinduoduo.com` 命中 `.pinduoduo.com`）。 */
export function domainMatches(cookieDomain, domains) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  if (!d) return false;
  return domains.some((x) => d === x || d.endsWith('.' + x));
}

/** 当前页 URL 的 host 是否属于平台域（按后缀边界，不做子串匹配）。 */
export function urlHostInDomains(url, domains) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase().replace(/^\.+/, '');
    if (!host) return false;
    return (domains || []).some((d) => {
      const x = String(d || '').toLowerCase().replace(/^\.+/, '');
      return Boolean(x) && (host === x || host.endsWith('.' + x));
    });
  } catch {
    return false;
  }
}

/** 当前页 URL 是否是平台的登录页（URL 兜底判据用）。 */
export function looksLikeLoginPage(url, platform, accountType) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  const v = variantOf(platform, accountType) || platform;
  const hints = Array.isArray(v.loginUrlHints) ? v.loginUrlHints : [];
  return hints.some((h) => u.includes(h.toLowerCase()));
}

/**
 * 登录凭证 cookie 里最晚的到期时间（ISO 字符串）；读不到就返回 null。
 *
 * 只是「这张凭证纸面到哪天」—— **不等于会话还能用**：服务端会先把会话作废，
 * 浏览器里的 PASS_ID 之类仍然躺着（这正是 v0.3.0 误报「已登录」的由来）。
 * 它的用途是**提前提示**：界面显示「凭证到期 2027-01-27」，让你在到期前重登，而不是等掉线。
 * 会话级 cookie（expires <= 0）和匿名 cookie 不参与。
 */
export function tokenExpiryOf(cookies, platform, accountType) {
  const v = variantOf(platform, accountType) || platform || {};
  const names = Array.isArray(v.sessionCookies) ? v.sessionCookies : [];
  const domains = Array.isArray(v.cookieDomains) ? v.cookieDomains : [];
  let best = null;
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c || typeof c.name !== 'string' || !names.includes(c.name)) continue;
    if (!domainMatches(c.domain, domains)) continue;
    const t = Number(c.expires);
    if (!Number.isFinite(t) || t <= 0) continue;
    const iso = new Date(t * 1000).toISOString();
    if (!best || iso > best) best = iso;
  }
  return best;
}

/**
 * 给定 cookie 列表 + 当前 URL，判断登录态。判据优先级：
 *   1. **登录页最硬**：站点把我们按回登录页，就是站点在说不认这个会话 —— 哪怕 cookie 罐里
 *      还留着身份 cookie（服务端过期不会去清浏览器里的 cookie），也不算已登录。
 *   2. **身份 cookie**：域正确 + 名字在 sessionCookies 里 + 值不是占位，才算登录凭证。
 *      匿名 cookie（cna / _m_h5_tk 这类）人人都有，绝不能当登录凭据。
 *   3. **URL 弱判据**：只在 `cookieReadOk=false`（CDP 读 cookie 失败，比如浏览器不是本插件
 *      起的）时才启用，且必须如实标注 `evidence: 'url'`，好让界面区分「确定」和「疑似」。
 * 返回 { loggedIn, evidence: 'cookie' | 'login-page' | 'cookie-weak' | 'url' | 'none', matched, reason }。
 * `cookie-weak` = 读到了 cookie 但全是匿名/跟踪类（见 platform.identityCookies），按未登录算。
 */
export function judgeLogin(cookies, url, platform, opts = {}) {
  const cookieReadOk = opts.cookieReadOk !== false;
  // 买家/卖家两套入口与判据：先把 platform 收窄成「这个身份的变体」，下面所有判据都基于它。
  // 重绑参数是为了不必把 60 行判据里的 `platform.xxx` 逐条改掉：variantOf 对卖家是原样返回，
  // 对买家是「平台条目 + 买家覆盖字段」，字段名完全一致，语义等价。
  platform = variantOf(platform, opts.accountType) || platform;
  const matched = [];
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c || typeof c.name !== 'string') continue;
    if (!platform.sessionCookies.includes(c.name)) continue;
    if (!domainMatches(c.domain, platform.cookieDomains)) continue;
    if (!c.value || String(c.value).length < 4) continue;
    // 个别平台的身份 cookie 还得看**值**：1688 未登录时 cookie 罐里就有 `__cn_logon__=false`，
    // 只看名字会把它当登录凭证（见 platform.identityCookieValues）。
    const valueRule = platform.identityCookieValues && platform.identityCookieValues[c.name];
    if (Array.isArray(valueRule) && !valueRule.some((v) => String(v).toLowerCase() === String(c.value).toLowerCase())) {
      continue;
    }
    matched.push(c.name);
  }
  const uniq = [...new Set(matched)];
  const need = Math.max(1, Number(platform.minCookieHits) || 1);
  const total = Array.isArray(cookies) ? cookies.length : 0;
  // ① 登录页优先：站点把我们按回登录页 = 站点不认这个会话。
  if (looksLikeLoginPage(url, platform)) {
    return {
      loggedIn: false,
      evidence: 'login-page',
      matched: uniq,
      reason: uniq.length ? '登录已失效，请重新登录' : '未登录，请前往登录页登录',
    };
  }
  // ② 身份 cookie：这才是真正的登录凭证。
  //    但光看 minCookieHits 还不够：实测（2026-10-14，test/live-probe.mjs）空档案停在淘宝
  //    卖家登录页时，cookie 罐里已经有 cookie2 / _tb_token_，2 个就凑够了 minCookieHits。
  //    所以个别平台另点明 identityCookies —— 必须命中其中之一，才承认是登录凭证。
  //    只在 cookie 真的读到（cookieReadOk）时才据此下结论：读不到就照样退到网址兜底。
  const identity = Array.isArray(platform.identityCookies) ? platform.identityCookies : [];
  const identityHits = uniq.filter((n) => identity.includes(n));
  if (cookieReadOk && identity.length > 0 && identityHits.length === 0) {
    return {
      loggedIn: false,
      evidence: 'cookie-weak',
      matched: uniq,
      reason:
        '只读到 ' +
        (uniq.length ? uniq.join('、') : '零个') +
        ' 这类 cookie，没有 ' +
        identity.join(' / ') +
        ' 这种「登录后才会有」的身份 cookie',
    };
  }
  if (uniq.length >= need) {
    return {
      loggedIn: true,
      evidence: 'cookie',
      matched: uniq,
      reason: `身份 cookie 命中 ${uniq.length} 个（需 ${need}）：` + uniq.join('、'),
    };
  }
  if (cookieReadOk) {
    return {
      loggedIn: false,
      evidence: 'none',
      matched: [],
      reason: `已读到 ${total} 个 cookie，但没有 ${platform.label} 的身份凭证（需 ${need} 个）`,
    };
  }
  // URL 兜底：仅在读 cookie 失败时启用，且如实标注判据是网址（弱）
  // host 必须按「.域结尾」匹配：`https://pinduoduo.com.evil.com/` 这种子串骗术不算在平台内
  const inSite = urlHostInDomains(url, platform.cookieDomains);
  if (inSite && !looksLikeLoginPage(url, platform) && String(url || '').includes('://')) {
    return { loggedIn: true, evidence: 'url', matched: [], reason: 'cookie 读不到，退用网址判据：在平台内且不在登录页' };
  }
  if (inSite && looksLikeLoginPage(url, platform)) {
    return { loggedIn: false, evidence: 'none', matched: [], reason: 'cookie 读不到，网址停在登录页' };
  }
  return { loggedIn: false, evidence: 'none', matched: [], reason: 'cookie 读不到，网址也不在平台页面上' };
}
