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
    minCookieHits: 1,
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

/** 平台 id → 条目。未知 id 返回 null（不抛：坏数据不该炸整页）。 */
export function platformOf(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

/** 面向界面的精简平台表（客户端另有一份同样的表，两处都必须与这里一致）。 */
export function platformList() {
  return PLATFORMS.map((p) => ({ id: p.id, label: p.label, accountHint: p.accountHint }));
}

/** cookie 域名是否命中平台（`mms.pinduoduo.com` 命中 `.pinduoduo.com`）。 */
export function domainMatches(cookieDomain, domains) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  if (!d) return false;
  return domains.some((x) => d === x || d.endsWith('.' + x));
}

/** 当前页 URL 是否是平台的登录页（URL 兜底判据用）。 */
export function looksLikeLoginPage(url, platform) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  return platform.loginUrlHints.some((h) => u.includes(h.toLowerCase()));
}

/**
 * 登录凭证 cookie 里最晚的到期时间（ISO 字符串）；读不到就返回 null。
 *
 * 只是「这张凭证纸面到哪天」—— **不等于会话还能用**：服务端会先把会话作废，
 * 浏览器里的 PASS_ID 之类仍然躺着（这正是 v0.3.0 误报「已登录」的由来）。
 * 它的用途是**提前提示**：界面显示「凭证到期 2027-01-27」，让你在到期前重登，而不是等掉线。
 * 会话级 cookie（expires <= 0）和匿名 cookie 不参与。
 */
export function tokenExpiryOf(cookies, platform) {
  const names = Array.isArray(platform && platform.sessionCookies) ? platform.sessionCookies : [];
  const domains = Array.isArray(platform && platform.cookieDomains) ? platform.cookieDomains : [];
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
  const u = String(url || '').toLowerCase();
  const inSite = platform.cookieDomains.some((d) => u.includes(d));
  if (inSite && !looksLikeLoginPage(u, platform) && u.includes('://')) {
    return { loggedIn: true, evidence: 'url', matched: [], reason: 'cookie 读不到，退用网址判据：在平台内且不在登录页' };
  }
  if (inSite && looksLikeLoginPage(u, platform)) {
    return { loggedIn: false, evidence: 'none', matched: [], reason: 'cookie 读不到，网址停在登录页' };
  }
  return { loggedIn: false, evidence: 'none', matched: [], reason: 'cookie 读不到，网址也不在平台页面上' };
}
