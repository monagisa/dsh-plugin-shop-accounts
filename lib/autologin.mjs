/**
 * autologin.mjs —— 「显式触发」的账号密码代填。
 *
 * 边界（重要）：
 *   · **只在用户点了「自动登录」按钮时执行一次**，没有后台定时登录、没有偷偷重放；
 *   · 密码来自 vault.mjs（本机 DPAPI 加密），用完即丢，不写日志、不回传界面；
 *   · 表单结构各平台不同且会变，所以是「选择器候选 + 启发式兜底」，并且**永远不假装成功**：
 *     填完提交后必须再用 cookie 判据验一次登录态，验不过就如实回 `needsUser`（验证码/短信/风控）。
 *
 * 为什么值得做：卖家账号的登录态会过期，而「打开窗口 → 找账号密码 → 手打」是每天几十次的操作。
 * 代填只负责把账号密码放进表单并点提交，剩下的人工环节（滑块/短信）仍然交还用户。
 */

import { getAllCookies, evaluateOn, evaluateInFrames, listPages, newPage } from './cdp.mjs';
import { domainMatches, judgeLogin, platformOf, variantOf, normalizeAccountType } from './platforms.mjs';
import { egoAutofill } from './ego.mjs';

/**
 * 各平台登录表单的选择器候选（先精确、后宽泛；全空则走启发式）。
 *
 * 说明：淘宝/天猫/1688 共用阿里 havana 登录页；京东商家与京东买家是两个页面；
 * 拼多多 mms 与抖店的结构最简单（一个账号框一个密码框）。
 */
export const LOGIN_FLOWS = {
  taobao: {
    // 阿里 havana 登录页（login.taobao.com / loginmyseller.taobao.com 跳过来是同一套）
    user: ['#fm-login-id', 'input[name="fm-login-id"]', 'input[name="loginId"]', 'input[id*="login"]'],
    pass: ['#fm-login-password', 'input[name="fm-login-password"]', 'input[type="password"]'],
    submit: ['button.fm-button', 'button[type="submit"]', '.fm-btn button', 'button[class*="login"]'],
    passwordTab: ['密码登录', '账号登录', '账号密码登录'],
    // 卖家的登录页是**壳页面**：主 frame 只有欢迎图，真正的表单在跨域 iframe 里
    // （`#alibaba-login-box` → havanalogin.taobao.com/mini_login.htm）。
    // 只在主 frame 里找输入框一定是空的，所以这里给出 iframe 的地址特征。
    frameHints: ['havanalogin.taobao.com', 'mini_login.htm', 'login.taobao.com', 'login.tmall.com', 'login.alibaba.com', 'login.1688.com'],
  },
  tmall: { same: 'taobao' },
  ali1688: { same: 'taobao' },
  jd: {
    user: ['#loginname', 'input[name="loginname"]', 'input[name="loginName"]', 'input[id*="login"]'],
    pass: ['#nloginpwd', 'input[name="nloginpwd"]', 'input[type="password"]'],
    submit: ['button.login-btn', '#loginsubmit', 'button[type="submit"]', '.login-btn'],
    passwordTab: ['账户登录', '密码登录'],
  },
  pdd: {
    user: ['#usernameId', 'input[name="username"]', 'input[type="text"]', 'input[id*="user"]'],
    pass: ['#passwordId', 'input[name="password"]', 'input[type="password"]'],
    submit: ['button[type="submit"]', '.login-btn', 'button[class*="login"]'],
    passwordTab: ['账号登录', '密码登录'],
  },
  douyin: {
    user: ['input[name="mobile"]', 'input[name="username"]', 'input[placeholder*="手机"]', 'input[type="text"]'],
    pass: ['input[name="password"]', 'input[type="password"]'],
    submit: ['button[type="submit"]', 'button[class*="login"]'],
    passwordTab: ['验证码登录', '密码登录', '账号登录'],
  },
};

/** 取某平台+身份的表单流程（买家沿用平台流程，京东买家页不同但选择器兼容）。 */
export function loginFlowFor(platformId, accountType) {
  const type = normalizeAccountType(accountType);
  const base = LOGIN_FLOWS[platformId];
  if (!base) return null;
  const flow = base.same ? LOGIN_FLOWS[base.same] : base;
  if (!flow) return null;
  return { ...flow, accountType: type };
}

/**
 * 生成「在页面里跑」的填充脚本。返回一个表达式字符串，执行结果是一个对象：
 * `{ userFilled, passFilled, submitted, hasCaptcha, url, error? }`
 *
 * 用原生 setter + input/change 事件写值：React/Vue 受控输入直接改 `.value` 会被框架丢掉。
 */
export function buildFillExpression({ username, password, flow }) {
  const spec = {
    username: String(username || ''),
    password: String(password || ''),
    flow: flow || {},
  };
  return `(() => {
  const S = ${JSON.stringify(spec)};
  const out = { userFilled: false, passFilled: false, submitted: false, hasCaptcha: false, tabClicked: false, url: location.href };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const setVal = (el, value) => {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
      return true;
    } catch (e) { return false; }
  };
  const pick = (list, filter) => {
    for (const sel of (list || [])) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
      const hit = nodes.find((n) => visible(n) && (!filter || filter(n)));
      if (hit) return hit;
    }
    return null;
  };
  // ① 先尝试切到「账号密码登录」页签（默认可能是扫码/验证码登录）
  if (Array.isArray(S.flow.passwordTab) && S.flow.passwordTab.length) {
    const clickable = Array.from(document.querySelectorAll('a,button,div,span'));
    for (const want of S.flow.passwordTab) {
      const el = clickable.find((n) => visible(n) && String(n.textContent || '').trim() === want);
      if (el) { try { el.click(); out.tabClicked = true; } catch (e) {} break; }
    }
  }
  // ② 账号框：先按选择器，再按「可见文本输入框里最靠上的那个」
  let userEl = pick(S.flow.user, (n) => !/password|passwd|pwd/i.test(String(n.type || '')) && String(n.type || '') !== 'hidden');
  if (!userEl) {
    const texts = Array.from(document.querySelectorAll('input')).filter((n) => visible(n) && !/password|passwd|pwd|hidden|checkbox|radio|submit/i.test(String(n.type || '')));
    userEl = texts[0] || null;
  }
  // ③ 密码框：选择器优先，否则第一个可见 password 框
  let passEl = pick(S.flow.pass, (n) => String(n.type || '').toLowerCase() === 'password');
  if (!passEl) passEl = Array.from(document.querySelectorAll('input[type="password"]')).find(visible) || null;

  if (userEl && S.username) out.userFilled = setVal(userEl, S.username);
  if (passEl && S.password) out.passFilled = setVal(passEl, S.password);

  // ④ 验证码/风控存在性：填完就检测，避免"提交了但永远登不进"被当成失败重试
  const capSel = ['img[src*="captcha"]','[id*="captcha" i]','[class*="captcha" i]','#nc_1_wrapper','.nc-container','iframe[src*="captcha"]','[class*="verify" i]'];
  out.hasCaptcha = capSel.some((sel) => { try { return Array.from(document.querySelectorAll(sel)).some(visible); } catch (e) { return false; } });

  // ⑤ 提交：先按钮，退到回车
  if (out.userFilled && out.passFilled) {
    let btn = pick(S.flow.submit, null);
    if (btn) { try { btn.click(); out.submitted = true; } catch (e) {} }
    if (!out.submitted && passEl) {
      try {
        for (const t of ['keydown','keypress','keyup']) passEl.dispatchEvent(new KeyboardEvent(t, { bubbles: true, key: 'Enter', keyCode: 13, which: 13 }));
        out.submitted = true;
      } catch (e) {}
    }
  }
  out.url = location.href;
  return out;
})()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在 Chrome（本插件起的、带调试端口）里代填。 */
async function autoLoginViaChrome(account, { password, cfg }) {
  const platform = platformOf(account.platform);
  const v = variantOf(platform, account.accountType);
  if (!v) return { ok: false, code: 'AUTOLOGIN_UNSUPPORTED_PLATFORM', error: `未知平台：${account.platform}` };
  const flow = loginFlowFor(account.platform, account.accountType);
  if (!flow) return { ok: false, code: 'AUTOLOGIN_UNSUPPORTED_PLATFORM', error: `这个平台还没有代填流程：${account.platform}` };

  const port = Number(account.port) || 0;
  if (!port) return { ok: false, code: 'AUTOLOGIN_BROWSER_NOT_RUNNING', error: '这个店铺还没有分配调试端口，请先点「打开」再点「自动登录」' };

  const pages = await listPages(port).catch(() => []);
  // 优先复用已有平台页面；没有就新开登录页
  let target = pages.find((p) => domainMatches(new URL(p.url || 'https://x/').hostname, v.cookieDomains)) || null;
  if (!target) {
    target = await newPage(port, v.loginUrl);
    if (!target || !target.webSocketDebuggerUrl) {
      return { ok: false, code: 'AUTOLOGIN_BROWSER_NOT_RUNNING', error: '打不开登录页：浏览器没在跑，或调试端口不通' };
    }
    await sleep(2500);
  } else if (/^https?:/i.test(target.url || '') && !String(target.url).includes(new URL(v.loginUrl).hostname)) {
    await evaluateOn(target.webSocketDebuggerUrl, `location.href = ${JSON.stringify(v.loginUrl)}; 'navigating'`, 5000, port).catch(() => {});
    await sleep(2500);
  }

  const expr = buildFillExpression({ username: account.loginName || '', password, flow });
  // 淘宝系（淘宝/天猫/1688）的表单在跨域 iframe 里，必须逐个候选 frame 试；
  // 拼多多/京东/抖店表单在主 frame 上，frameHints 为空时主 frame 排第一，行为不变。
  const frameHints = Array.isArray(flow.frameHints) ? flow.frameHints : [];
  const fillRes = await evaluateInFrames(target.webSocketDebuggerUrl, {
    expression: expr, frameHints, expectedPort: port, timeoutMs: 8000,
  }).catch((err) => ({ ok: false, value: undefined, tried: [], error: String((err && err.message) || err) }));
  const filled = (fillRes && fillRes.value) || (fillRes && fillRes.error ? { error: fillRes.error } : null);
  if (!filled || typeof filled !== 'object') {
    return {
      ok: false,
      code: 'AUTOLOGIN_FILL_FAILED',
      error: '页面里执行填充脚本失败' + (filled && filled.error ? '：' + filled.error : ''),
    };
  }
  const filledFrame = (fillRes && fillRes.frameUrl) || '';
  if (!filled.userFilled && !filled.passFilled) {
    // 一个输入框都没摸到：宁可明确报「没找到输入框」，也不要让它悄悄走成"要人工登录"
    const tried = (fillRes && Array.isArray(fillRes.tried) ? fillRes.tried : [])
      .map((t) => (t && t.url ? String(t.url) : '')).filter(Boolean).slice(0, 4);
    return {
      ok: false,
      code: 'AUTOLOGIN_FILL_FAILED',
      backend: 'chrome',
      error: '页面里没找到「登录账号/密码」输入框'
        + (tried.length ? `（已试 ${tried.length} 个 frame：${tried.join(' , ')}）` : ''),
      tried,
      hint: '登录页结构可能变了，或者页面还没加载完 —— 先点「打开」确认登录页显示出来，再点「自动登录」',
    };
  }

  // 提交后等一会儿再看登录态（有的站立刻跳转，有的要 2~4 秒）
  await sleep(3200);
  const got = await getAllCookies(port).catch(() => null);
  const cookies = (got && got.cookies) || [];
  const judge = judgeLogin(cookies, target.url || v.loginUrl, platform, { cookieReadOk: Boolean(got), accountType: account.accountType });

  // 没登录成功时：扫一眼页面上的失败提示，把「账号或密码不正确」和「要验证码」分开。
  // 不这么做的话，密码错也会报成 NEEDS_USER，用户只看到"停在窗口里没反应"。
  let failure = { code: '', message: '' };
  let pageText = '';
  if (!judge.loggedIn) {
    // 同一个 frame 里扫：淘宝系的红字也渲染在 iframe 里（主 frame 的 body 里没有它）
    const scan = await evaluateInFrames(target.webSocketDebuggerUrl, {
      expression: buildErrorScanExpression(), frameHints, expectedPort: port, timeoutMs: 5000, satisfy: () => true,
    }).catch(() => null);
    const value = scan && scan.value;
    if (value && typeof value === 'object') {
      pageText = [Array.isArray(value.hints) ? value.hints.join(' ') : '', String(value.body || '')].join(' ').slice(0, 4000);
    }
    failure = classifyLoginFailure(pageText);
  }
  const badCredentials = failure.code === 'AUTOLOGIN_BAD_CREDENTIALS';

  return {
    ok: true,
    code: judge.loggedIn ? 'AUTOLOGIN_OK' : (failure.code || 'AUTOLOGIN_NEEDS_USER'),
    backend: 'chrome',
    filled: { user: Boolean(filled.userFilled), pass: Boolean(filled.passFilled), submitted: Boolean(filled.submitted), tabClicked: Boolean(filled.tabClicked) },
    filledFrame,
    hasCaptcha: Boolean(filled.hasCaptcha),
    loggedIn: judge.loggedIn,
    evidence: judge.evidence,
    matched: judge.matched,
    reason: judge.reason,
    url: filled.url || target.url || v.loginUrl,
    needsUser: !judge.loggedIn,
    pageErrorText: pageText.slice(0, 500),
    error: badCredentials ? '登录账号或密码不正确（站点提示）' : undefined,
    hint: judge.loggedIn
      ? '已代填并登录成功，可以点「检测」复核'
      : (badCredentials
        ? '站点提示「账号或密码不正确」—— 去店铺详情里把账号/密码改对后，再点一次「重新登录（代填）」'
        : (filled.hasCaptcha
          ? '账号密码已填好并提交，但页面有验证码/风控 —— 请在弹出的窗口里手动完成验证'
          : '账号密码已填入并尝试提交，但登录态还没建立 —— 请在那个窗口里确认（可能要滑块/短信）')),
  };
}

/** 在 ego lite 的窗口里代填（走 ego 运行时脚本，密码只在该脚本内短暂存在）。 */
async function autoLoginViaEgo(account, { password, cfg }) {
  const platform = platformOf(account.platform);
  const v = variantOf(platform, account.accountType);
  if (!v) return { ok: false, code: 'AUTOLOGIN_UNSUPPORTED_PLATFORM', error: `未知平台：${account.platform}` };
  const flow = loginFlowFor(account.platform, account.accountType);
  if (!flow) return { ok: false, code: 'AUTOLOGIN_UNSUPPORTED_PLATFORM', error: `这个平台还没有代填流程：${account.platform}` };

  const fillExpr = buildFillExpression({ username: account.loginName || '', password, flow });
  const frameHints = Array.isArray(flow.frameHints) ? flow.frameHints : [];
  const r = await egoAutofill(account, { url: v.loginUrl, domains: v.cookieDomains, fillExpr, errorExpr: buildErrorScanExpression(), frameHints }, {
    egoliteCli: cfg && cfg.egoliteCli,
    egoliteApp: cfg && cfg.egoliteApp,
    timeoutMs: 90000,
  });
  if (!r || r.ok === false) {
    const code = (r && r.code) || 'AUTOLOGIN_EGO_FAILED';
    const err = (r && r.error) || 'ego 执行代填失败';
    // ego 没开着：给出可执行的下一步，而不是一句"失败"
    if (code === 'ego_not_running') {
      return { ok: false, code: 'AUTOLOGIN_BROWSER_NOT_RUNNING', backend: 'egolite', error: err, hint: '先在店铺上点「打开」，窗口出来后再点「自动登录」' };
    }
    return { ok: false, code, backend: 'egolite', error: err };
  }

  const filled = r.filled || null;
  if (!(filled && (filled.userFilled || filled.passFilled))) {
    // 一个输入框都没摸到（跨域 iframe 也可能已经试过）：明确说「没找到输入框」
    return {
      ok: false,
      code: 'AUTOLOGIN_FILL_FAILED',
      backend: 'egolite',
      framesTried: r.frameTried || null,
      error: '页面里没找到「登录账号/密码」输入框'
        + (r.fillFrame ? `（最接近的 frame：${r.fillFrame}）` : ''),
      hint: '登录页结构可能变了，或者页面还没加载完 —— 先点「打开」确认登录页显示出来，再点「自动登录」',
    };
  }
  const judge = judgeLogin(r.cookies || [], r.url || v.loginUrl, platform, {
    cookieReadOk: Array.isArray(r.cookies),
    accountType: account.accountType,
  });
  const hasCaptcha = Boolean(filled && filled.hasCaptcha);
  // 和 Chrome 后端同一套：没登录成功就看页面提示，分清「密码错」和「要验证码」
  const pageText = String(r.pageErrorText || '').slice(0, 4000);
  const failure = judge.loggedIn ? { code: '', message: '' } : classifyLoginFailure(pageText);
  const badCredentials = failure.code === 'AUTOLOGIN_BAD_CREDENTIALS';
  return {
    ok: true,
    code: judge.loggedIn ? 'AUTOLOGIN_OK' : (failure.code || 'AUTOLOGIN_NEEDS_USER'),
    backend: 'egolite',
    space: r.space || '',
    profileId: r.profileId || '',
    filled: filled ? { user: Boolean(filled.userFilled), pass: Boolean(filled.passFilled), submitted: Boolean(filled.submitted), tabClicked: Boolean(filled.tabClicked) } : null,
    filledFrame: r.fillFrame || '',
    fillError: r.fillError || null,
    hasCaptcha,
    loggedIn: judge.loggedIn,
    evidence: judge.evidence,
    matched: judge.matched,
    reason: judge.reason,
    url: r.url || v.loginUrl,
    needsUser: !judge.loggedIn,
    pageErrorText: pageText.slice(0, 500),
    error: badCredentials ? '登录账号或密码不正确（站点提示）' : undefined,
    hint: judge.loggedIn
      ? '已代填并登录成功，可以点「检测」复核'
      : (badCredentials
        ? '站点提示「账号或密码不正确」—— 去店铺详情里把账号/密码改对后，再点一次「重新登录（代填）」'
        : (hasCaptcha
          ? '账号密码已填好并提交，但页面有验证码/风控 —— 请在那个 ego 窗口里手动完成验证'
          : '账号密码已填入并尝试提交，但登录态还没建立 —— 请在 ego 窗口里确认（可能要滑块/短信）')),
  };
}

const BAD_CREDENTIAL_PATTERNS = [
  /账号或密码(不正确|错误|有误)/,
  /用户名或密码(不正确|错误)/,
  /密码(输入)?(错误|不正确|有误)/,
  /(登录名|账户名|账号|手机号)或密码/,
  /incorrect (username|password|account|credentials)/i,
  /wrong (username|password|account)/i,
  /invalid (username|password|credentials)/i,
  /password is incorrect/i,
];
const CAPTCHA_PATTERNS = [/验证码/, /滑块/, /拖动/, /captcha/i, /verify you are human/i];

/**
 * 把"页面上看到的登录失败提示"分类成错误码。
 * 为什么要单独做：站点不会告诉我们"密码错了"（HTTP 还是 200），只会渲染一行红字。
 * 不识别它的话，密码错会被误报成「需要验证码 / 未建立登录态」，用户就看不出真正原因 —— 这就是
 * 「账号或密码错了，流程停住还不返回信息」的根因。
 */
export function classifyLoginFailure(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return { code: '', message: '' };
  for (const re of BAD_CREDENTIAL_PATTERNS) {
    if (re.test(t)) return { code: 'AUTOLOGIN_BAD_CREDENTIALS', message: '登录账号或密码不正确' };
  }
  for (const re of CAPTCHA_PATTERNS) {
    if (re.test(t)) return { code: 'AUTOLOGIN_NEEDS_USER', message: '页面要求验证码/风控验证' };
  }
  return { code: '', message: '' };
}

/** 页面里扫一遍可见文本（登录失败提示就在里面），交给 classifyLoginFailure 判断。 */
export function buildErrorScanExpression() {
  return `(() => {
  try {
    const pick = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; } };
    const cand = []
      .concat(pick('[class*="error"]'), pick('[class*="err-"]'), pick('[class*="tips"]'), pick('[class*="tip-"]'),
              pick('[class*="msg"]'), pick('[class*="alert"]'), pick('[role="alert"]'), pick('.login-error'), pick('#error'));
    const texts = [];
    for (const el of cand) {
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') continue;
      const t = String(el.textContent || '').trim();
      if (t && t.length <= 120) texts.push(t);
    }
    const body = String((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 4000);
    return { ok: true, hints: texts.slice(0, 20), body };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
})()`;
}

/**
 * 自动登录入口。
 * @param {object} account 账号记录
 * @param {object} opts `{ password, backend, cfg }` —— password 由调用方从 vault 取出
 */
export async function autoLogin(account, opts = {}) {  const password = String(opts.password || '');
  if (!password) return { ok: false, code: 'AUTOLOGIN_NO_PASSWORD', error: '这个店铺还没有保存密码，请先设置密码' };
  if (!String(account.loginName || '').trim()) {
    return { ok: false, code: 'AUTOLOGIN_NO_LOGIN_NAME', error: '这个店铺还没有填「登录账号」，请先在详情里补上（代填需要账号）' };
  }
  const backend = String(opts.backend || 'chrome');
  if (backend === 'egolite') return autoLoginViaEgo(account, { password, cfg: opts.cfg });
  return autoLoginViaChrome(account, { password, cfg: opts.cfg });
}
