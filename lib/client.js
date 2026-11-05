/**
 * dsh-plugin-shop-accounts 的「客户端半身」—— 设置 → 账号管理 那一页。
 *
 * 打包格式：DSH 的客户端 bundle 不是 ESM，而是 classic script + 模块表：
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => module.exports })
 * 只有 react / react-dom / @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
 * dsh-client-ui-primitives / dsh-client-ui-dockkit / dsh-api-gateway/client 这几个平台种子模块能 require。
 * 这里只 require `react`，其余（按钮、弹窗、Toast）自己画 —— primitives 的组件 API
 * 没有随包发布的 .d.ts，靠猜名字调用它在宿主升级时很容易碎，而这一页要的东西很有限。
 *
 * 数据来自宿主半身的 HTTP 面 `/shop-accounts/...`（同源 fetch，见 lib/index.js）。
 * 登录态判定完全在宿主侧做（CDP 读身份 cookie），这里只负责显示与触发。
 *
 * 样式用 CSS 变量 `--dsw-*`（宿主的基础样式表同时带着浅色/深色两套），
 * 每个变量都给字面兜底值 —— **不按主题分支**：分支会在宿主换皮/换主题时变瞎。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-shop-accounts',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    var PACKAGE = 'dsh-plugin-shop-accounts';
    /** 必须与 lib/index.js 的 BASE 一致。 */
    var BASE = '/shop-accounts';
    /** 设置导航里的 section id。 */
    var SECTION_ID = 'shop-accounts';

    /**
     * 平台表：与 lib/platforms.mjs 一一对应（改动必须两边一起改）。
     * v0.18.8：新的店铺表单把「平台」放到最上面，卡片里只写平台名（v0.18.5 那行按身份写的
     * 小字已经去掉 —— 填什么账号现在由「账号类型」与「登录账号」占位说明）。
     */
    var PLATFORMS = [
      { id: 'pdd', label: '拼多多' },
      { id: 'taobao', label: '淘宝' },
      { id: 'tmall', label: '天猫' },
      { id: 'douyin', label: '抖音' },
      { id: 'jd', label: '京东' },
      { id: 'ali1688', label: '1688' },
    ];
    /**
     * 密码框的小眼睛图标（睁眼 = 明文、闭眼 = 密文）。
     * 用内联 SVG 而不是 emoji：emoji 在不同系统/字号下形状差很远，还会带颜色。
     */
    function eyeIcon(open) {
      var stroke = {
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      };
      var common = Object.assign({ width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, stroke);
      return open
        ? h('svg', common,
          h('path', { d: 'M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12Z' }),
          h('circle', { cx: 12, cy: 12, r: 3.1 }))
        : h('svg', common,
          // 闭眼 = 同一个杏仁轮廓 + 一道斜线（描边图标里最认得出来的"隐藏"写法；
          // 试过瞳孔版和断口版，16px 下都糊成一团）
          h('path', { d: 'M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12Z' }),
          h('path', { d: 'M3 3l18 18' }));
    }

    function platformLabel(id) {
      for (var i = 0; i < PLATFORMS.length; i += 1) if (PLATFORMS[i].id === id) return PLATFORMS[i].label;
      return id;
    }

    /**
     * v0.16.6：平台能力由服务端 `/state` 下发（`platforms[].accountTypes / capabilities`），
     * 避免前端再抄一份「哪个平台支持买家、哪种身份有账号密码」的布尔值。
     * 服务端没给（老宿主/接口异常）时按「只有卖家 + 有密码」这个最保守的默认走。
     */
    function platformMeta(platforms, id) {
      var list = Array.isArray(platforms) ? platforms : [];
      for (var i = 0; i < list.length; i += 1) if (list[i] && list[i].id === id) return list[i];
      return null;
    }
    function accountTypesOf(platforms, id) {
      var m = platformMeta(platforms, id);
      return (m && Array.isArray(m.accountTypes) && m.accountTypes.length) ? m.accountTypes : ['seller'];
    }
    function capsOf(platforms, id, type) {
      var m = platformMeta(platforms, id);
      var c = m && m.capabilities ? m.capabilities[type] : null;
      return c || null;
    }
    /** 这个身份能不能「存密码 + 代填」；拿不到能力表时默认可以（保持旧行为）。 */
    function passwordLoginOf(platforms, id, type) {
      var c = capsOf(platforms, id, type);
      return c ? c.passwordLogin !== false : true;
    }
    /** 登录方式的中文写法：password → 账号密码 / sms → 手机验证码 / qrcode → 扫码。 */
    function loginMethodText(methods) {
      var names = (Array.isArray(methods) ? methods : []).map(function (m) {
        if (m === 'password') return '账号密码';
        if (m === 'sms') return '手机验证码';
        if (m === 'qrcode') return '扫码';
        return String(m || '');
      }).filter(Boolean);
      return names.join(' / ');
    }
    /**
     * v0.18.6：身份标签只写身份本身 —— 「卖家账号」/「买家账号」。
     * 以前选项里带「（商家后台，可上架）」「（C 端，只做浏览与采集）」这类解释，下拉框被撑得很长，
     * 用户看一眼就知道的东西不必写进表头。解释性文字留给字段下面的说明和详情页的「登录方式」卡片。
     */
    function accountTypeOptionLabel(platforms, id, type) {
      void platforms;
      void id;
      return type === 'buyer' ? '买家账号' : '卖家账号';
    }
    /** v0.18.5：「登录账号」填什么的短标签（抖店 = 登录邮箱）。服务端能力位优先，其次按身份兜底。 */
    function loginTagOf(platforms, id, type) {
      var c = capsOf(platforms, id, type);
      return String((c && c.loginNameTag) || '');
    }
    /**
     * v0.17.0：登录方式的中文写法。
     * password = 存密码、打开店铺时自动代填；qrcode = 不存密码，打开窗口扫码/手动登录一次，登录态留在本机档案里。
     */
    function loginModeLabel(mode) {
      return mode === 'qrcode' ? '扫码或手动登录' : '账号密码代填';
    }
    /** 登录方式的可选项（与服务端 LOGIN_MODES 保持同一套文案）。 */
    var LOGIN_MODE_OPTIONS = [['password', '账号密码代填'], ['qrcode', '扫码或手动登录']];

    // ── 样式（只注入一次；工厂每次页面加载只跑一遍，所以这里天然只有一份）──

    var CSS = [
      '.sa-root{display:flex;flex-direction:column;gap:14px;padding:2px 2px 40px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#e8eaed);}',
      '.sa-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.sa-title{margin:0 0 4px;font-size:18px;font-weight:600;}',
      '.sa-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.sa-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      // 状态反馈一律只改颜色：hover / 按压 / 选中都不允许改 padding、border-width、
      // font-weight 或 transform —— 一旦改这些，文字宽度和按钮尺寸会跟着变，点一下"跳一下"。
      '.sa-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;',
      'border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;white-space:nowrap;',
      '-webkit-appearance:none;appearance:none;font-family:inherit;',
      'transition:background-color .12s ease,border-color .12s ease,color .12s ease;}',
      '.sa-btn:hover:not(:disabled){background:rgba(127,127,127,.14);}',
      '.sa-btn:active:not(:disabled){background:rgba(127,127,127,.2);}',
      '.sa-btn:disabled{opacity:.5;cursor:default;}',
      '.sa-btn-primary{background:#2f9e5f;border-color:#2f9e5f;color:#fff;font-weight:600;}',
      '.sa-btn-primary:hover:not(:disabled){background:#37b06b;border-color:#37b06b;}',
      '.sa-btn-primary:active:not(:disabled){background:#2b8f56;border-color:#2b8f56;}',
      '.sa-btn-danger{color:#e5675f;border-color:rgba(229,103,95,.5);}',
      '.sa-btn-danger:hover:not(:disabled){background:rgba(229,103,95,.14);}',
      '.sa-btn-danger:active:not(:disabled){background:rgba(229,103,95,.2);}',
      '.sa-tabs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.sa-tab{padding:5px 13px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font-size:12px;cursor:pointer;',
      '-webkit-appearance:none;appearance:none;font-family:inherit;',
      'transition:background-color .12s ease,border-color .12s ease,color .12s ease;}',
      '.sa-tab:hover:not([data-on="1"]){background:rgba(127,127,127,.1);}',
      // 选中态只用底色/描边区分，不加粗：加粗会让文字变宽，chip 尺寸跟着变（窄屏还可能导致换行）。
      '.sa-tab[data-on="1"]{background:rgba(127,127,127,.24);border-color:rgba(127,127,127,.6);}',
      '.sa-tab:active{background:rgba(127,127,127,.3);}',
      '.sa-search{width:100%;box-sizing:border-box;padding:8px 12px;border-radius:9px;font-size:13px;color:inherit;',
      'border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.07);outline:none;}',
      '.sa-search:focus{border-color:rgba(127,127,127,.55);}',
      // container-type 让下面的 @container 能按"表格实际有多宽"来收列；
      // 顺带给了 inline-size containment —— 表格内容再宽也不会把整页撑出横向滚动条。
      '.sa-list{border:1px solid rgba(127,127,127,.2);border-radius:12px;overflow-x:auto;overflow-y:hidden;container-type:inline-size;}',
      '.sa-rowhead,.sa-row{display:grid;grid-template-columns:minmax(120px,1.6fr) 54px minmax(96px,1fr) minmax(84px,1fr) 60px 132px;',
      'min-width:660px;align-items:center;gap:8px 10px;padding:11px 14px;}',
      '.sa-rowhead>div,.sa-row>div{min-width:0;}',
      // 窄面板（DSH 设置页窗口窄时内容区只有 ~540px）：去掉「调试端口」这一列（端口并到店铺名下面那行），
      // 其余列压缩。6 列硬撑的话整张表要 660px，会让页面横向滚动、"操作"列直接跑到屏幕外。
      '.sa-port-inline{display:none;}',
      '@container (max-width:700px){',
      '  .sa-rowhead,.sa-row{grid-template-columns:minmax(110px,1.7fr) 52px minmax(84px,1.1fr) minmax(74px,1fr) 122px;min-width:0;padding:10px 12px;}',
      '  .sa-c-port{display:none;}',
      '  .sa-port-inline{display:inline;}',
      '  .sa-tag{white-space:nowrap;}',
      '  .sa-schedbtn{font-size:11px;padding:2px 7px;}',
      '  .sa-rowhead{font-size:10px;}',
      '}',
      '.sa-rowhead{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#5b6270);',
      'background:var(--dsw-alias-menu-group-header-fill,rgba(127,127,127,.08));}',
      '.sa-row{border-top:1px solid rgba(127,127,127,.14);}',
      '.sa-row:hover{background:rgba(127,127,127,.06);}',
      '.sa-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sa-note{font-size:11px;color:var(--dsw-alias-label-secondary,#5b6270);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sa-tag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;background:rgba(127,127,127,.16);}',
      '.sa-status{display:flex;align-items:center;gap:6px;font-size:12px;}',
      '.sa-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;}',
      '.sa-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;}',
      '.sa-rowbtns{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;}',
      '.sa-nowrap{flex-wrap:nowrap;}',
      '.sa-pending{border:1px solid rgba(240,173,78,.55);background:rgba(240,173,78,.1);border-radius:12px;padding:12px 14px;',
      'display:flex;flex-direction:column;gap:8px;}',
      '.sa-pending-title{font-weight:600;color:#e0a84e;}',
      '.sa-pending-line{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
      '.sa-card{border:1px solid rgba(127,127,127,.2);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;}',
      '.sa-field{display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:center;}',
      '.sa-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;font-size:12px;color:inherit;',
      'border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.07);outline:none;}',
      '.sa-input:focus{border-color:rgba(127,127,127,.55);}',
      // 下拉框：原生 <select> 的外观在 Windows 上很丑（系统灰箭头、和输入框不同高），
      // 所以去掉原生外观、自己画一个 chevron。箭头用 data URI 的 SVG，中性灰在深浅两套主题下都看得见。
      '.sa-select{appearance:none;-webkit-appearance:none;-moz-appearance:none;cursor:pointer;padding-right:26px;',
      'background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238b93a1%27 stroke-width=%272.2%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M6 9l6 6 6-6%27/%3E%3C/svg%3E");',
      'background-repeat:no-repeat;background-position:right 8px center;background-size:12px 12px;}',
      '.sa-select{transition:border-color .12s ease,background-color .12s ease,box-shadow .12s ease;}',
      '.sa-select:hover{border-color:rgba(127,127,127,.45);background-color:rgba(127,127,127,.11);}',
      // 焦点环：只用键盘 Tab 过来时也看得出落在哪个下拉框上
      '.sa-select:focus{border-color:rgba(127,127,127,.6);box-shadow:0 0 0 3px rgba(127,127,127,.16);}',
      '.sa-select:disabled{opacity:.55;cursor:not-allowed;}',
      // 展开后的选项列表是系统画的，只能给个底色，避免深色主题下"白底黑字/黑底黑字"看不清。
      '.sa-select option{background:var(--dsw-alias-bg-base,#1f2227);color:var(--dsw-alias-label-primary,#e8eaee);}',
      // 密码框右边的小眼睛：透明底、无边框，只靠图标本身；hover/active 才亮起来。
      '.sa-eye{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;',
      'border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6270);cursor:pointer;',
      '-webkit-appearance:none;appearance:none;font-family:inherit;}',
      '.sa-eye:hover{background:rgba(127,127,127,.12);color:var(--dsw-alias-label-primary,inherit);}',
      '.sa-eye:active{background:rgba(127,127,127,.2);}',
      '.sa-eye[data-on="1"]{color:var(--dsw-alias-label-primary,inherit);}',
      '.sa-eye svg{width:16px;height:16px;display:block;}',
      '.sa-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#5b6270);}',
      // 卡片头：标题 + 状态胶囊（一行说清"现在用哪个"）；折叠块内的间距优先走内联样式，
      // 这里只负责「看起来像个整体」的细节（收纳盒底色、分组小标题、折叠箭头）。
      '.sa-cardhead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
      '.sa-chip{font-size:11px;line-height:1.6;padding:1px 8px;border-radius:999px;white-space:nowrap;',
      'background:rgba(127,127,127,.12);color:var(--dsw-alias-label-secondary,#5b6270);}',
      // 「路径与高级选项」不再套一层带底色的方盒（卡片里再嵌一个框，展开后像两块面板叠着，乱）。
      // 现在只用一条上分隔线把它跟「浏览器后端」分开，里面按「分组小标题 + 左标签右输入」排。
      '.sa-adv{border-top:1px solid rgba(127,127,127,.14);}',
      '.sa-adv>summary{list-style:none;cursor:pointer;user-select:none;padding:1px 0;}',
      '.sa-adv>summary::-webkit-details-marker{display:none;}',
      '.sa-advsum{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;',
      'color:var(--dsw-alias-label-secondary,#5b6270);transition:color .12s ease;}',
      '.sa-advsum::before{content:"\\25B8";font-size:10px;line-height:1;transition:transform .15s ease;}',
      '.sa-adv[open]>summary .sa-advsum::before{transform:rotate(90deg);}',
      '.sa-adv>summary:hover .sa-advsum,',
      '.sa-adv[open]>summary .sa-advsum{color:var(--dsw-alias-label-primary,inherit);}',
      // 标签与输入框**顶对齐**：行里有多行说明时，标签不会浮在整块中间。
      '.sa-adv .sa-field{grid-template-columns:88px minmax(0,1fr);gap:10px;align-items:start;}',
      '.sa-adv .sa-field>div:first-child{padding-top:6px;line-height:1.45;}',
      '.sa-adv .sa-input{padding:6px 9px;}',
      '.sa-adv input[type="checkbox"]{margin:2px 0 0;width:14px;height:14px;flex:0 0 auto;accent-color:#2f9e5f;}',
      // 分组小标题右边拉一条发丝线到底：三组才读得出层级，而不是三串同样间距的字段。
      '.sa-grouplabel{display:flex;align-items:center;gap:10px;}',
      '.sa-grouplabel::after{content:"";flex:1 1 auto;height:1px;background:rgba(127,127,127,.13);}',
      '.sa-inline{display:flex;align-items:center;gap:10px;min-width:0;}',
      '.sa-empty{padding:36px 14px;text-align:center;color:var(--dsw-alias-label-secondary,#5b6270);font-size:12px;}',
      '.sa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;}',
      '.sa-dialog{width:min(560px,94vw);max-height:88vh;overflow:hidden;box-sizing:border-box;border-radius:14px;padding:18px;',
      // 注意：这里的底色必须**不透明**。以前用 --dsw-menu-surface-fill（是个带 alpha 的菜单底色，
      // 浅色 #f8f9fa94 / 深色 #43454a73），弹窗会把底下的列表透上来，字叠在一起看不清。
      'background:var(--dsw-alias-bg-base,#1f2227);color:var(--dsw-alias-label-primary,inherit);',
      'border:1px solid rgba(127,127,127,.28);box-shadow:0 24px 64px rgba(0,0,0,.5);',
      'display:flex;flex-direction:column;gap:14px;}',
      // 正文单独滚，底部按钮永远留在视野里（窗口矮的时候「保存排期」不能被挤出去）。
      '.sa-dialog-body{display:flex;flex-direction:column;gap:14px;flex:1 1 auto;min-height:0;overflow:auto;padding-right:2px;}',
      '.sa-dialog-title{font-size:15px;font-weight:600;margin:0;}',
      '.sa-plats{display:flex;gap:10px;flex-wrap:wrap;}',
      '.sa-plat{flex:1 1 140px;text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer;',
      'border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;',
      '-webkit-appearance:none;appearance:none;font-family:inherit;',
      'transition:background-color .12s ease,border-color .12s ease;}',
      '.sa-plat:hover:not([data-on="1"]){background:rgba(127,127,127,.08);}',
      '.sa-plat[data-on="1"]{border-color:#2f9e5f;background:rgba(47,158,95,.14);}',
      '.sa-plat:active{background:rgba(127,127,127,.16);}',
      '.sa-plat-label{font-weight:600;font-size:13px;}',
      '.sa-dialog-foot{display:flex;justify-content:flex-end;gap:8px;}',
      '.sa-toasts{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:8px;z-index:10000;}',
      '.sa-toast{padding:9px 14px;border-radius:10px;font-size:12px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,.4);',
      'background:var(--dsw-alias-bg-base,#22252a);border:1px solid rgba(127,127,127,.3);}',
      '.sa-toast[data-kind="ok"]{border-color:rgba(47,158,95,.6);}',
      '.sa-toast[data-kind="err"]{border-color:rgba(229,103,95,.6);}',
      // ── 店铺详情页（列表里每行的「管理」）──
      '.sa-detail{display:flex;flex-direction:column;gap:14px;}',
      '.sa-dhead{display:flex;align-items:center;gap:10px;}',
      '.sa-back{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;border-radius:8px;font-size:15px;cursor:pointer;',
      'border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;}',
      '.sa-back:hover{background:rgba(127,127,127,.14);}',
      '.sa-dtitle{font-size:16px;font-weight:600;}',
      '.sa-dlist{border:1px solid rgba(127,127,127,.2);border-radius:12px;overflow:hidden;}',
      '.sa-drow{display:grid;grid-template-columns:150px 1fr;gap:14px;align-items:start;padding:13px 16px;border-top:1px solid rgba(127,127,127,.14);}',
      '.sa-drow:first-child{border-top:0;}',
      '.sa-dlabel{font-size:13px;color:var(--dsw-alias-label-secondary,#5b6270);padding-top:2px;}',
      '.sa-dvalue{display:flex;flex-direction:column;align-items:flex-end;gap:8px;}',
      '.sa-dtext{font-size:13px;text-align:right;}',
      '.sa-dfoot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
      '.sa-link-danger{background:transparent;border:0;padding:0;color:#e5675f;font-size:13px;cursor:pointer;}',
      '.sa-link-danger:hover:not(:disabled){text-decoration:underline;}',
      '.sa-link-danger:disabled{opacity:.5;cursor:default;}',
      // ── 详情页重排：工具条并进头部，资料卡只留可编辑项，底部只留两个关键动作 ──
      '.sa-dsec{border:1px solid rgba(127,127,127,.2);border-radius:12px;overflow:hidden;}',
    '.sa-dsec-title{font-size:12px;font-weight:600;opacity:.75;margin:0 0 6px;}',
      '.sa-dtop{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:13px 16px 10px;}',
      '.sa-dtitlewrap{display:flex;align-items:center;gap:10px;min-width:0;}',
      '.sa-dtitles{min-width:0;}',
      '.sa-dmeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.sa-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11px;',
      'border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.08);}',
      '.sa-pill[data-tone="ok"]{border-color:rgba(47,158,95,.45);background:rgba(47,158,95,.14);}',
      '.sa-pill[data-tone="err"]{border-color:rgba(229,103,95,.45);background:rgba(229,103,95,.14);}',
      '.sa-pill[data-tone="warn"]{border-color:rgba(240,173,78,.45);background:rgba(240,173,78,.12);}',
      '.sa-dtools{display:flex;gap:6px;flex-wrap:wrap;padding:10px 16px;border-top:1px solid rgba(127,127,127,.14);',
      'background:rgba(127,127,127,.045);}',
      '.sa-dcard{padding:12px 16px 4px;}',
      '.sa-dcard .sa-drow{padding:9px 0;}',
      '.sa-dsave{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:2px 16px 14px;}',
      // 定时检测：顶部横幅（仿参考软件：左边两行文字、右边胶囊按钮、整体一行）+ 行内开关 + 排期弹窗
      '.sa-schedbar{display:flex;align-items:center;justify-content:space-between;gap:14px;',
      'border:1px solid rgba(63,185,80,.35);background:rgba(63,185,80,.08);border-radius:12px;padding:12px 14px;}',
      '.sa-schedbar[data-on="0"]{border-color:rgba(127,127,127,.28);background:rgba(127,127,127,.055);}',
      '.sa-schedmain{display:flex;flex-direction:column;gap:3px;min-width:0;}',
      '.sa-schedtitle{font-weight:600;font-size:13.5px;line-height:1.35;}',
      '.sa-schedsub{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#5b6270);}',
      '.sa-schedpill{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;white-space:nowrap;',
      'padding:5px 14px;border-radius:999px;font-size:12px;cursor:pointer;',
      'border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;',
      '-webkit-appearance:none;appearance:none;font-family:inherit;',
      'transition:background-color .12s ease,border-color .12s ease;}',
      '.sa-schedpill:hover{background:rgba(127,127,127,.12);}',
      '.sa-schedpill:active{background:rgba(127,127,127,.2);}',
      '.sa-schedcell{display:flex;flex-direction:column;align-items:center;gap:4px;}',
      '.sa-schedbtn{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11px;',
      'cursor:pointer;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08);color:inherit;',
      '-webkit-appearance:none;appearance:none;font-family:inherit;',
      'transition:background-color .12s ease,border-color .12s ease;}',
      '.sa-schedbtn:hover:not(:disabled){background:rgba(127,127,127,.16);}',
      '.sa-schedbtn[data-on="1"]{border-color:rgba(63,185,80,.55);background:rgba(63,185,80,.18);}',
      '.sa-schedbtn:active:not(:disabled){background:rgba(127,127,127,.24);}',
      '.sa-schedbtn:disabled{opacity:.5;cursor:default;}',
      '.sa-link{background:transparent;border:0;padding:0;color:inherit;opacity:.9;font-size:11px;cursor:pointer;',
      'text-decoration:underline;text-underline-offset:2px;-webkit-appearance:none;appearance:none;font-family:inherit;}',
      '.sa-link:hover{opacity:1;}',
      '.sa-link:active{opacity:.7;}',
      '.sa-plist{display:flex;flex-direction:column;flex:0 0 auto;border:1px solid rgba(127,127,127,.2);border-radius:10px;overflow:hidden;}',
      '.sa-pitem{display:grid;grid-template-columns:16px 52px 56px 1fr auto;gap:8px;align-items:center;padding:8px 12px;',
      'border-top:1px solid rgba(127,127,127,.12);font-size:12px;}',
      '.sa-pitem:first-child{border-top:0;}',
      '.sa-pitem[data-off="1"]{opacity:.55;}',
      // 拖起来的那行**不要变透明**（用户明确要求不透明）：改成实底 + 绿描边，一眼看得出「正拿着它」。
      '.sa-pitem[data-drag="1"]{opacity:1;background:color-mix(in srgb, #2f9e5f 16%, var(--dsw-alias-bg-base,#22252a));',
      'box-shadow:inset 0 0 0 1px rgba(47,158,95,.75),0 4px 14px rgba(0,0,0,.25);border-radius:8px;}',
      // 拖到哪一行，那一行整行描边当插入位提示。
      '.sa-pitem[data-drag="2"]{background:rgba(127,127,127,.1);box-shadow:inset 0 0 0 1px rgba(127,127,127,.6);border-radius:8px;}',
      '.sa-handle{cursor:grab;color:var(--dsw-alias-label-secondary,#5b6270);font-size:13px;line-height:1;user-select:none;}',
      '.sa-handle:active{cursor:grabbing;}',
      // 弹窗如果在 max-height 里被挤，别让这列表被 flex 压扁（以前会压成 4px，行全看不见）；
      // 让它按内容高度长，太高就自己滚。
      '.sa-scroll{flex:0 0 auto;max-height:min(42vh,340px);overflow:auto;}',
    ].join('');

    function injectCss() {
      try {
        if (typeof document === 'undefined') return;
        // 每次都把旧的同名 <style> 删掉再插新的：插件被热重挂载时，旧样式节点会留在页面里，
        // 之前这里「已有同 id 就 return」会让新 JSX 配上几版前的旧 CSS（按钮跑回左边、绿底绿字），
        // 页面看起来像坏了，其实只是样式没更新。
        var olds = document.querySelectorAll('style#dsh-shop-accounts-css');
        for (var i = 0; i < olds.length; i++) {
          if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
        }
        var el = document.createElement('style');
        el.id = 'dsh-shop-accounts-css';
        el.textContent = CSS;
        (document.head || document.documentElement).appendChild(el);
      } catch (err) { /* 样式失败不影响功能 */ }
    }

    // ── HTTP ──────────────────────────────────────────────────────────────────

    function api(pathname, options) {
      var opts = options || {};
      var method = opts.method || 'GET';
      var headers = { 'X-DSH-Shop-Accounts': '1' };
      var hasBody = opts.body !== undefined && opts.body !== null;
      // 非 GET 一律带 JSON Content-Type + 一个对象体（宿主新门禁要求写请求必须是 application/json）。
      // 以前没 body 的 POST（如 /ego/start）会不带 Content-Type，加固后会被 415 挡掉。
      var isWrite = method !== 'GET' && method !== 'HEAD';
      if (isWrite) headers['Content-Type'] = 'application/json';
      return fetch(BASE + pathname, {
        method: method,
        headers: headers,
        body: isWrite ? JSON.stringify(hasBody ? opts.body : {}) : undefined,
        cache: 'no-store',
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { ok: false, error: '返回不是 JSON：' + text.slice(0, 200) }; }
          if (!res.ok || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status));
          return data;
        });
      });
    }

    // ── 客户端报错上报（v0.17.9）──────────────────────────────────────────────
    //
    // 设置页的条目一旦抛异常，宿主会用 SlotErrorBoundary 兜住、把内容换成空 div ——
    // 界面上只剩一片空白，而渲染进程的 console 又没有落到宿主日志里，事后无从查起。
    // 这里在页面侧装钩子：console.error / window.onerror / unhandledrejection 抓到的
    // 第一条错误 POST 回宿主，落进 <数据目录>/client-errors.log（同一条只报一次）。
    var reportedClientErrors = {};

    function reportClientError(source, err, where) {
      try {
        var message = '';
        var stack = '';
        if (err && typeof err === 'object') {
          message = String(err.message || err.reason || err);
          stack = String(err.stack || '');
        } else {
          message = String(err);
        }
        var key = source + '|' + (where || '') + '|' + message.slice(0, 200);
        if (reportedClientErrors[key]) return;
        reportedClientErrors[key] = true;
        api('/client-error', {
          method: 'POST',
          body: { source: source, where: where || '', message: message, stack: stack },
        }).catch(function () { /* 上报失败也不能影响页面 */ });
      } catch (e) { /* 同上 */ }
    }

    function installClientErrorReporting() {
      try {
        if (typeof window === 'undefined' || window.__dshShopAccountsErrorHook) return;
        window.__dshShopAccountsErrorHook = true;
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          var origError = console.error.bind(console);
          console.error = function () {
            try {
              var parts = [];
              for (var i = 0; i < arguments.length; i += 1) {
                var a = arguments[i];
                parts.push(a && a.stack ? String(a.stack) : String(a));
              }
              reportClientError('console.error', { message: parts.join(' | '), stack: '' }, 'console');
            } catch (e) { /* ignore */ }
            return origError.apply(console, arguments);
          };
        }
        window.addEventListener('error', function (ev) {
          reportClientError('window.error', (ev && (ev.error || ev.message)) || 'unknown', String((ev && ev.filename) || ''));
        });
        window.addEventListener('unhandledrejection', function (ev) {
          reportClientError('unhandledrejection', (ev && ev.reason) || 'unknown', '');
        });
      } catch (e) { /* 装钩子失败也不许影响页面 */ }
    }

    // ── 小工具 ────────────────────────────────────────────────────────────────

    function fmtTime(iso) {
      if (!iso) return '—';
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        var p = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      } catch (e) { return String(iso); }
    }

    /**
     * v0.9.2：把服务端「打开店铺时顺带做的账密登录」结果翻成一句人话。
     * 返回 '' 表示这次打开没有代填（没存密码 / 明确要求只打开）。
     */
    function autofillNote(r) {
      var af = r && r.autofill;
      if (!af || !af.attempted) return '';
      if (af.loggedIn) return '；已用保存的账号密码自动登录成功';
      return '；账密代填：' + (af.hint || af.code || '已填表，请在窗口里确认');
    }

    function statusOf(account) {
      if (account.pendingLogin) return { color: '#e0a84e', text: '等待登录', tone: 'warn' };
      var check = account.lastCheck;
      // 上一次检测"没测成"（ego 没开 / 超时 / 无头浏览器起不来）：这不是"登录失效" ——
      // 后端已经不拿失败结果覆盖 lastCheck 了（v0.8.1），这里只在还没有任何结论时提示一句。
      var checkErr = account.lastCheckError;
      if (checkErr && !check) return { color: '#8b9096', text: '检测失败', tone: 'idle', title: checkErr };
      if (account.running && (!check || check.stale)) return { color: '#e0a84e', text: '运行中·待检测', tone: 'warn' };
      if (check && check.loggedIn) return { color: '#3fb950', text: '已登录', tone: 'ok' };
      if (check && check.loggedIn === false) {
        // 以前登录过、现在判为未登录 = 掉线了，得重新扫码 —— 这种要说清楚，别只写"未登录"
        if (account.lastLoginAt) return { color: '#e5675f', text: '登录已失效', tone: 'err' };
        return { color: '#e5675f', text: '未登录', tone: 'err' };
      }
      if (checkErr) return { color: '#8b9096', text: '检测失败', tone: 'idle', title: checkErr };
      return { color: '#8b9096', text: '未检测', tone: 'idle' };
    }

    // ── 组件 ──────────────────────────────────────────────────────────────────

    function Toast(props) {
      var list = props.list;
      if (!list.length) return null;
      return h('div', { className: 'sa-toasts' },
        list.map(function (t) { return h('div', { key: t.id, className: 'sa-toast', 'data-kind': t.kind }, t.text); }));
    }

    function Field(props) {
      return h('div', { className: 'sa-field' },
        h('div', { className: 'sa-hint' }, props.label),
        h('div', null, props.children));
    }

    /**
     * 数字输入：`<input type="number">`。
     *
     * 历史：v0.6.3 曾在旁边加过「− / +」按钮（因为用户反馈「每组店铺数打字没反应」），
     * 但 `type=number` 自带上下箭头，两个并存显得重复，v0.6.4 按用户要求把自定义加减删掉了。
     * 仍然保留 `type=number`：原生上下箭头能点、键盘 ↑↓ 也管用，且浏览器会自己过滤非法字符
     * （别再用 replace(/[^\d]/) 过滤 —— 那会把全角数字直接吞掉）。
     */
    function NumberField(props) {
      var value = props.value;
      var onChange = props.onChange;
      var min = props.min != null ? props.min : 0;
      var max = props.max != null ? props.max : 9999;
      var step = props.step || 1;
      var allowEmpty = Boolean(props.allowEmpty);
      function commit(n) {
        if (!isFinite(n)) return;
        onChange(String(Math.min(max, Math.max(min, Math.round(n)))));
      }
      return h('input', {
        className: 'sa-input', type: 'number', inputMode: 'numeric',
        min: String(min), max: String(max), step: String(step),
        value: value, placeholder: props.placeholder || '',
        onChange: function (e) {
          var v = e.target.value;
          // 空着 = 交给调用方决定含义（比如「每组店铺数」留空就是自动）。
          if (v === '') { if (allowEmpty) onChange(''); return; }
          commit(parseInt(v, 10));
        },
      });
    }

    /** 新增 / 编辑店铺的弹窗。 */
    function AccountDialog(props) {
      var editing = props.account || null;
      var [platform, setPlatform] = React.useState(editing ? editing.platform : 'pdd');
      var [name, setName] = React.useState(editing ? editing.name : '');
      // v0.9.1：新建时就能填「登录账号」和「密码」（都可留空）。
      // 密码走本机密钥后端 + AES-256-GCM 加密库落盘；打开店铺时会用它自动代填一次账密登录。
      var [loginName, setLoginName] = React.useState(editing ? (editing.loginName || '') : '');
      var [pw, setPw] = React.useState('');
      var [showPw, setShowPw] = React.useState(false);
      var [note, setNote] = React.useState(editing ? editing.note : '');
      var [profileDir, setProfileDir] = React.useState('');
      var [port, setPort] = React.useState('');
      // v0.9.0：账号类型（卖家/买家）。买家账号走 C 端登录入口，只做浏览与采集，不做上架。
      // v0.16.6：可选身份由平台决定（抖音 C 端网页端被风控挡住，没有买家身份）。
      var [accountType, setAccountType] = React.useState(editing ? (editing.accountType || 'seller') : 'seller');
      var [wipe, setWipe] = React.useState(false);
      var [busy, setBusy] = React.useState(false);
      // v0.17.0：登录方式。记得住账号密码的用「账号密码代填」；记不住的选「扫码或手动登录」，
      // 打开窗口扫码/登录一次就行，登录态留在本机档案里 —— 不再逼着用户填密码。
      var [loginMode, setLoginMode] = React.useState(editing ? (editing.loginMode || 'password') : 'password');
      // 当前平台允许的身份 + 当前身份能不能密码登录（决定密码框出不出、必不必填）
      var types = accountTypesOf(props.platforms, platform);
      var type = types.indexOf(accountType) >= 0 ? accountType : 'seller';
      var canPassword = passwordLoginOf(props.platforms, platform, type);
      var mode = canPassword ? loginMode : 'qrcode';
      var needsPassword = canPassword && mode === 'password';
      // v0.17.2：每个平台的「登录账号」填什么不一样（抖店必须是邮箱），文字从平台能力位来
      var caps = capsOf(props.platforms, platform, type) || {};
      var loginHint = String(caps.loginNameHint || '');
      // v0.18.5：「登录账号」这一栏填什么（抖店 = 登录邮箱、淘宝 = 旺旺名、1688 = 会员名…）。
      // 字段标题、输入框占位、必填报错都用它 —— 不再写死一句通用的登录账号提示。
      var loginTag = loginTagOf(props.platforms, platform, type);
      // v0.18.10：买家（C 端）说的是「用户」—— 表单里叫「用户名 / 用户账户」，卖家继续用「店铺名 / 登录账号」。
      var isBuyer = type === 'buyer';
      var nameLabel = isBuyer ? '用户名' : '店铺名';
      var accountLabel = isBuyer ? '用户账户' : '登录账号';

      function submit() {
        setBusy(true);
        var done = function () { setBusy(false); props.onClose(); };
        var fail = function (err) { setBusy(false); props.onError(err.message || String(err)); };
        if (editing) {
          api('/accounts/' + encodeURIComponent(editing.id), {
            method: 'PUT',
            body: {
              name: name,
              note: note,
              loginName: loginName,
              accountType: type,
              loginMode: mode,
              profileDir: profileDir || undefined,
              port: /^\d+$/.test(port) ? parseInt(port, 10) : undefined,
            },
          }).then(function () {
            if (wipe) {
              // 「同时删除档案」是**删除整个账号**（不是只清档案），必须让用户再确认一次：
              // 以前流程里没有确认，勾了就会在保存后直接删号（2026-10-31 审查）。
              var who = name || editing.name || editing.id;
              var ok = true;
              try {
                ok = window.confirm('这会把「' + who + '」这个账号记录连它的浏览器档案目录一起删除，不可恢复。确定吗？');
              } catch (e) { ok = true; }
              if (!ok) { props.onInfo('已保存（没有删除账号）'); return null; }
              return api('/accounts/' + encodeURIComponent(editing.id), { method: 'DELETE', body: { deleteProfile: true } })
                .then(function (r) {
                  props.onInfo(r && r.deletedProfile === false
                    ? '账号已删除（档案目录在档案根之外，插件没有删它）'
                    : '已删除该账号及其浏览器档案目录');
                });
            }
            props.onInfo('已保存');
            return null;
          }).then(done).catch(fail);
          return;
        }
        // 必填项先在前端拦一次：别把「只有平台和名字」的半成品记录发到后端
        if (!String(loginName || '').trim()) {
          setBusy(false);
          props.onError('「' + accountLabel + '」必填');
          return;
        }
        if (needsPassword && !pw) {
          setBusy(false);
          props.onError('「登录密码」必填');
          return;
        }
        api('/accounts', {
          method: 'POST',
          body: {
            platform: platform,
            name: name,
            note: note,
            loginName: loginName,
            password: needsPassword ? (pw || undefined) : undefined,
            accountType: type,
            loginMode: mode,
            profileDir: profileDir || undefined,
            port: /^\d+$/.test(port) ? parseInt(port, 10) : undefined,
          },
        }).then(function (r) {
          var acc = r && r.account;
          if (!acc || !acc.id) throw new Error('后端没有返回新账号');
          if (r && r.passwordError) {
            props.onError('店铺已创建，但密码没存上：' + r.passwordError + '（进详情页可以重试）');
          } else if (r && r.passwordSkipped) {
            props.onInfo(r.passwordSkipped);
          }
          props.onCreated(acc);
        }).then(done).catch(fail);
      }

      return h('div', { className: 'sa-overlay', onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); } },
        h('div', { className: 'sa-dialog' },
          h('h3', { className: 'sa-dialog-title' },
            editing ? (isBuyer ? '编辑用户' : '编辑店铺') : (isBuyer ? '新增用户' : '新增卖家账号')),
          h('div', { className: 'sa-dialog-body' },

          // v0.18.8：平台放在最上面 —— 先点平台，下面才知道该选哪种身份。没有表头，卡片里只写平台名。
          !editing && h('div', { className: 'sa-plats' },
            PLATFORMS.map(function (p) {
              return h('button', {
                key: p.id,
                className: 'sa-plat',
                'data-on': platform === p.id ? '1' : '0',
                onClick: function () {
                  setPlatform(p.id);
                  // 换平台后身份可能不受支持（比如抖音没有买家身份）→ 自动落回卖家
                  if (accountTypesOf(props.platforms, p.id).indexOf(type) < 0) setAccountType('seller');
                },
              }, h('div', { className: 'sa-plat-label' }, p.label));
            })),

          // v0.18.5：身份先选，后面「登录方式」与「登录账号」的占位才知道按卖家还是买家算。
          h(Field, { label: '账号类型' },
            h('select', {
              className: 'sa-input sa-select', value: type,
              onChange: function (e) { setAccountType(e.target.value); },
            },
              types.map(function (t) {
                return h('option', { key: t, value: t }, accountTypeOptionLabel(props.platforms, platform, t));
              }))),

          // v0.18.7：登录方式紧跟在平台与身份之后 —— 它决定后面填不填密码。
          !editing && canPassword && h(Field, { label: '登录方式' },
            h('div', { className: 'sa-tabs', role: 'group' },
              LOGIN_MODE_OPTIONS.map(function (m) {
                return h('button', {
                  key: m[0], type: 'button', className: 'sa-tab',
                  'data-on': mode === m[0] ? '1' : '0',
                  onClick: function () { setLoginMode(m[0]); },
                }, m[1]);
              }))),

          // 没有账号密码可存的身份（抖音买家等）：这里只留一句怎么登录，不再要求密码。
          !editing && !canPassword && h(Field, { label: '登录方式' },
            h('div', { className: 'sa-hint', style: { margin: 0 } },
              platformLabel(platform) + (isBuyer ? ' 用户只能用「' : ' 只能用「')
              + (loginMethodText((capsOf(props.platforms, platform, type) || {}).loginMethods) || '人工')
              + '」登录。')),

          h(Field, { label: nameLabel },
            h('input', {
              className: 'sa-input', value: name,
              placeholder: isBuyer ? '例如：用户名（留空自动起名）' : '例如：某品牌旗舰店（留空自动起名）',
              onChange: function (e) { setName(e.target.value); },
            })),

          // v0.18.7：表头只写「必填」，这个平台到底填什么（抖店 = 登录邮箱）放进输入框占位。
          h(Field, { label: accountLabel + '（必填）' },
            h('input', {
              className: 'sa-input', value: loginName,
              placeholder: loginTag ? ('例如：' + loginTag) : (loginHint || '填登录用的账号名'),
              onChange: function (e) { setLoginName(e.target.value); },
            })),

          // v0.16.6：只有「这个身份真的有账号密码登录」才要求填密码。
          // 拼多多 C 端只有手机验证码/扫码（实测页面里没有密码框），这里就换成一行说明，不再挡着建号。
          // v0.17.0：选了「扫码或手动登录」也不要求填密码（用户明确表示不存密码）。
          !editing && needsPassword && h(Field, { label: '登录密码（必填）' },
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('input', {
                className: 'sa-input', value: pw,
                type: showPw ? 'text' : 'password',
                autoComplete: 'new-password',
                placeholder: '本机加密保存，打开店铺时用它自动登录',
                onChange: function (e) { setPw(e.target.value); },
              }),
              h('button', {
                className: 'sa-eye', type: 'button',
                'data-on': showPw ? '1' : '0',
                title: showPw ? '隐藏密码' : '显示密码',
                'aria-label': showPw ? '隐藏密码' : '显示密码',
                onClick: function () { setShowPw(!showPw); },
              }, eyeIcon(showPw)))),

          h(Field, { label: '备注' },
            h('input', {
              className: 'sa-input', value: note, placeholder: isBuyer ? '例如：平台·用户·用途（选填）' : '例如：平台·店铺·运营（选填）',
              onChange: function (e) { setNote(e.target.value); },
            })),

          !editing && h(Field, { label: '已有浏览器目录' },
            h('input', {
              className: 'sa-input', value: profileDir,
              placeholder: '留空 = 新建一份干净档案（推荐）',
              onChange: function (e) { setProfileDir(e.target.value); },
            })),

          h(Field, { label: '调试端口' },
            h('input', {
              className: 'sa-input', value: port, placeholder: '留空 = 自动分配（9222 起）',
              onChange: function (e) { setPort(e.target.value.replace(/[^\d]/g, '')); },
            })),

          editing && h('label', { className: 'sa-hint', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: wipe, onChange: function (e) { setWipe(e.target.checked); } }),
            '同时删除这个账号（记录 + 磁盘上的浏览器档案目录，连同登录态，不可恢复）')),

          h('div', { className: 'sa-dialog-foot' },
            h('button', { className: 'sa-btn', onClick: props.onClose, disabled: busy }, '取消'),
            h('button', { className: 'sa-btn sa-btn-primary', onClick: submit, disabled: busy },
              busy ? '处理中…' : (editing ? '保存' : '创建并去登录')))));
    }

    /**
     * 一个店铺的详情页 —— 列表里每行的「管理」入口。
     * 版式对齐用户原来那套账号工具的「管理」页：平台 / 店铺名 / 账号 / 账号类型 / 登录状态，
     * 左下「删除账号」、右下「重新登录」；其余动作用来不丢功能（检测 / 打开工作台 / 重扫 / 复制档案路径 / 编辑）。
     */
    function AccountDetail(props) {
      var a = props.account;
      var st = statusOf(a);
      var [loginName, setLoginName] = React.useState(a.loginName || '');
      var [accountType, setAccountType] = React.useState(a.accountType || 'seller');
      var [saving, setSaving] = React.useState(false);
      var [removing, setRemoving] = React.useState(false);
      var busy = props.busyId || '';
      // v0.9.0：密码（本机加密，只用于代填）与采集配置
      var [pw, setPw] = React.useState('');
      var [showPw2, setShowPw2] = React.useState(false);
      var [pwBusy, setPwBusy] = React.useState(false);
      var [autoBusy, setAutoBusy] = React.useState(false);
      // v0.16.0：采集卡片只管「采什么」；跑不跑 / 几点跑统一到排期（schedEnabled + 全局排期槽位时间）
      var [collDomains, setCollDomains] = React.useState((a.collection && a.collection.domains) || []);
      var [collBusy, setCollBusy] = React.useState(false);
      var [schedBusy, setSchedBusy] = React.useState(false);
      var vaultOk = Boolean(props.vault && props.vault.available);
      // v0.16.6：这个店铺可选的身份 & 当前身份有没有账号密码登录
      var types = accountTypesOf(props.platforms, a.platform);
      var type = types.indexOf(accountType) >= 0 ? accountType : 'seller';
      // v0.17.0：登录方式（账号密码代填 / 扫码或手动登录）—— 切换后保存即生效
      var [loginMode, setLoginMode] = React.useState(a.loginMode || 'password');
      var pwLogin = passwordLoginOf(props.platforms, a.platform, type)
        && !(a.capabilities && a.capabilities.passwordLogin === false);
      var mode = pwLogin ? loginMode : 'qrcode';
      var usePassword = pwLogin && mode === 'password';
      // v0.18.5：「账号」这一栏的占位提示也按平台 + 身份走（抖店 = 登录邮箱…）
      var loginTag = loginTagOf(props.platforms, a.platform, type);
      // v0.18.10：买家账号在详情页也叫「用户」—— 「用户账户 / 用户端 / 编辑用户」，卖家仍用店铺那套说法。
      var isBuyer = type === 'buyer';
      var dirty = loginName !== (a.loginName || '')
        || type !== (a.accountType || '') || (pwLogin && mode !== (a.loginMode || 'password'));

      function save() {
        setSaving(true);
        api('/accounts/' + encodeURIComponent(a.id), {
          method: 'PUT',
          body: { loginName: loginName, accountType: type, loginMode: mode },
        }).then(function () {
          setSaving(false);
          props.onInfo(isBuyer ? '用户资料已保存' : '店铺资料已保存');
          return props.reload();
        }).catch(function (err) { setSaving(false); props.onError(err.message || String(err)); });
      }

      function remove() {
        if (!window.confirm((isBuyer ? '删除用户「' : '删除店铺「') + a.name + '」的记录？\n\n（浏览器档案目录会保留：登录态还在，以后还能导回来）')) return;
        setRemoving(true);
        api('/accounts/' + encodeURIComponent(a.id), { method: 'DELETE', body: {} })
          .then(function () { setRemoving(false); props.onInfo('已删除「' + a.name + '」'); props.onBack(); return props.reload(); })
          .catch(function (err) { setRemoving(false); props.onError(err.message || String(err)); });
      }

      function copyPath() {
        var text = a.profileDir || '';
        if (!text) { props.onError('这个账号还没分配档案目录'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () { props.onInfo('已复制档案路径：' + text); },
            function () { props.onError('复制失败，请手动复制：' + text); });
        } else { props.onError('这个环境不给读剪贴板：' + text); }
      }

      function savePw() {
        if (!pw) { props.onError('先填密码再保存'); return; }
        setPwBusy(true);
        api('/accounts/' + encodeURIComponent(a.id) + '/password', { method: 'PUT', body: { password: pw } })
          .then(function (r) { setPwBusy(false); setPw(''); props.onInfo('密码已加密保存到本机（不落账号表、不上传）'); return props.reload(); })
          .catch(function (err) { setPwBusy(false); props.onError(err.message || String(err)); });
      }

      function clearPw() {
        if (!window.confirm('删除「' + a.name + '」保存的密码？之后只能手动登录。')) return;
        setPwBusy(true);
        api('/accounts/' + encodeURIComponent(a.id) + '/password', { method: 'DELETE' })
          .then(function () { setPwBusy(false); props.onInfo('已删除保存的密码'); return props.reload(); })
          .catch(function (err) { setPwBusy(false); props.onError(err.message || String(err)); });
      }

      function doAutoLogin() {
        // v0.9.2：不再弹 confirm —— 「打开店铺」已经会自动账密登录，这个按钮只是掉线后的重新登录入口。
        setAutoBusy(true);
        api('/accounts/' + encodeURIComponent(a.id) + '/autologin', { method: 'POST', body: {} })
          .then(function (r) {
            setAutoBusy(false);
            var res = (r && r.result) || {};
            if (res.loggedIn) props.onInfo('已代填并登录成功');
            else props.onInfo((res.hint || res.reason || '已尝试代填，请在窗口里确认'));
            return props.reload();
          })
          .catch(function (err) { setAutoBusy(false); props.onError(err.message || String(err)); });
      }

      function toggleDomain(id) {
        setCollDomains(function (prev) {
          return prev.indexOf(id) >= 0 ? prev.filter(function (x) { return x !== id; }) : prev.concat([id]);
        });
      }

      function saveColl() {
        setCollBusy(true);
        api('/accounts/' + encodeURIComponent(a.id) + '/collection', {
          method: 'PUT',
          body: { domains: collDomains },
        }).then(function (r) {
          setCollBusy(false);
          props.onInfo((r && r.note) || '采集域已保存');
          return props.reload();
        })
          .catch(function (err) { setCollBusy(false); props.onError(err.message || String(err)); });
      }

      // v0.16.0：这个按钮和「定时任务」表里的开启/暂停是**同一个开关**（都是账号的 schedEnabled），
      // 不是第二套开关 —— 点哪边都一样，刷新后两边同步。
      function toggleSched() {
        var next = !(a.schedEnabled !== false);
        setSchedBusy(true);
        api('/accounts/' + encodeURIComponent(a.id) + '/schedule', { method: 'POST', body: { enabled: next } })
          .then(function () {
            setSchedBusy(false);
            props.onInfo(next ? '已加入定时采集（到点按排期跑）' : '已暂停这个店铺的定时采集');
            return props.reload();
          })
          .catch(function (err) { setSchedBusy(false); props.onError(err.message || String(err)); });
      }

      function copyCollectPrompt() {
        api('/accounts/' + encodeURIComponent(a.id) + '/collect-prompt').then(function (r) {
          var text = (r && r.prompt) || '';
          if (!text) throw new Error('后端没有返回提示词');
          if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () { props.onInfo('采集任务提示词已复制，粘给 agent 执行即可'); });
          }
          props.onError('这个环境不给读剪贴板');
        }).catch(function (err) { props.onError(err.message || String(err)); });
      }

      function row(label, value) {
        return h('div', { className: 'sa-drow' }, h('div', { className: 'sa-dlabel' }, label), value);
      }
      function plain(value) {
        return h('div', { className: 'sa-dvalue' }, h('div', { className: 'sa-dtext' }, value));
      }
      function input(value, onChange, placeholder) {
        return h('div', { className: 'sa-dvalue', style: { width: '100%' } },
          h('input', {
            className: 'sa-input', value: value, placeholder: placeholder,
            onChange: function (e) { onChange(e.target.value); },
          }));
      }

      var live = a.pendingLogin ? '等待登录中' : (a.running ? '浏览器运行中' : '浏览器未运行');

      return h('div', { className: 'sa-detail' },
        h('div', { className: 'sa-dsec' },
          h('div', { className: 'sa-dtop' },
            h('div', { className: 'sa-dtitlewrap' },
              h('button', { className: 'sa-back', title: '返回列表', onClick: props.onBack }, '\u2190'),
              h('div', { className: 'sa-dtitles' },
                h('div', { className: 'sa-dtitle' }, a.name),
                h('div', { className: 'sa-dmeta' },
                  h('span', { className: 'sa-tag' }, platformLabel(a.platform)),
                  a.note && h('span', null, a.note),
                  h('span', { className: 'sa-pill', 'data-tone': st.tone || 'none', title: st.title || null },
                    h('span', { className: 'sa-dot', style: { background: st.color } }), st.text),
                  a.backend === 'egolite'
                    ? h('span', { className: 'sa-mono', title: 'ego profile / TaskSpace' },
                      (a.egoProfile || '未分配 profile') + (a.egoSpace ? ' · ' + a.egoSpace : ''))
                    : (a.port ? h('span', { className: 'sa-mono' }, ':' + a.port) : null),
                  h('span', null, live)))),
            h('div', { className: 'sa-hint', style: { textAlign: 'right' } },
              h('div', null, a.lastCheckAt ? '检测于 ' + fmtTime(a.lastCheckAt) : '还没检测过'),
              a.lastCheck && a.lastCheck.tokenExpiry
                ? h('div', null, '凭证到期 ' + fmtTime(a.lastCheck.tokenExpiry).slice(0, 10)) : null,
              a.lastCheck && a.lastCheck.keptAliveSec
                ? h('div', null, '保活停留 ' + a.lastCheck.keptAliveSec + ' 秒') : null,
              a.lastLoginAt && h('div', null, '上次登录 ' + fmtTime(a.lastLoginAt)))),
          h('div', { className: 'sa-dtools' },
            h('button', {
              className: 'sa-btn', disabled: busy === a.id + ':silent-check',
              onClick: function () { props.silentCheck(a); },
            }, busy === a.id + ':silent-check' ? '检测中…' : '检测登录态'),
            a.running
              ? h('button', {
                className: 'sa-btn', disabled: busy === a.id + ':close',
                onClick: function () { props.act(a, 'close', {}, '已关闭浏览器'); },
              }, '关闭浏览器')
              : h('button', {
                className: 'sa-btn', disabled: busy === a.id + ':open',
                onClick: function () {
                  props.act(a, 'open', { mode: 'work' }, function (r) {
                    var extra = autofillNote(r);
                    if (r && r.backend === 'egolite') return '已打开 ' + a.name + '（ego 空间 ' + r.space + ' · profile ' + r.profileId + '）' + extra;
                    return (r && r.reused ? '已在这个店铺已打开的浏览器里打开工作台' : '已打开 ' + a.name + '（端口 ' + r.port + '）') + extra;
                  });
                },
              }, isBuyer ? '打开用户端' : '打开工作台'),
            h('button', {
              className: 'sa-btn', disabled: busy === a.id + ':reset',
              title: '清空这个店铺的本地登录档案并重新打开登录页',
              onClick: function () {
                if (!window.confirm('清空「' + a.name + '」的本地登录档案并重新扫码？\n\n档案目录会被删掉重建，只影响这个店铺的登录态。')) return;
                props.act(a, 'reset', {}, '已清空档案并打开登录页，请在新窗口里重新扫码');
              },
            }, busy === a.id + ':reset' ? '重扫中…' : '重扫（清档案）'),
            h('button', { className: 'sa-btn', title: a.profileDir || '', onClick: copyPath }, '复制档案路径'),
            h('button', { className: 'sa-btn', onClick: function () { props.onEdit(a); } }, isBuyer ? '编辑用户' : '编辑店铺'))),

        h('div', { className: 'sa-dsec' },
          h('div', { className: 'sa-dcard' },
            row(isBuyer ? '用户账户' : '账号', input(loginName, setLoginName,
              loginTag ? ('例如：' + loginTag) : '登录账号名，例如 主账号;子账号')),
            row('账号类型', h('div', { className: 'sa-dvalue', style: { width: '100%' } },
              h('select', {
                className: 'sa-input sa-select', value: type,
                onChange: function (e) { setAccountType(e.target.value); },
              },
                types.map(function (t) {
                  return h('option', { key: t, value: t }, accountTypeOptionLabel(props.platforms, a.platform, t));
                }))))),
          h('div', { className: 'sa-dsave' },
            dirty && h('div', { className: 'sa-hint' }, '有未保存的改动'),
            h('button', { className: 'sa-btn sa-btn-primary', disabled: saving || !dirty, onClick: save },
              saving ? '保存中…' : '保存修改'))),

        // ── v0.15.2：账号/密码错了要一眼看到（否则就是"停住没反应"）──────────
        a.autoLoginBlocked
          ? h('div', { className: 'sa-dsec' },
            h('div', { className: 'sa-dcard', style: { borderColor: '#d98b2b', background: 'rgba(217,139,43,.08)' } },
              h('div', { className: 'sa-dsec-title', style: { color: '#b8741f' } }, '⚠️ 账号或密码不正确'),
              h('div', { className: 'sa-hint', style: { margin: 0 } },
                '上次代填时站点提示账号或密码不正确（' + fmtTime(a.credentialErrorAt) + '），已暂停自动代填。')))
          : null,

        // ── v0.9.0：密码与自动登录 ─────────────────────────────────────────
        // v0.16.6：这个身份没有账号密码登录（拼多多 C 端只有验证码/扫码）→ 这张卡改成「登录方式」说明，
        // 不再显示"未保存密码"和一个用不上的密码框，免得用户以为东西坏了。
        // v0.17.0：能密码登录的店铺还可以在「账号密码代填 / 扫码或手动登录」之间切换 ——
        // 不记得账号密码的人不必存密码，打开窗口扫码登录一次即可（登录态照样留在本机档案里）。
        h('div', { className: 'sa-dsec' },
          h('div', { className: 'sa-dcard' },
            h('div', { className: 'sa-dsec-title' }, pwLogin ? '密码与账密登录' : '登录方式'),
            pwLogin
              ? h('div', { className: 'sa-tabs', role: 'group', style: { marginBottom: '8px' } },
                LOGIN_MODE_OPTIONS.map(function (m) {
                  return h('button', {
                    key: m[0], type: 'button', className: 'sa-tab',
                    'data-on': mode === m[0] ? '1' : '0',
                    onClick: function () { setLoginMode(m[0]); },
                  }, m[1]);
                }))
              : null,
            !pwLogin
              ? h('div', { className: 'sa-hint', style: { margin: 0 } },
                platformLabel(a.platform) + ' 的' + (isBuyer ? '用户账号' : '卖家账号')
                + '只能用「' + (loginMethodText((capsOf(props.platforms, a.platform, type) || {}).loginMethods) || '人工')
                + '」登录，没有账号密码可保存；点上面的「打开」在窗口里登录一次，登录态会保存在本机档案里。')
              : null,
            pwLogin && !usePassword
              ? h(React.Fragment, null,
                h('div', { className: 'sa-hint', style: { margin: 0 } },
                  '不存密码：点下面的按钮打开窗口，扫码或用账号密码登录一次，登录态就保存在本机档案里；之后打开店铺直接是登录好的。'),
                h('div', { className: 'sa-rowbtns', style: { marginTop: '8px' } },
                  h('button', {
                    className: 'sa-btn sa-btn-primary',
                    disabled: busy === a.id + ':open',
                    onClick: function () { props.act(a, 'open', { autofill: false }, '已打开窗口，请扫码或登录一次'); },
                  }, busy === a.id + ':open' ? '打开中…' : isBuyer ? '打开用户端（扫码登录）' : '打开店铺（扫码登录）')),
                a.hasPassword
                  ? h('div', { className: 'sa-hint', style: { marginTop: '6px' } },
                    '本机还留着之前保存的密码，切回「账号密码代填」就能继续用。')
                  : null)
              : null,
            pwLogin && usePassword
              ? h(React.Fragment, null,
                h('div', { className: 'sa-hint' },
                  vaultOk
                    ? ('只保存在本机（' + ((props.osPlatform && props.osPlatform.secretBackend === 'keychain') ? 'macOS 钥匙串' : '系统密钥') + '），不上传。')
                    : '本机密码库不可用，密码功能已禁用。'),
                h('div', { className: 'sa-dvalue', style: { width: '100%' } },
                  h('span', { className: 'sa-pill', 'data-tone': a.hasPassword ? 'ok' : 'none' },
                    a.hasPassword ? '已保存密码' : '未保存密码'),
                  a.hasPassword && a.passwordUpdatedAt
                    ? h('span', { className: 'sa-hint', style: { marginLeft: '8px' } }, '更新于 ' + fmtTime(a.passwordUpdatedAt))
                    : null),
                vaultOk && !a.loginName
                  ? h('div', { className: 'sa-hint', style: { color: '#b45309' } }, '先在上面填「账号」，账密登录需要账号名才能代填。')
                  : null,
                vaultOk && h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
                  h('input', {
                    className: 'sa-input', type: showPw2 ? 'text' : 'password', value: pw,
                    placeholder: a.hasPassword ? '设置新密码（留空则不改）' : '设置账号密码',
                    autoComplete: 'new-password',
                    onChange: function (e) { setPw(e.target.value); },
                  }),
                  h('button', {
                    className: 'sa-eye', type: 'button',
                    'data-on': showPw2 ? '1' : '0',
                    title: showPw2 ? '隐藏密码' : '显示密码',
                    'aria-label': showPw2 ? '隐藏密码' : '显示密码',
                    onClick: function () { setShowPw2(!showPw2); },
                  }, eyeIcon(showPw2)),
                  h('button', { className: 'sa-btn sa-btn-primary', disabled: pwBusy || !pw, onClick: savePw },
                    pwBusy ? '保存中…' : '保存密码'),
                  a.hasPassword && h('button', { className: 'sa-btn', disabled: pwBusy, onClick: clearPw }, '删除密码')),
                h('div', { className: 'sa-rowbtns', style: { marginTop: '8px' } },
                  h('button', {
                    className: 'sa-btn', disabled: autoBusy || !a.hasPassword || !a.loginName,
                    title: a.hasPassword ? '掉线后用本机保存的密码在当前窗口里重新账密登录（打开店铺时已经会自动做一次）' : '还没有保存密码',
                    onClick: doAutoLogin,
                  }, autoBusy ? '登录中…' : '重新登录（代填）')))
              : null)),

        // ── v0.9.0：数据采集（配置+调度，采集交给 agent/skill） ─────────────
        // v0.18.11：买家（C 端）账号没有商家后台的报表页面，采不到数据 —— 这一整块不给买家账号显示。
        isBuyer ? null : h('div', { className: 'sa-dsec' },
          h('div', { className: 'sa-dcard' },
            h('div', { className: 'sa-dsec-title' }, '数据采集'),
            // v0.16.0：**只有一个开关、一个时间** —— 开关就是排期表里的那个，时间来自全局排期槽位。
            // 以前这里还有一个「开启采集」勾选和「每天 09:00」输入框，和排期打架，已经删掉。
            h('div', {
              className: 'sa-hint',
              style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 8px' },
            },
              h('span', { className: 'sa-pill', 'data-tone': (a.schedEnabled !== false) ? 'ok' : 'none' },
                (a.schedEnabled !== false) ? '定时采集：已加入' : '定时采集：已暂停'),
              h('span', null, (a.schedEnabled !== false) ? ('每天 ' + (a.schedTime || '—')) : '—'),
              h('button', {
                className: 'sa-btn',
                disabled: schedBusy,
                onClick: toggleSched,
                title: '和「定时任务」表里的开启/暂停是同一个开关',
              }, schedBusy ? '切换中…' : ((a.schedEnabled !== false) ? '暂停定时采集' : '加入定时采集'))),
            (props.catalog && props.catalog.ready && props.catalog.platforms && props.catalog.platforms[a.platform])
              ? h('div', { className: 'sa-hint', style: { marginTop: '6px' } },
                '本地指标目录：' + props.catalog.platforms[a.platform].metricCount + ' 项 / '
                + props.catalog.platforms[a.platform].domains.length + ' 域')
              : null,
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0' } },
              // v0.12.0 目录层：域清单与指标数由 /state 按平台下发（淘宝/天猫多「竞争洞察」）
              ((a.collectionDomains && a.collectionDomains.length)
                ? a.collectionDomains
                : [['经营总览', '成交与客户'], ['流量转化', '访客与转化'], ['运营推广', '广告与营销'], ['商品供给', '商品与动销'], ['服务履约', '售后与服务']]
                  .map(function (d) { return { id: d[0], label: (props.collectionLabels && props.collectionLabels[d[0]]) || d[1], metricCount: 0 }; }))
                .map(function (d) {
                  var on = collDomains.indexOf(d.id) >= 0;
                  var hint = d.label + (d.metricCount ? ' · ' + d.metricCount + ' 项指标' : '');
                  return h('button', {
                    key: d.id,
                    className: 'sa-btn',
                    'data-on': on ? '1' : '0',
                    title: hint,
                    onClick: function () { toggleDomain(d.id); },
                  }, (on ? '✓ ' : '') + d.id + '（' + hint + '）');
                })),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } },
              h('button', { className: 'sa-btn sa-btn-primary', disabled: collBusy, onClick: saveColl },
                collBusy ? '保存中…' : '保存采集域'),
              h('button', { className: 'sa-btn', onClick: copyCollectPrompt }, '复制采集任务提示词')),
            a.collection && a.collection.lastRunAt
              ? h('div', { className: 'sa-hint', style: { marginTop: '6px' } },
                '上次采集：' + fmtTime(a.collection.lastRunAt)
                + '（' + ({ ok: '成功', partial: '部分成功', failed: '失败' }[a.collection.lastRunStatus] || a.collection.lastRunStatus || '?') + '）'
                + (a.collection.lastRunNote ? ' · ' + a.collection.lastRunNote : ''))
              : null,
            // v0.11.0：本地数据层的覆盖台账 —— 一眼看出"最近 30 天哪些域采全了、还缺几天"，
            // 不用再去问 agent"今天该采什么"。
            (function () {
              var cov = a.collectionCoverage;
              if (!cov || !cov.domains || !cov.domains.length) return null;
              return h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '3px' } },
                h('div', { style: { fontSize: '11px', fontWeight: 600, opacity: '.75' } },
                  '本地数据（窗口 ' + cov.window.start + ' ~ ' + cov.window.end + '，共 ' + cov.records + ' 条记录）'),
                cov.domains.map(function (d) {
                  var full = d.missingDays === 0;
                  return h('div', {
                    key: d.domain,
                    className: 'sa-hint',
                    style: { fontSize: '11px', color: full ? '#3fb950' : '#e0a84e' },
                  },
                    (full ? '✓ ' : '· ') + d.domain + '（' + d.label + '）：'
                    + (full ? '已采全 ' + d.coveredDays + ' 天' : '已覆盖 ' + d.coveredDays + '/' + cov.window.days + ' 天，缺 ' + d.missingDays + ' 天'));
                }));
            })())),

        h('div', { className: 'sa-dfoot' },
          h('button', { className: 'sa-link-danger', disabled: removing, onClick: remove },
            removing ? '删除中…' : '删除账号'),
          h('div', { className: 'sa-rowbtns', style: { justifyContent: 'flex-end' } },
            a.pendingLogin && h('button', {
              className: 'sa-btn', disabled: busy === a.id + ':close',
              onClick: function () { props.act(a, 'close', {}, '已关闭浏览器（未保存登录态）'); },
            }, '取消登录'),
            a.pendingLogin
              ? h('button', {
                className: 'sa-btn sa-btn-primary', disabled: busy === a.id + ':finish',
                onClick: function () {
                  props.act(a, 'finish', {}, function (r) {
                    return r.saved ? (r.keptSpace ? '已保存（ego 空间未关，可点「关闭」收掉）' : '登录状态已保存') : ('还没检测到登录态：' + ((r.check && r.check.reason) || '窗口保持打开，请完成后重试'));
                  });
                },
              }, busy === a.id + ':finish' ? '校验中…' : '完成并保存')
              : h('button', {
                className: 'sa-btn sa-btn-primary',
                disabled: busy === a.id + ':open',
                title: '在属于这个店铺的 Chrome 里打开平台登录页；窗口已经开着就会在里面新开一个标签页',
                onClick: function () {
                  props.act(a, 'open', { mode: 'login' }, function (r) {
                    var extra = autofillNote(r);
                    if (r && r.autofill && r.autofill.loggedIn) return '已用保存的账号密码登录成功，确认后可点「完成并保存」';
                    return (r && r.reused
                      ? '登录页已在这个店铺已打开的 Chrome 里新开标签页，登录完点「完成并保存」'
                      : '已打开登录页，请在弹出的窗口里完成登录，完成后点「完成并保存」') + extra;
                  });
                },
              }, a.lastCheck && a.lastCheck.loggedIn ? '重新登录' : '去登录'))));
    }

    /** 主页面。 */
    /**
     * 「调整排期」弹窗 —— 只改执行时间（每天几点起、组间隔、每组几个、顺序），
     * 不保存也不覆盖店铺开关，更不改「检测」本身做什么：到点跑的就是同一个静默检测。
     * 预览一律问宿主（POST /schedule/preview）：时间点、默认每组数（看内存）、排序都是宿主算的，
     * 界面不重复实现一份规则，免得两边算出两套时间。
     */
    function ScheduleDialog(props) {
      var sched = props.schedule || {};
      var [startTime, setStartTime] = React.useState(sched.startTime || '10:00');
      var [interval, setInterval] = React.useState(String(sched.groupIntervalMin || 30));
      var [size, setSize] = React.useState(sched.groupSizeMode === 'auto' ? '' : (sched.groupSize ? String(sched.groupSize) : ''));
      var [keepalive, setKeepalive] = React.useState(String(sched.keepaliveSec != null ? sched.keepaliveSec : 8));
      var [mode, setMode] = React.useState((sched && sched.mode) === 'check' ? 'check' : 'collect');
      var [enabled, setEnabled] = React.useState(Boolean(sched.enabled));
      var [order, setOrder] = React.useState((sched.rows || []).map(function (r) { return r.id; }));
      var [plan, setPlan] = React.useState(null);
      var [autoSize, setAutoSize] = React.useState(1);
      var [memGB, setMemGB] = React.useState(0);
      var [busy, setBusy] = React.useState(false);
      var [err, setErr] = React.useState('');
      var [dragIdx, setDragIdx] = React.useState(-1);
      var [overIdx, setOverIdx] = React.useState(-1);
      var seq = React.useRef(0);

      function preview(patch) {
        var p = patch || {};
        var body = {
          startTime: p.startTime != null ? p.startTime : startTime,
          groupIntervalMin: parseInt(p.interval != null ? p.interval : interval, 10) || 30,
          groupSize: parseInt(p.size != null ? p.size : size, 10) || 0,
          keepaliveSec: parseInt(p.keepalive != null ? p.keepalive : keepalive, 10) || 0,
          mode: p.mode != null ? p.mode : mode,
          order: p.order || order,
        };
        seq.current += 1;
        var my = seq.current; // 只认最后一次返回，避免连点输入时旧响应盖住新预览
        api('/schedule/preview', { method: 'POST', body: body })
          .then(function (r) {
            if (my !== seq.current) return;
            setPlan((r && r.plan) || null);
            setAutoSize((r && r.autoGroupSize) || 1);
            setMemGB((r && r.memGB) || 0);
          })
          .catch(function (e) { if (my === seq.current) setErr(e.message || String(e)); });
      }

      React.useEffect(function () { preview(); }, []);

      /** 把第 from 个挪到第 to 个位置（拖拽和 ↑↓ 都走这里，保证只有一套顺序逻辑）。 */
      function reorder(from, to) {
        var rows = (plan && plan.rows) || [];
        if (!(from >= 0) || !(to >= 0) || from === to || from >= rows.length || to >= rows.length) return;
        var ids = rows.map(function (r) { return r.id; });
        var moved = ids.splice(from, 1)[0];
        ids.splice(to, 0, moved);
        setOrder(ids);
        preview({ order: ids });
      }

      function save() {
        setBusy(true);
        setErr('');
        api('/schedule', {
          method: 'PUT',
          body: {
            enabled: enabled,
            startTime: startTime,
            groupIntervalMin: parseInt(interval, 10) || 30,
            groupSize: parseInt(size, 10) || 0,
            keepaliveSec: parseInt(keepalive, 10) || 0,
          mode: mode,
            order: order,
          },
        })
          .then(function (r) { setBusy(false); if (props.onSaved) props.onSaved(r && r.schedule); })
          .catch(function (e) {
            setBusy(false);
            setErr(e.message || String(e));
            if (props.onError) props.onError(e.message || String(e));
          });
      }

      var rows = (plan && plan.rows) || [];
      return h('div', { className: 'sa-overlay', onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); } },
        h('div', { className: 'sa-dialog' },
          h('h3', { className: 'sa-dialog-title' }, '调整排期'),
          h('div', { className: 'sa-dialog-body' },
          h(Field, { label: '每日起始时间' },
            h('input', {
              className: 'sa-input', type: 'time', value: startTime,
              onChange: function (e) { setStartTime(e.target.value); preview({ startTime: e.target.value }); },
            })),
          h(Field, { label: '组间隔（分钟）' },
            h(NumberField, {
              value: interval, min: 1, max: 1440,
              onChange: function (v) { setInterval(v); preview({ interval: v }); },
            })),
          h(Field, { label: '每组店铺数' },
            h(NumberField, {
              value: size, min: 1, max: 50, allowEmpty: true, emptyMeans: autoSize,
              placeholder: '留空 = 自动（' + autoSize + '）',
              onChange: function (v) { setSize(v); preview({ size: v }); },
            })),
          h(Field, { label: '保活停留（秒）' },
            h(NumberField, {
              value: keepalive, min: 0, max: 120,
              placeholder: '0 = 只检测不留',
              onChange: function (v) { setKeepalive(v); },
            })),
          h(Field, { label: '到点做什么' },
            h('select', {
              className: 'sa-input sa-select',
              value: mode,
              onChange: function (e) { setMode(e.target.value); },
            },
            h('option', { value: 'collect' }, '定时采集（配了采集的店铺跑采集，没配的退回检测）'),
            h('option', { value: 'check' }, '只检测登录态（不采集）'))),
          h('label', { className: 'sa-hint', style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '8px 0 10px' } },
            h('input', {
              type: 'checkbox', checked: enabled,
              onChange: function (e) { setEnabled(e.target.checked); },
            }),
            '开启定时采集（关掉后时间点保留，但到点不跑）'),

          h('div', { className: 'sa-hint', style: { marginBottom: '6px' } },
            '排期预览 · ' + rows.length + ' 个店铺 —— 按住 ⠿ 拖动排序'),
          h('div', { className: 'sa-plist sa-scroll' },
            rows.length === 0 && h('div', { className: 'sa-hint', style: { padding: '10px 12px' } },
              '还没有店铺 —— 先在列表里新增店铺'),
            rows.map(function (r, i) {
              return h('div', {
                key: r.id,
                className: 'sa-pitem',
                'data-off': r.active ? '0' : '1',
                'data-drag': dragIdx === i ? '1' : (overIdx === i ? '2' : '0'),
                draggable: true,
                onDragStart: function (e) {
                  setDragIdx(i);
                  try {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(i));
                    // 干掉浏览器自带的半透明拖影：拖动时那行会变成灰白的透明块，看着像丢了。
                    // 改成「原行实底高亮」（.sa-pitem[data-drag="1"]）+ 目标行描边，全程不透明。
                    var blank = document.createElement('canvas');
                    blank.width = 1;
                    blank.height = 1;
                    e.dataTransfer.setDragImage(blank, 0, 0);
                  } catch (err) { /* 无 dataTransfer 时靠 dragIdx 兜底 */ }
                },
                onDragOver: function (e) {
                  e.preventDefault();
                  if (overIdx !== i) setOverIdx(i);
                  try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
                },
                onDragLeave: function () { if (overIdx === i) setOverIdx(-1); },
                onDrop: function (e) {
                  e.preventDefault();
                  var from = dragIdx;
                  if (from < 0) {
                    try { from = Number(e.dataTransfer.getData('text/plain')); } catch (err) { from = -1; }
                  }
                  setDragIdx(-1);
                  setOverIdx(-1);
                  reorder(from, i);
                },
                onDragEnd: function () { setDragIdx(-1); setOverIdx(-1); },
              },
                h('div', { className: 'sa-handle', title: '按住拖动这行来调整顺序' }, '⠿'),
                h('div', { className: 'sa-mono' }, r.time),
                h('div', null, h('span', { className: 'sa-tag' }, platformLabel(r.platform))),
                h('div', null, r.name + (r.enabled ? '' : '（已暂停）')),
                h('div', { className: 'sa-hint' }, r.group != null ? '第 ' + (r.group + 1) + ' 组' : ''));
            }))),
          err && h('div', { className: 'sa-hint', style: { color: '#e5675f', marginTop: '8px' } }, err),
          h('div', { className: 'sa-dialog-foot', style: { marginTop: '14px' } },
            h('button', { className: 'sa-btn', onClick: props.onClose, disabled: busy }, '取消'),
            h('button', { className: 'sa-btn sa-btn-primary', onClick: save, disabled: busy },
              busy ? '保存中…' : '保存排期'))));
    }

    /** 浏览器设置面板。注意：必须定义在这一层（不能写在 ShopAccountsSection 函数体里），
     *  否则父级每次重渲染都会换掉组件身份 → 整块卸载重建 → 输入被回填、展开状态被收起（v0.8.1 修）。 */
    function ConfigPanel(props) {
      var cfg = props.cfg || {};
      var browser = props.browser || {};
      var state = { data: props.data || {} };
      var toast = typeof props.toast === 'function' ? props.toast : function () {};
      var load = typeof props.load === 'function' ? props.load : function () {};
      var [form, setForm] = React.useState(null);
      var [updBusy, setUpdBusy] = React.useState('');
      var [updInfo, setUpdInfo] = React.useState(null);
      // 只按「服务器上的配置值」重填表单：登录轮询会不断刷新 state.data.now，
      // 用 now 当依赖会把用户正在输入的内容每 2.5 秒抹掉一次。
      var cfgKey = JSON.stringify(cfg);
      React.useEffect(function () {
        setForm({
          browser: cfg.browser || 'auto',
          egoliteCli: cfg.egoliteCli || '',
          egoliteApp: cfg.egoliteApp || '',
          browserPath: cfg.browserPath || '',
          profileRoot: cfg.profileRoot || '',
          portBase: String(cfg.portBase || 9222),
          openWorkTab: cfg.openWorkTab === true,
          gracefulClose: cfg.gracefulClose !== false,
          updateDir: cfg.updateDir || '',
        });
      }, [cfgKey]);
      if (!form) return null;
      function save() {
        api('/config', {
          method: 'PUT',
          body: {
            browser: form.browser,
            egoliteCli: form.egoliteCli,
            egoliteApp: form.egoliteApp,
            browserPath: form.browserPath,
            profileRoot: form.profileRoot,
            portBase: parseInt(form.portBase, 10) || 9222,
            openWorkTab: form.openWorkTab,
            gracefulClose: form.gracefulClose,
            updateDir: form.updateDir,
          },
        }).then(function () { toast('ok', '设置已保存'); return load(true); })
          .catch(function (err) { toast('err', err.message || String(err)); });
      }
      function checkUpd() {
        setUpdBusy('check');
        api('/update')
          .then(function (r) { setUpdBusy(''); setUpdInfo(r); })
          .catch(function (err) { setUpdBusy(''); setUpdInfo({ ok: false, error: err.message || String(err) }); });
      }
      function runUpd() {
        // 只有「刚检测出来确实有新版本」才允许更新：没检测过、检测失败、已是最新，按钮都是灰的。
        var info = updInfo;
        if (!(info && info.ok !== false && info.needsUpdate)) return;
        setUpdBusy('apply');
        api('/update', { method: 'POST', body: {} })
          .then(function (r) {
            setUpdBusy('');
            setUpdInfo(r);
            toast('ok', r.updated ? ('已更新到 v' + (r.localVersion || '') + '，重启 DSH Desktop 生效') : '已经是最新版本');
            return load(true);
          })
          .catch(function (err) { setUpdBusy(''); setUpdInfo({ ok: false, error: err.message || String(err) }); });
      }
      // ── 店铺配置迁移（v0.10.1）──
      // 「导出」把一个 JSON 文件塞给浏览器下载；「导入」读同一个文件，跳过重复/坏掉的条目。
      // 密码与登录态都不在文件里，导入后要去详情页重新设密码 —— 提示里说清楚，免得以为丢了。
      var fileRef = React.useRef(null);
      var [migBusy, setMigBusy] = React.useState('');
      function doExport() {
        if (migBusy) return;
        setMigBusy('export');
        api('/export').then(function (data) {
          setMigBusy('');
          var text = JSON.stringify(data, null, 2);
          var blob = new Blob([text], { type: 'application/json' });
          var href = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = href;
          a.download = 'shop-accounts-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // 立刻 revoke 会让部分浏览器下载失败，晚一点再释放。
          setTimeout(function () { URL.revokeObjectURL(href); }, 2000);
          toast('ok', '已导出 ' + (data.count || 0) + ' 个店铺的配置（不含密码与登录态）');
        }).catch(function (err) { setMigBusy(''); toast('err', err.message || String(err)); });
      }
      function doImport(file) {
        if (!file || migBusy) return;
        setMigBusy('import');
        file.text().then(function (text) {
          var payload;
          try { payload = JSON.parse(text); } catch (e) { throw new Error('文件不是合法的 JSON'); }
          return api('/import', { method: 'POST', body: payload });
        }).then(function (r) {
          setMigBusy('');
          var skipped = (r && r.skipped) || [];
          var msg = '导入完成：新增 ' + ((r && r.imported) || 0) + ' 个店铺配置';
          if (skipped.length) msg += '，跳过 ' + skipped.length + ' 个（' + skipped[0].reason + (skipped.length > 1 ? ' 等' : '') + '）';
          msg += '。密码要重新设置 —— 导出文件里不含密码。';
          toast(skipped.length ? 'err' : 'ok', msg);
          return load(true);
        }).catch(function (err) { setMigBusy(''); toast('err', err.message || String(err)); });
      }
      var version = (state.data && state.data.version) || '';
      var loadedVersion = (state.data && state.data.loadedVersion) || version;
      var staleCode = Boolean(version && loadedVersion && version !== loadedVersion);
      var detectedDir = (state.data && state.data.updateDir) || '';
      var updText = '';
      if (updBusy === 'check') updText = '正在向 GitHub 查询…';
      else if (updBusy === 'apply') updText = '正在更新…';
      else if (updInfo && updInfo.ok === false) updText = '出错了：' + (updInfo.error || '未知原因');
      else if (updInfo && updInfo.updated) updText = '已更新到 v' + (updInfo.localVersion || '?') + '（重启 DSH Desktop 生效）';
      else if (updInfo && updInfo.upToDate) updText = '已是最新：v' + (updInfo.localVersion || '?') + (updInfo.localHead ? '（' + updInfo.localHead + '）' : '');
      else if (updInfo) {
        var bits = [];
        if (updInfo.remoteVersion && updInfo.remoteVersion !== updInfo.localVersion) bits.push('GitHub v' + updInfo.remoteVersion);
        if (updInfo.sourceVersion && updInfo.sourceVersion !== updInfo.localVersion && updInfo.sourceVersion !== updInfo.remoteVersion) bits.push('本地源码 v' + updInfo.sourceVersion);
        if (updInfo.behind > 0) bits.push('落后 GitHub ' + updInfo.behind + ' 个提交');
        updText = '有新版本：' + bits.join(' · ') + ' → 点「更新到最新」';
      }
      // 更新按钮只在「检测出有新版本」时亮：没检测 / 检测失败 / 已是最新都灰着，
      // 免得用户在不知道有没有新东西的时候瞎按。
      var canApply = Boolean(updInfo && updInfo.ok !== false && updInfo.needsUpdate);
      // ego lite 的状态（后端、CLI 路径、可用 profile）—— 这一块决定了「打开店铺」开的是哪个浏览器
      var ego = (state.data && state.data.ego) || {};
      var backend = (state.data && state.data.backend) || 'chrome';
      var egoProfiles = ego.profiles || [];
      // 界面只在「真的用 ego」时才出现 ego 的东西：Chrome 模式下不该到处是 ego 字样。
      var egoOn = backend === 'egolite';
      var egoAvail = Boolean(ego.available);
      // 胶囊只放结论（ego lite / Chrome），原因放 title；profile 数只在 ego 模式才提。
      var chipText = egoOn
        ? ('ego lite' + (egoProfiles.length ? ' · ' + egoProfiles.length + ' 个 profile' : ''))
        : 'Chrome';
      var profileText = egoProfiles.length
        ? egoProfiles.map(function (p) { return p.name + '（' + p.id + (p.isDefault ? '，默认' : '') + '）'; }).join('、')
        : '还没读到 —— 打开一次 ego 再点「刷新 ego」';
      // ego 主程序这会儿没开着：状态读不到，profile 列表也是空的，得给一句人话 + 一个按钮。
      // 注意不能靠「用 CLI 读一次状态」来启动它 —— 那会把整个浏览器连同上次所有标签一起恢复出来。
      var egoDown = egoOn && egoAvail && ego.running === false;
      // 折叠块内部排版走**内联样式**：万一某个页面里样式表版本没跟上（热重载/缓存），
      // 间距也不会塌成 0 —— 之前就是全靠 class 上的 gap，一失效整片输入框就挤在一起。
      // 注意这里**不再给底色/圆角/边框**：它就在卡片里，再套一层就是「框中框」。
      var advStyle = {
        display: 'flex', flexDirection: 'column', gap: '16px',
        marginTop: '4px', paddingTop: '12px',
        borderTop: '1px solid rgba(127,127,127,.14)',
      };
      var monoStyle = {
        fontFamily: "ui-monospace,SFMono-Regular,'Cascadia Mono',Consolas,monospace",
        fontSize: '11.5px',
      };
      var groupStyle = { display: 'flex', flexDirection: 'column', gap: '12px' };
      // 组与组之间加一条发丝线：三段（路径 / Chrome / 信息）读起来才分层，
      // 而不是一长串同样间距的字段。
      var groupDividerStyle = Object.assign({}, groupStyle, {
        borderTop: '1px solid rgba(127,127,127,.12)', paddingTop: '14px',
      });
      // 小标题不做 uppercase：中文没有大小写，加 letterSpacing 只是为了分组感。
      var groupLabelStyle = {
        display: 'flex', alignItems: 'center', gap: '10px',
        fontSize: '11px', letterSpacing: '.06em', fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary,#5b6270)', opacity: '.85',
      };
      var subStyle = {
        fontSize: '11px', lineHeight: '1.55', marginTop: '3px',
        color: 'var(--dsw-alias-label-secondary,#5b6270)',
      };
      // 「信息」组里的值是只读文本：跟输入框对齐（也顶到 6px，跟左边的标签同一基线）。
      var infoStyle = {
        fontSize: '11.5px', lineHeight: '1.55', paddingTop: '5px',
        color: 'var(--dsw-alias-label-secondary,#5b6270)', overflowWrap: 'anywhere',
      };
      var checkStyle = {
        display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer',
        fontSize: '12px', lineHeight: '1.4', color: 'var(--dsw-alias-label-secondary,#5b6270)',
        paddingTop: '5px', minWidth: 0,
      };
      return h('div', null,
        h('div', { className: 'sa-card' },
          h('div', { className: 'sa-cardhead' },
            h('div', { style: { fontWeight: 600 } }, '浏览器设置'),
            h('span', { className: 'sa-chip' }, chipText)),
          h(Field, { label: '浏览器后端' },
            h('select', {
              className: 'sa-input sa-select', value: form.browser, style: { maxWidth: '160px' },
              onChange: function (e) { setForm(Object.assign({}, form, { browser: e.target.value })); },
            },
              h('option', { value: 'auto' }, '自动'),
              h('option', { value: 'egolite', disabled: !egoAvail }, egoAvail ? 'ego lite' : 'ego lite（未安装）'),
              h('option', { value: 'chrome' }, 'Chrome'))),
          h('details', { className: 'sa-adv', style: advStyle },
            h('summary', { className: 'sa-advsum' }, '路径与高级选项'),

            h('div', { className: 'sa-group', style: groupStyle },
              h('div', { className: 'sa-grouplabel', style: groupLabelStyle }, '路径'),
              // ego 的 CLI 路径只在 ego 模式下给改；不然 Chrome 用户看到的全是没用的字段。
              egoOn && h(Field, { label: 'ego-browser' },
                h('input', {
                  className: 'sa-input', value: form.egoliteCli, style: monoStyle,
                  placeholder: '留空 = 自动探测',
                  onChange: function (e) { setForm(Object.assign({}, form, { egoliteCli: e.target.value })); },
                })),
              // 探测到的路径放 placeholder + 悬停提示就够：以前在下面另起一行「探测到：…」，
              // 把这一行撑成两倍高，跟上下 28px 的行完全不对齐，整块节奏就乱了。
              h(Field, { label: 'Chrome / Edge' },
                h('div', null,
                  h('input', {
                    className: 'sa-input', value: form.browserPath, style: monoStyle,
                    placeholder: '留空 = 自动探测',
                    onChange: function (e) { setForm(Object.assign({}, form, { browserPath: e.target.value })); },
                  }),
                  !browser.found && h('div', { style: subStyle }, '没探测到 Chrome / Edge，请填完整路径'))),
              h(Field, { label: '档案根目录' },
                h('input', {
                  className: 'sa-input', value: form.profileRoot, style: monoStyle,
                  placeholder: '留空 = <数据目录>\\profiles',
                  onChange: function (e) { setForm(Object.assign({}, form, { profileRoot: e.target.value })); },
                }))),

            h('div', { className: 'sa-group', style: groupDividerStyle },
              h('div', { className: 'sa-grouplabel', style: groupLabelStyle }, 'Chrome'),
              h(Field, { label: '起始端口' },
                h('input', {
                  className: 'sa-input', value: form.portBase, style: { maxWidth: '110px' },
                  placeholder: '9222 起顺延',
                  onChange: function (e) { setForm(Object.assign({}, form, { portBase: e.target.value.replace(/[^\d]/g, '') })); },
                })),
              // 两个勾选也走同一个「左标签右内容」网格：以前是整行 label 文字，
              // 跟上面的输入框左边缘对不齐，看着像另一套排版。
              h(Field, { label: '打开时' },
                h('label', { style: checkStyle },
                  h('input', {
                    type: 'checkbox', checked: form.openWorkTab,
                    onChange: function (e) { setForm(Object.assign({}, form, { openWorkTab: e.target.checked })); },
                  }),
                  '打开商品列表页')),
              h(Field, { label: '关闭时' },
                h('label', { style: checkStyle },
                  h('input', {
                    type: 'checkbox', checked: form.gracefulClose,
                    onChange: function (e) { setForm(Object.assign({}, form, { gracefulClose: e.target.checked })); },
                  }),
                  '正常退出浏览器'))),

            h('div', { className: 'sa-group', style: groupDividerStyle },
              h('div', { className: 'sa-grouplabel', style: groupLabelStyle }, '信息'),
              egoOn && h(Field, { label: 'ego profile' },
                h('div', { style: infoStyle, title: profileText }, profileText)),
              h(Field, { label: '数据目录' },
                h('div', { style: infoStyle }, String((state.data && state.data.dataDir) || '')))),

            // ── 店铺配置迁移（v0.10.1）──
            // 换机器时用：导出一个 JSON 带走店铺列表（平台/名字/登录账号/URL/采集设置），
            // 新机器导入后重设密码即可。密码与登录态不进包，所以这里直说，免得以为导出漏了东西。
            h('div', { className: 'sa-group', style: groupDividerStyle },
              h('div', { className: 'sa-grouplabel', style: groupLabelStyle }, '店铺配置迁移'),
              h('div', { className: 'sa-actions', style: { marginTop: '2px' } },
                h('button', {
                  className: 'sa-btn', disabled: Boolean(migBusy), onClick: doExport,
                }, migBusy === 'export' ? '导出中…' : '导出店铺配置'),
                h('button', {
                  className: 'sa-btn', disabled: Boolean(migBusy),
                  onClick: function () { if (fileRef.current) fileRef.current.click(); },
                }, migBusy === 'import' ? '导入中…' : '导入店铺配置'),
                h('input', {
                  ref: fileRef, type: 'file', accept: '.json,application/json', style: { display: 'none' },
                  onChange: function (e) {
                    var f = e.target.files && e.target.files[0];
                    // 清掉 value：同一个文件改了内容再选一次，也得能触发 onChange。
                    e.target.value = '';
                    doImport(f);
                  },
                })))),
          h('div', { className: 'sa-actions' },
            h('button', { className: 'sa-btn sa-btn-primary', onClick: save }, '保存设置'),
            // ego 没开着的时候给一个「启动 ego」：只拉起主程序，不碰任何 TaskSpace。
            egoDown && h('button', {
              className: 'sa-btn',
              onClick: function () {
                toast('ok', '正在启动 ego lite…');
                api('/ego/start', { method: 'POST' }).then(function (r) {
                  var ego2 = (r && r.ego) || {};
                  toast(r && r.ok ? 'ok' : 'err', r && r.ok
                    ? ('ego lite 已启动（' + (ego2.profiles || []).length + ' 个 profile）')
                    : ('启动失败：' + ((r && r.error) || '未知原因')));
                  return load(true);
                }).catch(function (err) { toast('err', err.message || String(err)); });
              },
            }, '启动 ego'),
            // 没在用 ego 时不放这个按钮：点了也只是「没检测到」。
            egoOn && h('button', {
              className: 'sa-btn',
              onClick: function () {
                api('/ego').then(function (r) {
                  var ego2 = (r && r.ego) || {};
                  toast(ego2.running === false ? 'err' : 'ok', ego2.available
                    ? (ego2.running === false
                      ? 'ego lite 没在运行'
                      : ('ego 可用（' + (ego2.profiles || []).length + ' 个 profile）'))
                    : '没装 ego lite');
                  return load(true);
                }).catch(function (err) { toast('err', err.message || String(err)); });
              },
            }, '刷新 ego'))),

        h('div', { className: 'sa-card' },
          h('div', { style: { fontWeight: 600 } }, '版本与更新'),
          h('div', { className: 'sa-hint' },
            '当前版本：v' + (version || '?') +
            (loadedVersion && loadedVersion !== version ? '（本次启动加载的是 v' + loadedVersion + '）' : '')),
          staleCode && h('div', { className: 'sa-hint', style: { color: '#e5675f' } },
            '磁盘上已经是 v' + version + '，但这次启动加载的还是 v' + loadedVersion +
            ' —— 关掉 DSH Desktop 再打开，新代码才会生效'),
          h(Field, { label: '更新源目录（本插件的 git 源码仓库）' },
            h('input', {
              className: 'sa-input', value: form.updateDir,
              placeholder: '留空 = 自动探测源码目录',
              onChange: function (e) { setForm(Object.assign({}, form, { updateDir: e.target.value })); },
            })),
          updText && h('div', { className: 'sa-hint', style: { color: (updInfo && updInfo.ok === false) ? '#e5675f' : null } }, updText),
          h('div', { className: 'sa-actions' },
            h('button', { className: 'sa-btn', disabled: Boolean(updBusy), onClick: checkUpd, title: '只查询 GitHub 有没有新提交，不改任何文件' },
              updBusy === 'check' ? '检测中…' : '检测更新'),
            h('button', {
              className: 'sa-btn sa-btn-primary',
              disabled: Boolean(updBusy) || !canApply,
              onClick: runUpd,
              title: canApply ? '快进合并源码，再覆盖到 profile 里这份拷贝' : '先点「检测更新」，确认有新版本后才能更新',
            }, updBusy === 'apply' ? '更新中…' : '更新到最新'))));
    }
    /** 渲染出错时给用户看的东西：把异常原文显示出来 + 提示已落盘（v0.17.9）。 */
    function sectionErrorCard(err) {
      var text = String((err && err.stack) || (err && err.message) || err || '');
      return h('div', { className: 'sa-root' },
        h('div', { className: 'sa-card', style: { borderColor: 'rgba(229,103,95,.6)' } },
          h('div', { className: 'sa-cardhead' }, h('div', { className: 'sa-dsec-title' }, '这一段渲染出错了')),
          h('div', { className: 'sa-note' }, '错误已写进插件数据目录的 client-errors.log；把这段文字发出来就能定位。'),
          h('div', { className: 'sa-hint', style: { margin: 0, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, text || '未知错误')));
    }

    function ShopAccountsSection() {
      try {
        return renderShopAccountsSection();
      } catch (err) {
        reportClientError('render.section', err, 'settings.section');
        return sectionErrorCard(err);
      }
    }

    function renderShopAccountsSection() {
      var [state, setState] = React.useState({ loading: true, data: null, error: null });
      var [tab, setTab] = React.useState('all');
      var [query, setQuery] = React.useState('');
      var [busyId, setBusyId] = React.useState('');
      var [dialog, setDialog] = React.useState(null); // {mode:'add'} | {mode:'edit', account}
      var [showConfig, setShowConfig] = React.useState(false);
      var [detailId, setDetailId] = React.useState('');
      var [schedOpen, setSchedOpen] = React.useState(false);
      var [toasts, setToasts] = React.useState([]);
      var seq = React.useRef(0);
      var loadSeq = React.useRef(0);

      function toast(kind, text) {
        seq.current += 1;
        var id = seq.current;
        setToasts(function (prev) { return prev.concat([{ id: id, kind: kind, text: text }]); });
        setTimeout(function () { setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id; }); }); }, kind === 'err' ? 8000 : 4000);
      }

      function load(silent) {
        // 并发守卫：登录轮询（2.5s）、排期轮询（20s）和手动动作会同时打 /state，
        // 慢的旧响应回来后把新状态覆盖掉，界面会"退回未登录"，用户可能据此去点不可恢复的"重扫"。
        loadSeq.current += 1;
        var my = loadSeq.current;
        return api('/state').then(function (data) {
          if (my !== loadSeq.current) return null; // 已经有更新的请求，丢弃这次
          setState({ loading: false, data: data, error: null });
          return data;
        }).catch(function (err) {
          if (my !== loadSeq.current) return null;
          if (!silent) setState(function (prev) { return { loading: false, data: prev.data, error: err.message || String(err) }; });
          return null;
        });
      }

      React.useEffect(function () { load(false); }, []);

      var accounts = (state.data && state.data.accounts) || [];
      var detail = null;
      for (var di = 0; di < accounts.length; di += 1) if (accounts[di].id === detailId) detail = accounts[di];
      var anyPending = accounts.some(function (a) { return a.pendingLogin; });

      // 只在「有人在等登录」时轮询：登录是在别处（Chrome 窗口）发生的，界面得自己发现。
      // 其余时候安静待着，动作后手动 load。
      React.useEffect(function () {
        if (!anyPending) return undefined;
        var timer = setInterval(function () { load(true); }, 2500);
        return function () { clearInterval(timer); };
      }, [anyPending]);

      var sched = (state.data && state.data.schedule) || null;
      // 定时检测开着时，界面自己刷新：宿主每 20 秒看一次排期，界面晚一点跟上就够了。
      var schedOn = Boolean(sched && sched.enabled);
      React.useEffect(function () {
        if (!schedOn) return undefined;
        var timer = setInterval(function () { load(true); }, 20000);
        return function () { clearInterval(timer); };
      }, [schedOn]);

      function toggleSched(account) {
        // 用「目标值」而不是 `!account.schedEnabled`：连点两次时 account 可能是旧的，
        // 两次都算成"关"（或都算成"开"），状态与显示相反。
        var next = !account.schedEnabled;
        setBusyId(account.id + ':schedule');
        return api('/accounts/' + encodeURIComponent(account.id) + '/schedule', { method: 'POST', body: { enabled: next } })
          .then(function () {
            setBusyId('');
            toast('ok', account.name + '：定时任务' + (next ? '已开启' : '已暂停（时间点还占着）'));
            return load(true);
          })
          .catch(function (err) { setBusyId(''); toast('err', err.message || String(err)); return null; });
      }

      function silentCheck(account) {
        setBusyId(account.id + ':silent-check');
        return api('/accounts/' + encodeURIComponent(account.id) + '/silent-check', { method: 'POST', body: {} })
          .then(function (r) {
            setBusyId('');
            var c = (r && r.check) || {};
            toast(c.loggedIn ? 'ok' : 'err', c.loggedIn
              ? (account.name + '：已登录（' + (c.reason || '') + '）')
              : (account.name + '：' + (c.reason || '未登录')));
            return load(true);
          })
          .catch(function (err) { setBusyId(''); toast('err', err.message || String(err)); return null; });
      }

      function act(account, action, body, okText) {
        setBusyId(account.id + ':' + action);
        return api('/accounts/' + encodeURIComponent(account.id) + '/' + action, { method: 'POST', body: body || {} })
          .then(function (r) {
            setBusyId('');
            return load(true).then(function () { return r; });
          })
          .then(function (r) {
            if (r && r.note) toast('ok', r.note);
            else if (okText) toast('ok', typeof okText === 'function' ? okText(r) : okText);
            return r;
          })
          .catch(function (err) {
            setBusyId('');
            toast('err', err.message || String(err));
            return null;
          });
      }

      var counts = { all: accounts.length };
      PLATFORMS.forEach(function (p) { counts[p.id] = accounts.filter(function (a) { return a.platform === p.id; }).length; });

      var q = query.trim().toLowerCase();
      var visible = accounts.filter(function (a) {
        if (tab !== 'all' && a.platform !== tab) return false;
        if (!q) return true;
        return ((a.name || '') + ' ' + (a.note || '') + ' ' + platformLabel(a.platform) + ' ' + (a.cdpUrl || '')).toLowerCase().indexOf(q) >= 0;
      });

      var pending = accounts.filter(function (a) { return a.pendingLogin; });
      var cfg = (state.data && state.data.config) || {};
      var browser = (state.data && state.data.browser) || {};


      return h('div', { className: 'sa-root' },
        h(Toast, { list: toasts }),

        !detail && h('div', { className: 'sa-head' },
          h('div', null,
            h('h2', { className: 'sa-title' }, '账号管理'),
            h('p', { className: 'sa-sub' }, ((state.data && state.data.backend) || 'chrome') === 'egolite' ? '一店一份独立登录档案（ego lite）' : '一店一份独立登录档案（Chrome）')),
          h('div', { className: 'sa-actions' },
            h('button', { className: 'sa-btn', onClick: function () { setShowConfig(!showConfig); } }, showConfig ? '收起设置' : '浏览器设置'),
            h('button', { className: 'sa-btn', onClick: function () { load(false); } }, '刷新'),
            h('button', { className: 'sa-btn sa-btn-primary', onClick: function () { setDialog({ mode: 'add' }); } }, '+ 新增店铺'))),

        state.error && h('div', { className: 'sa-card', style: { borderColor: 'rgba(229,103,95,.6)' } },
          h('div', null, '读取失败：' + state.error)),

        showConfig && !detail && h(ConfigPanel, { key: 'shop-accounts-config', cfg: cfg, browser: browser, data: state.data, toast: toast, load: load }),

        detail && h(AccountDetail, {
          account: detail,
          busyId: busyId,
          vault: (state.data && state.data.vault) || null,
          osPlatform: (state.data && state.data.osPlatform) || null,
          platforms: (state.data && state.data.platforms) || null,
          collectionLabels: (state.data && state.data.collectionLabels) || null,
          catalog: (state.data && state.data.catalog) || null,
          act: act,
          silentCheck: silentCheck,
          reload: function () { return load(true); },
          onBack: function () { setDetailId(''); },
          onEdit: function (account) { setDialog({ mode: 'edit', account: account }); },
          onInfo: function (msg) { toast('ok', msg); },
          onError: function (msg) { toast('err', msg); },
        }),

        !detail && h(React.Fragment, null,

        pending.length > 0 && h('div', { className: 'sa-pending' },
          h('div', { className: 'sa-pending-title' }, '有 ' + pending.length + ' 个店铺正在等待登录'),
          pending.map(function (a) {
            return h('div', { key: a.id, className: 'sa-pending-line' },
              h('div', null,
                h('span', { style: { fontWeight: 600 } }, a.name),
                h('span', { className: 'sa-hint', style: { marginLeft: '8px' } }, platformLabel(a.platform) + (a.port ? ' · 端口 ' + a.port : ''))),
              h('div', { className: 'sa-rowbtns' },
                h('button', {
                  className: 'sa-btn sa-btn-primary',
                  disabled: busyId === a.id + ':finish',
                  onClick: function () {
                    act(a, 'finish', {}, function (r) {
                      return r.saved ? (r.keptSpace ? '已保存（ego 空间未关，可点「关闭」收掉）' : '登录状态已保存') : ('还没检测到登录态：' + ((r.check && r.check.reason) || '窗口保持打开，请完成后重试'));
                    });
                  },
                }, busyId === a.id + ':finish' ? '校验中…' : '完成并保存'),
                h('button', {
                  className: 'sa-btn', disabled: busyId === a.id + ':close',
                  onClick: function () { act(a, 'close', {}, '已关闭浏览器（未保存登录态）'); },
                }, '取消')));
          })),

        sched && h('div', {
          className: 'sa-schedbar', 'data-on': schedOn ? '1' : '0',
          // 第三行「下次 …」不摆在横幅里（要跟参考图一样就两行），挪到悬停提示上。
          title: schedOn
            ? (sched.nextRunAt ? '下次' + ((sched && sched.mode) === 'check' ? '定时检测' : '定时采集') + '：' + fmtTime(sched.nextRunAt) + ((sched && sched.mode) === 'check' ? '（无头 Chrome 静默检测，不打开窗口）' : '（到点按店跑采集，只采没覆盖的）') : ((sched && sched.mode) === 'check' ? '定时检测已开启' : '定时采集已开启'))
            : ((sched && sched.mode) === 'check' ? '定时检测当前已关闭' : '定时采集当前已关闭') + ' —— 点「调整排期」可以打开',
        },
          h('div', { className: 'sa-schedmain' },
            h('div', { className: 'sa-schedtitle' },
              '每天 ' + (sched.startTime || '10:00') + ' 起 · 每组 ' + (sched.groupSize || 1) + ' 个店铺，组间隔 ' + (sched.groupIntervalMin || 30) + ' 分钟' +
              (schedOn ? '' : '（当前已关闭）')),
            h('div', { className: 'sa-schedsub' }, '适用于全部店铺，含已暂停任务；错过时间不补跑。')),
          h('button', { className: 'sa-schedpill', onClick: function () { setSchedOpen(true); } }, '调整排期')),

        h('div', { className: 'sa-tabs' },
          h('button', { className: 'sa-tab', 'data-on': tab === 'all' ? '1' : '0', onClick: function () { setTab('all'); } }, '全部 ' + counts.all),
          PLATFORMS.map(function (p) {
            return h('button', {
              key: p.id, className: 'sa-tab', 'data-on': tab === p.id ? '1' : '0',
              onClick: function () { setTab(p.id); },
            }, p.label + ' ' + (counts[p.id] || 0));
          })),

        h('input', {
          className: 'sa-search', value: query, placeholder: '搜索店铺名、备注、平台或端口',
          onChange: function (e) { setQuery(e.target.value); },
        }),

        h('div', { className: 'sa-list' },
          h('div', { className: 'sa-rowhead' },
            h('div', { className: 'sa-c-name' }, '店铺 / 用户名'), h('div', { className: 'sa-c-plat' }, '平台'),
            h('div', { className: 'sa-c-sched' }, (sched && sched.mode) === 'check' ? '定时检测' : '定时采集'), h('div', { className: 'sa-c-status' }, '登录状态'),
            h('div', { className: 'sa-c-port' }, '调试端口'), h('div', { className: 'sa-c-ops', style: { textAlign: 'center' } }, '操作')),

          visible.length === 0 && h('div', { className: 'sa-empty' },
            state.loading ? '读取中…' : (accounts.length ? '没有匹配的店铺' : '还没有店铺，点右上角「+ 新增店铺」')),

          visible.map(function (a) {
            var st = statusOf(a);
            return h('div', { key: a.id, className: 'sa-row' },
              h('div', { className: 'sa-c-name' },
                h('div', {
                  className: 'sa-name', title: (a.name || '') + '（点这里看这家店的详情 / 管理）',
                  style: { cursor: 'pointer' },
                  onClick: function () { setDetailId(a.id); },
                }, a.name),
                h('div', { className: 'sa-note', title: a.note || a.profileDir },
                  (a.note ? a.note + ' · ' : '') + (a.running ? '运行中' : '未运行') +
                  (a.lastLoginAt ? ' · 上次登录 ' + fmtTime(a.lastLoginAt) : ''),
                  a.port ? h('span', { className: 'sa-port-inline' }, ' · 端口 :' + a.port) : null)),

              h('div', { className: 'sa-c-plat' }, h('span', { className: 'sa-tag' }, platformLabel(a.platform))),

              h('div', { className: 'sa-c-sched' },
                h('div', { className: 'sa-schedcell' },
                  h('button', {
                    className: 'sa-schedbtn', 'data-on': a.schedEnabled ? '1' : '0',
                    disabled: busyId === a.id + ':schedule',
                    onClick: function () { toggleSched(a); },
                  }, (a.schedEnabled ? '开启' : '暂停') + '·' + (a.schedTime || '—')),
                  a.lastSchedError
                    ? h('button', { className: 'sa-link', title: a.lastSchedError, onClick: function () { setDetailId(a.id); } }, '上次失败')
                    : h('button', { className: 'sa-link', onClick: function () { setSchedOpen(true); } }, '详细配置'))),

              h('div', { className: 'sa-c-status' },
                h('div', { className: 'sa-status', title: st.title || null },
                  h('span', { className: 'sa-dot', style: { background: st.color } }),
                  h('span', { style: st.tone === 'err' ? { color: '#e5675f' } : null }, st.text)),
                h('div', {
                  className: 'sa-note',
                  title: [
                    (a.lastCheck && a.lastCheck.reason) || '',
                    (a.lastCheck && a.lastCheck.tokenExpiry) ? '凭证到期 ' + fmtTime(a.lastCheck.tokenExpiry).slice(0, 10) : '',
                    (a.lastCheck && a.lastCheck.keptAliveSec) ? '保活停留 ' + a.lastCheck.keptAliveSec + ' 秒' : '',
                  ].filter(Boolean).join('\n'),
                },
                  a.lastCheckAt ? '检测于 ' + fmtTime(a.lastCheckAt) : '未检测')),

              h('div', { className: 'sa-c-port' },
                h('div', { className: 'sa-mono' }, a.port ? ':' + a.port : '—'),
                h('div', { className: 'sa-note' }, a.port ? (a.running ? 'CDP 可用' : '未启动') : '未分配')),

              h('div', { className: 'sa-rowbtns sa-nowrap sa-c-ops', style: { justifyContent: 'center' } },
                // ① 检测：静默复核登录态，不打开窗口
                h('button', {
                  className: 'sa-btn', disabled: busyId === a.id + ':silent-check',
                  title: '静默复核这个店铺的登录态，不会打开窗口',
                  onClick: function () {
                    setBusyId(a.id + ':silent-check');
                    api('/accounts/' + encodeURIComponent(a.id) + '/silent-check', { method: 'POST', body: {} })
                      .then(function (r) {
                        setBusyId('');
                        var c = (r && r.check) || {};
                        toast(c.loggedIn ? 'ok' : 'err', c.loggedIn ? (a.name + '：已登录（' + (c.reason || '') + '）') : (a.name + '：' + (c.reason || '未登录')));
                        return load(true);
                      })
                      .catch(function (err) { setBusyId(''); toast('err', err.message || String(err)); });
                  },
                }, busyId === a.id + ':silent-check' ? '检测中…' : '检测'),

                // ② 随状态变的那一个：等待登录 → 完成并保存；已登录 → 管理（详情页）；未登录 / 已过期 → 去登录
                a.pendingLogin
                  ? h('button', {
                    className: 'sa-btn sa-btn-primary', disabled: busyId === a.id + ':finish',
                    title: '校验登录态并保存；ego 模式保留那个空间（不影响你用浏览器），Chrome 模式关掉窗口',
                    onClick: function () {
                      act(a, 'finish', {}, function (r) {
                        return r.saved ? (r.keptSpace ? '已保存（ego 空间未关，可点「关闭」收掉）' : '登录状态已保存') : ('还没检测到登录态：' + ((r.check && r.check.reason) || '窗口保持打开，请完成后重试'));
                      });
                    },
                  }, busyId === a.id + ':finish' ? '校验中…' : '完成并保存')
                  : (a.lastCheck && a.lastCheck.loggedIn)
                    ? h('button', {
                      className: 'sa-btn',
                      title: '打开详情页：账号 / 账号类型 / 重扫 / 编辑 / 删除',
                      onClick: function () { setDetailId(a.id); },
                    }, '管理')
                    : h('button', {
                      className: 'sa-btn sa-btn-primary', disabled: busyId === a.id + ':open',
                      title: '在属于这个店铺的 Chrome 里打开平台登录页；窗口已经开着就会在里面新开一个标签页',
                      onClick: function () {
                        act(a, 'open', { mode: 'login' }, function (r) {
                          return r && r.reused
                            ? '登录页已在这个店铺已打开的 Chrome 里新开标签页，登录完点「完成并保存」'
                            : '已打开登录页，请在弹出的窗口里完成登录，完成后点「完成并保存」';
                        });
                      },
                    }, busyId === a.id + ':open' ? '打开中…' : '去登录')));
          }))),

        schedOpen && h(ScheduleDialog, {
          schedule: sched,
          onClose: function () { setSchedOpen(false); },
          onSaved: function (next) {
            setSchedOpen(false);
            toast('ok', next && next.enabled
              ? ('排期已保存：每天 ' + next.startTime + ' 起 · 每组 ' + next.groupSize + ' 个 · 间隔 ' + next.groupIntervalMin + ' 分钟')
              : '排期已保存（定时任务未开启，到点不会跑）');
            load(true);
          },
          onError: function (msg) { toast('err', msg); },
        }),

        dialog && h(AccountDialog, {
          account: dialog.mode === 'edit' ? dialog.account : null,
          platforms: (state.data && state.data.platforms) || null,
          // 关掉弹窗要刷新一次：改名/改备注/勾选删档案（服务端可能已经把账号删了）之后
          // 列表和详情都得跟着变，否则界面留着旧数据、点进去一律 404（v0.8.1 修）。
          onClose: function () { setDialog(null); load(true); },
          onError: function (msg) { toast('err', msg); },
          onInfo: function (msg) { toast('ok', msg); },
          onCreated: function (account) {
            setDialog(null);
            // 导入一份已经登录过的档案时不要再把人送去登录页：服务端探测过 pendingLogin=false，
            // 直接开工作台复用登录态（否则会把"导入即可复用"变成"还得重扫一次"）（v0.8.1 修）。
            var reused = account && account.pendingLogin === false && account.lastCheck && account.lastCheck.loggedIn;
            toast('ok', '已创建「' + (account.name || '') + '」' + (reused ? '，正在复用已登录的档案…' : '，正在打开登录窗口…'));
            api('/accounts/' + encodeURIComponent(account.id) + '/open', { method: 'POST', body: { mode: reused ? 'work' : 'login' } })
              .then(function (r) {
                if (r && r.autofill && r.autofill.loggedIn) toast('ok', '已用保存的账号密码自动登录成功，确认后可点「完成并保存」');
                else if (r && r.autofill && r.autofill.attempted) toast('err', '已打开窗口，但账密登录没完成：' + (r.autofill.hint || r.autofill.code || '请在窗口里手动登录'));
                return load(true);
              })
              .catch(function (err) { toast('err', err.message || String(err)); });
          },
        }));
    }

    exports.name = PACKAGE;
    exports.inject = ['slots'];
    exports.apply = function apply(ctx) {
      injectCss();
      installClientErrorReporting();
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: SECTION_ID, order: 300, label: '账号管理' },
          function () { return h(ShopAccountsSection); },
        );
      });
    };
    return module.exports;
  },
});
