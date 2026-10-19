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

    /** 平台表：与 lib/platforms.mjs 一一对应（改动必须两边一起改）。 */
    var PLATFORMS = [
      { id: 'pdd', label: '拼多多', hint: '拼多多商家后台（mms）' },
      { id: 'taobao', label: '淘宝', hint: '千牛工作台（卖家端）' },
      { id: 'tmall', label: '天猫', hint: '天猫商家中心（千牛）' },
      { id: 'douyin', label: '抖音', hint: '抖店（fxg.jinritemai.com）' },
      { id: 'jd', label: '京东', hint: '京麦工作台（京东商家端）' },
      { id: 'ali1688', label: '1688', hint: '1688 卖家工作台（商家端）' },
    ];
    function platformLabel(id) {
      for (var i = 0; i < PLATFORMS.length; i += 1) if (PLATFORMS[i].id === id) return PLATFORMS[i].label;
      return id;
    }

    // ── 样式（只注入一次；工厂每次页面加载只跑一遍，所以这里天然只有一份）──

    var CSS = [
      '.sa-root{display:flex;flex-direction:column;gap:14px;padding:2px 2px 40px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#e8eaed);}',
      '.sa-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.sa-title{margin:0 0 4px;font-size:18px;font-weight:600;}',
      '.sa-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-caption,#8b9096);}',
      '.sa-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.sa-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;',
      'border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;white-space:nowrap;}',
      '.sa-btn:hover:not(:disabled){background:rgba(127,127,127,.14);}',
      '.sa-btn:disabled{opacity:.5;cursor:default;}',
      '.sa-btn-primary{background:#2f9e5f;border-color:#2f9e5f;color:#fff;font-weight:600;}',
      '.sa-btn-primary:hover:not(:disabled){background:#37b06b;border-color:#37b06b;}',
      '.sa-btn-danger{color:#e5675f;border-color:rgba(229,103,95,.5);}',
      '.sa-btn-danger:hover:not(:disabled){background:rgba(229,103,95,.14);}',
      '.sa-tabs{display:flex;gap:8px;flex-wrap:wrap;}',
      '.sa-tab{padding:5px 13px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font-size:12px;cursor:pointer;}',
      '.sa-tab[data-on="1"]{background:rgba(127,127,127,.2);border-color:rgba(127,127,127,.55);font-weight:600;}',
      '.sa-search{width:100%;box-sizing:border-box;padding:8px 12px;border-radius:9px;font-size:13px;color:inherit;',
      'border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.07);outline:none;}',
      '.sa-search:focus{border-color:rgba(127,127,127,.55);}',
      '.sa-list{border:1px solid rgba(127,127,127,.2);border-radius:12px;overflow-x:auto;overflow-y:hidden;}',
      '.sa-rowhead,.sa-row{display:grid;grid-template-columns:minmax(0,1.7fr) 54px minmax(86px,1fr) 60px 146px;',
      'align-items:center;gap:8px 10px;padding:11px 14px;}',
      '.sa-rowhead>div,.sa-row>div{min-width:0;}',
      '.sa-rowhead{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#8b9096);',
      'background:var(--dsw-alias-menu-group-header-fill,rgba(127,127,127,.08));}',
      '.sa-row{border-top:1px solid rgba(127,127,127,.14);}',
      '.sa-row:hover{background:rgba(127,127,127,.06);}',
      '.sa-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sa-note{font-size:11px;color:var(--dsw-alias-label-caption,#8b9096);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
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
      '.sa-hint{font-size:11px;color:var(--dsw-alias-label-caption,#8b9096);}',
      '.sa-empty{padding:36px 14px;text-align:center;color:var(--dsw-alias-label-caption,#8b9096);font-size:12px;}',
      '.sa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;}',
      '.sa-dialog{width:min(560px,94vw);max-height:88vh;overflow:auto;box-sizing:border-box;border-radius:14px;padding:18px;',
      'background:var(--dsw-menu-surface-fill,#22252a);border:1px solid rgba(127,127,127,.28);box-shadow:0 24px 64px rgba(0,0,0,.5);',
      'display:flex;flex-direction:column;gap:14px;}',
      '.sa-dialog-title{font-size:15px;font-weight:600;margin:0;}',
      '.sa-plats{display:flex;gap:10px;flex-wrap:wrap;}',
      '.sa-plat{flex:1 1 140px;text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer;',
      'border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;}',
      '.sa-plat[data-on="1"]{border-color:#2f9e5f;background:rgba(47,158,95,.14);}',
      '.sa-plat-label{font-weight:600;font-size:13px;}',
      '.sa-dialog-foot{display:flex;justify-content:flex-end;gap:8px;}',
      '.sa-toasts{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:8px;z-index:10000;}',
      '.sa-toast{padding:9px 14px;border-radius:10px;font-size:12px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,.4);',
      'background:var(--dsw-menu-surface-fill,#22252a);border:1px solid rgba(127,127,127,.3);}',
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
      '.sa-dlabel{font-size:13px;color:var(--dsw-alias-label-caption,#8b9096);padding-top:2px;}',
      '.sa-dvalue{display:flex;flex-direction:column;align-items:flex-end;gap:8px;}',
      '.sa-dtext{font-size:13px;text-align:right;}',
      '.sa-dfoot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}',
      '.sa-link-danger{background:transparent;border:0;padding:0;color:#e5675f;font-size:13px;cursor:pointer;}',
      '.sa-link-danger:hover:not(:disabled){text-decoration:underline;}',
      '.sa-link-danger:disabled{opacity:.5;cursor:default;}',
      // ── 详情页重排：工具条并进头部，资料卡只留可编辑项，底部只留两个关键动作 ──
      '.sa-dsec{border:1px solid rgba(127,127,127,.2);border-radius:12px;overflow:hidden;}',
      '.sa-dtop{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:13px 16px 10px;}',
      '.sa-dtitlewrap{display:flex;align-items:center;gap:10px;min-width:0;}',
      '.sa-dtitles{min-width:0;}',
      '.sa-dmeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-caption,#8b9096);}',
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
      return fetch(BASE + pathname, {
        method: opts.method || 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
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

    // ── 小工具 ────────────────────────────────────────────────────────────────

    function fmtTime(iso) {
      if (!iso) return '—';
      try {
        var d = new Date(iso);
        var p = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      } catch (e) { return String(iso); }
    }

    function statusOf(account) {
      if (account.pendingLogin) return { color: '#e0a84e', text: '等待登录', tone: 'warn' };
      var check = account.lastCheck;
      if (account.running && (!check || check.stale)) return { color: '#e0a84e', text: '运行中·待检测', tone: 'warn' };
      if (check && check.loggedIn) return { color: '#3fb950', text: '已登录', tone: 'ok' };
      if (check && check.loggedIn === false) {
        // 以前登录过、现在判为未登录 = 掉线了，得重新扫码 —— 这种要说清楚，别只写"未登录"
        if (account.lastLoginAt) return { color: '#e5675f', text: '登录已失效', tone: 'err' };
        return { color: '#e5675f', text: '未登录', tone: 'err' };
      }
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

    /** 新增 / 编辑店铺的弹窗。 */
    function AccountDialog(props) {
      var editing = props.account || null;
      var [platform, setPlatform] = React.useState(editing ? editing.platform : 'pdd');
      var [name, setName] = React.useState(editing ? editing.name : '');
      var [note, setNote] = React.useState(editing ? editing.note : '');
      var [profileDir, setProfileDir] = React.useState('');
      var [port, setPort] = React.useState('');
      var [wipe, setWipe] = React.useState(false);
      var [busy, setBusy] = React.useState(false);

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
              profileDir: profileDir || undefined,
              port: /^\d+$/.test(port) ? parseInt(port, 10) : undefined,
            },
          }).then(function () {
            if (wipe) {
              return api('/accounts/' + encodeURIComponent(editing.id), { method: 'DELETE', body: { deleteProfile: true } })
                .then(function () { props.onInfo('已删除该账号及其浏览器档案目录'); });
            }
            props.onInfo('已保存');
            return null;
          }).then(done).catch(fail);
          return;
        }
        api('/accounts', {
          method: 'POST',
          body: {
            platform: platform,
            name: name,
            note: note,
            profileDir: profileDir || undefined,
            port: /^\d+$/.test(port) ? parseInt(port, 10) : undefined,
          },
        }).then(function (r) {
          props.onCreated(r.account);
          done();
        }).catch(fail);
      }

      return h('div', { className: 'sa-overlay', onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); } },
        h('div', { className: 'sa-dialog' },
          h('h3', { className: 'sa-dialog-title' }, editing ? '编辑店铺' : '新增店铺账号'),

          !editing && h('div', null,
            h('div', { className: 'sa-hint', style: { marginBottom: '8px' } },
              '选择平台（' + PLATFORMS.map(function (p) { return p.label; }).join(' / ') + '）'),
            h('div', { className: 'sa-plats' },
              PLATFORMS.map(function (p) {
                return h('button', {
                  key: p.id,
                  className: 'sa-plat',
                  'data-on': platform === p.id ? '1' : '0',
                  onClick: function () { setPlatform(p.id); },
                },
                  h('div', { className: 'sa-plat-label' }, p.label),
                  h('div', { className: 'sa-hint' }, p.hint));
              }))),

          h(Field, { label: '店铺名' },
            h('input', {
              className: 'sa-input', value: name, placeholder: '例如：韩品兰坊',
              onChange: function (e) { setName(e.target.value); },
            })),

          h(Field, { label: '备注' },
            h('input', {
              className: 'sa-input', value: note, placeholder: '例如：淘宝·韩品兰坊·阿柔，商家账号',
              onChange: function (e) { setNote(e.target.value); },
            })),

          !editing && h(Field, { label: '已有浏览器目录' },
            h('input', {
              className: 'sa-input', value: profileDir,
              placeholder: '留空 = 新建一份干净档案（推荐）',
              onChange: function (e) { setProfileDir(e.target.value); },
            })),
          !editing && h('div', { className: 'sa-hint', style: { marginTop: '-6px' } },
            '填入已登录过的 Chrome 用户目录可以直接复用它的登录态，例如 D:\\store-browser\\chrome-profile。' +
            '注意：一个目录同一时间只能被一个 Chrome 实例使用。'),

          h(Field, { label: '调试端口' },
            h('input', {
              className: 'sa-input', value: port, placeholder: '留空 = 自动分配（9222 起）',
              onChange: function (e) { setPort(e.target.value.replace(/[^\d]/g, '')); },
            })),
          h('div', { className: 'sa-hint', style: { marginTop: '-6px' } },
            '上架流程靠这个端口复用登录态。默认从 9222 开始找空位，与本机既有的店铺浏览器 / 上架脚本对齐。'),

          editing && h('label', { className: 'sa-hint', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: wipe, onChange: function (e) { setWipe(e.target.checked); } }),
            '同时删除磁盘上的浏览器档案目录（连同登录态一起清掉，不可恢复）'),

          h('div', { className: 'sa-dialog-foot' },
            h('button', { className: 'sa-btn', onClick: props.onClose, disabled: busy }, '取消'),
            h('button', { className: 'sa-btn sa-btn-primary', onClick: submit, disabled: busy },
              busy ? '处理中…' : (editing ? '保存' : '创建并去登录')))));
    }

    /**
     * 一个店铺的详情页 —— 列表里每行的「管理」入口。
     * 版式对齐用户原来那套账号工具的「管理」页：平台 / 店铺名 / 店铺 URL / 账号 / 账号类型 / 登录状态，
     * 左下「删除账号」、右下「重新登录」；其余动作用来不丢功能（检测 / 打开工作台 / 重扫 / 复制档案路径 / 编辑）。
     */
    function AccountDetail(props) {
      var a = props.account;
      var st = statusOf(a);
      var [url, setUrl] = React.useState(a.url || '');
      var [loginName, setLoginName] = React.useState(a.loginName || '');
      var [accountType, setAccountType] = React.useState(a.accountType || '商家账号');
      var [saving, setSaving] = React.useState(false);
      var [removing, setRemoving] = React.useState(false);
      var busy = props.busyId || '';
      var dirty = url !== (a.url || '') || loginName !== (a.loginName || '') || accountType !== (a.accountType || '');

      function save() {
        setSaving(true);
        api('/accounts/' + encodeURIComponent(a.id), {
          method: 'PUT',
          body: { url: url, loginName: loginName, accountType: accountType },
        }).then(function () {
          setSaving(false);
          props.onInfo('店铺资料已保存');
          return props.reload();
        }).catch(function (err) { setSaving(false); props.onError(err.message || String(err)); });
      }

      function remove() {
        if (!window.confirm('删除店铺「' + a.name + '」的记录？\n\n（浏览器档案目录会保留：登录态还在，以后还能导回来）')) return;
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
                  h('span', { className: 'sa-pill', 'data-tone': st.tone || 'none' },
                    h('span', { className: 'sa-dot', style: { background: st.color } }), st.text),
                  a.port && h('span', { className: 'sa-mono' }, ':' + a.port),
                  h('span', null, live)))),
            h('div', { className: 'sa-hint', style: { textAlign: 'right' } },
              h('div', null, a.lastCheckAt ? '检测于 ' + fmtTime(a.lastCheckAt) : '还没检测过'),
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
                    return r && r.reused ? '已在这个店铺已打开的浏览器里打开工作台' : '已打开 ' + a.name + '（端口 ' + r.port + '）';
                  });
                },
              }, '打开工作台'),
            h('button', {
              className: 'sa-btn', disabled: busy === a.id + ':reset',
              title: '清空这个店铺的本地登录档案并重新打开登录页',
              onClick: function () {
                if (!window.confirm('清空「' + a.name + '」的本地登录档案并重新扫码？\n\n档案目录会被删掉重建，只影响这个店铺的登录态。')) return;
                props.act(a, 'reset', {}, '已清空档案并打开登录页，请在新窗口里重新扫码');
              },
            }, busy === a.id + ':reset' ? '重扫中…' : '重扫（清档案）'),
            h('button', { className: 'sa-btn', title: a.profileDir || '', onClick: copyPath }, '复制档案路径'),
            h('button', { className: 'sa-btn', onClick: function () { props.onEdit(a); } }, '编辑店铺'))),

        h('div', { className: 'sa-dsec' },
          h('div', { className: 'sa-dcard' },
            row('店铺 URL', h('div', { className: 'sa-dvalue', style: { width: '100%' } },
              h('input', {
                className: 'sa-input', value: url, placeholder: '店铺主页链接（选填）',
                onChange: function (e) { setUrl(e.target.value); },
              }))),
            row('账号', input(loginName, setLoginName, '登录账号名，例如 韩品兰坊;阿荣')),
            row('账号类型', h('div', { className: 'sa-dvalue', style: { width: '100%' } },
              h('select', {
                className: 'sa-input', value: accountType,
                onChange: function (e) { setAccountType(e.target.value); },
              },
                h('option', { value: '商家账号' }, '商家账号'),
                h('option', { value: '个人账号' }, '个人账号'),
                h('option', { value: '' }, '不填'))))),
          h('div', { className: 'sa-dsave' },
            dirty && h('div', { className: 'sa-hint' }, '有未保存的改动'),
            h('button', { className: 'sa-btn sa-btn-primary', disabled: saving || !dirty, onClick: save },
              saving ? '保存中…' : '保存修改'))),

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
                    return r.saved ? '登录状态已保存，浏览器窗口已关闭' : ('还没检测到登录态：' + ((r.check && r.check.reason) || '窗口保持打开，请完成后重试'));
                  });
                },
              }, busy === a.id + ':finish' ? '校验中…' : '完成并保存')
              : h('button', {
                className: 'sa-btn sa-btn-primary',
                disabled: busy === a.id + ':open',
                title: '在属于这个店铺的 Chrome 里打开平台登录页；窗口已经开着就会在里面新开一个标签页',
                onClick: function () {
                  props.act(a, 'open', { mode: 'login' }, function (r) {
                    return r && r.reused
                      ? '登录页已在这个店铺已打开的 Chrome 里新开标签页，登录完点「完成并保存」'
                      : '已打开登录页，请在弹出的窗口里完成登录，完成后点「完成并保存」';
                  });
                },
              }, a.lastCheck && a.lastCheck.loggedIn ? '重新登录' : '去登录'))));
    }

    /** 主页面。 */
    function ShopAccountsSection() {
      var [state, setState] = React.useState({ loading: true, data: null, error: null });
      var [tab, setTab] = React.useState('all');
      var [query, setQuery] = React.useState('');
      var [busyId, setBusyId] = React.useState('');
      var [dialog, setDialog] = React.useState(null); // {mode:'add'} | {mode:'edit', account}
      var [showConfig, setShowConfig] = React.useState(false);
      var [detailId, setDetailId] = React.useState('');
      var [toasts, setToasts] = React.useState([]);
      var seq = React.useRef(0);

      function toast(kind, text) {
        seq.current += 1;
        var id = seq.current;
        setToasts(function (prev) { return prev.concat([{ id: id, kind: kind, text: text }]); });
        setTimeout(function () { setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id; }); }); }, kind === 'err' ? 8000 : 4000);
      }

      function load(silent) {
        return api('/state').then(function (data) {
          setState({ loading: false, data: data, error: null });
          return data;
        }).catch(function (err) {
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
            if (okText) toast('ok', typeof okText === 'function' ? okText(r) : okText);
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

      function ConfigPanel() {
        var [form, setForm] = React.useState(null);
        var [updBusy, setUpdBusy] = React.useState('');
        var [updInfo, setUpdInfo] = React.useState(null);
        // 只按「服务器上的配置值」重填表单：登录轮询会不断刷新 state.data.now，
        // 用 now 当依赖会把用户正在输入的内容每 2.5 秒抹掉一次。
        var cfgKey = JSON.stringify(cfg);
        React.useEffect(function () {
          setForm({
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
        var version = (state.data && state.data.version) || '';
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
        return h('div', null,
          h('div', { className: 'sa-card' },
            h('div', { style: { fontWeight: 600 } }, '浏览器设置'),
            h(Field, { label: 'Chrome 可执行文件' },
              h('input', {
                className: 'sa-input', value: form.browserPath,
                placeholder: browser.path || '留空 = 自动探测（Chrome → Edge）',
                onChange: function (e) { setForm(Object.assign({}, form, { browserPath: e.target.value })); },
              })),
            h('div', { className: 'sa-hint', style: { marginTop: '-6px' } },
              browser.found ? ('当前生效：' + browser.path) : '没有探测到 Chrome / Edge，请手动填写完整路径。'),
            h(Field, { label: '档案根目录' },
              h('input', {
                className: 'sa-input', value: form.profileRoot,
                placeholder: (state.data && state.data.dataDir ? state.data.dataDir + '\\profiles' : '留空 = <数据目录>\\profiles'),
                onChange: function (e) { setForm(Object.assign({}, form, { profileRoot: e.target.value })); },
              })),
            h(Field, { label: '起始调试端口' },
              h('input', {
                className: 'sa-input', value: form.portBase,
                onChange: function (e) { setForm(Object.assign({}, form, { portBase: e.target.value.replace(/[^\d]/g, '') })); },
              })),
            h('label', { className: 'sa-hint', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                type: 'checkbox', checked: form.openWorkTab,
                onChange: function (e) { setForm(Object.assign({}, form, { openWorkTab: e.target.checked })); },
              }),
              '「打开」时额外开一个商品列表标签页'),
            h('label', { className: 'sa-hint', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                type: 'checkbox', checked: form.gracefulClose,
                onChange: function (e) { setForm(Object.assign({}, form, { gracefulClose: e.target.checked })); },
              }),
              '关闭前先请 Chrome 自己退出（让 cookie 落盘；失败会自动强杀）'),
            h('div', { className: 'sa-hint' },
              '数据目录：' + String((state.data && state.data.dataDir) || '')),
            h('div', { className: 'sa-actions' },
              h('button', { className: 'sa-btn sa-btn-primary', onClick: save }, '保存设置'),
              h('button', { className: 'sa-btn', onClick: function () { load(false); toast('ok', '已刷新'); } }, '刷新'))),

          h('div', { className: 'sa-card' },
            h('div', { style: { fontWeight: 600 } }, '版本与更新'),
            h('div', { className: 'sa-hint' },
              '当前版本：v' + (version || '?') + (detectedDir ? ' · 更新源：' + detectedDir : ' · 还没找到 git 源码目录')),
            h(Field, { label: '更新源目录（本插件的 git 源码仓库）' },
              h('input', {
                className: 'sa-input', value: form.updateDir,
                placeholder: detectedDir || '例如 D:\\dycopy\\dsh-plugin-shop-accounts（留空 = 自动猜）',
                onChange: function (e) { setForm(Object.assign({}, form, { updateDir: e.target.value })); },
              })),
            h('div', { className: 'sa-hint' },
              '「检测更新」只查询 GitHub 有没有新提交；「更新到最新」会把源码快进合并，再覆盖到 profile 里这份拷贝。覆盖完要重启 DSH Desktop 才生效。'),
            updText && h('div', { className: 'sa-hint', style: { color: (updInfo && updInfo.ok === false) ? '#e5675f' : null } }, updText),
            h('div', { className: 'sa-actions' },
              h('button', { className: 'sa-btn', disabled: Boolean(updBusy), onClick: checkUpd },
                updBusy === 'check' ? '检测中…' : '检测更新'),
              h('button', { className: 'sa-btn sa-btn-primary', disabled: Boolean(updBusy), onClick: runUpd },
                updBusy === 'apply' ? '更新中…' : '更新到最新'))));
      }

      return h('div', { className: 'sa-root' },
        h(Toast, { list: toasts }),

        !detail && h('div', { className: 'sa-head' },
          h('div', null,
            h('h2', { className: 'sa-title' }, '账号管理'),
            h('p', { className: 'sa-sub' }, '每个店铺一份独立的 Chrome 登录档案。登录一次就留着，上架时直接复用，不用重新登录。')),
          h('div', { className: 'sa-actions' },
            h('button', { className: 'sa-btn', onClick: function () { setShowConfig(!showConfig); } }, showConfig ? '收起设置' : '浏览器设置'),
            h('button', { className: 'sa-btn', onClick: function () { load(false); } }, '刷新'),
            h('button', { className: 'sa-btn sa-btn-primary', onClick: function () { setDialog({ mode: 'add' }); } }, '+ 新增店铺'))),

        state.error && h('div', { className: 'sa-card', style: { borderColor: 'rgba(229,103,95,.6)' } },
          h('div', null, '读取失败：' + state.error)),

        showConfig && !detail && h(ConfigPanel, { key: 'shop-accounts-config' }),

        detail && h(AccountDetail, {
          account: detail,
          busyId: busyId,
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
          h('div', { className: 'sa-hint' },
            '请在弹出的 Chrome 窗口里完成登录（扫码 / 短信，本插件不代填账号密码）。登录完成后回到这里点「完成并保存」：' +
            '会校验登录态、把档案落盘、然后自动关掉那个窗口。'),
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
                      return r.saved ? '登录状态已保存，浏览器窗口已关闭' : ('还没检测到登录态：' + ((r.check && r.check.reason) || '窗口保持打开，请完成后重试'));
                    });
                  },
                }, busyId === a.id + ':finish' ? '校验中…' : '完成并保存'),
                h('button', {
                  className: 'sa-btn', disabled: busyId === a.id + ':close',
                  onClick: function () { act(a, 'close', {}, '已关闭浏览器（未保存登录态）'); },
                }, '取消')));
          })),

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
            h('div', null, '店铺名'), h('div', null, '平台'), h('div', null, '登录状态'),
            h('div', null, '调试端口'), h('div', { style: { textAlign: 'center' } }, '操作')),

          visible.length === 0 && h('div', { className: 'sa-empty' },
            state.loading ? '读取中…' : (accounts.length ? '没有匹配的店铺' : '还没有店铺账号 —— 点右上角「+ 新增店铺」，在弹出的窗口里登录一次就够了')),

          visible.map(function (a) {
            var st = statusOf(a);
            return h('div', { key: a.id, className: 'sa-row' },
              h('div', null,
                h('div', {
                  className: 'sa-name', title: (a.name || '') + '（点这里看这家店的详情 / 管理）',
                  style: { cursor: 'pointer' },
                  onClick: function () { setDetailId(a.id); },
                }, a.name),
                h('div', { className: 'sa-note', title: a.note || a.profileDir },
                  (a.note ? a.note + ' · ' : '') + (a.running ? '运行中' : '未运行') +
                  (a.lastLoginAt ? ' · 上次登录 ' + fmtTime(a.lastLoginAt) : ''))),

              h('div', null, h('span', { className: 'sa-tag' }, platformLabel(a.platform))),

              h('div', null,
                h('div', { className: 'sa-status' },
                  h('span', { className: 'sa-dot', style: { background: st.color } }),
                  h('span', { style: st.tone === 'err' ? { color: '#e5675f' } : null }, st.text)),
                h('div', { className: 'sa-note', title: (a.lastCheck && a.lastCheck.reason) || '' },
                  a.lastCheckAt ? '检测于 ' + fmtTime(a.lastCheckAt) : '未检测')),

              h('div', null,
                h('div', { className: 'sa-mono' }, a.port ? ':' + a.port : '—'),
                h('div', { className: 'sa-note' }, a.port ? (a.running ? 'CDP 可用' : '未启动') : '未分配')),

              h('div', { className: 'sa-rowbtns sa-nowrap', style: { justifyContent: 'center' } },
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
                    title: '校验登录态、把档案落盘，然后自动关掉那个窗口',
                    onClick: function () {
                      act(a, 'finish', {}, function (r) {
                        return r.saved ? '登录状态已保存，浏览器窗口已关闭' : ('还没检测到登录态：' + ((r.check && r.check.reason) || '窗口保持打开，请完成后重试'));
                      });
                    },
                  }, busyId === a.id + ':finish' ? '校验中…' : '完成并保存')
                  : (a.lastCheck && a.lastCheck.loggedIn)
                    ? h('button', {
                      className: 'sa-btn',
                      title: '打开详情页：店铺 URL / 账号 / 账号类型 / 重扫 / 编辑 / 删除',
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

        dialog && h(AccountDialog, {
          account: dialog.mode === 'edit' ? dialog.account : null,
          onClose: function () { setDialog(null); },
          onError: function (msg) { toast('err', msg); },
          onInfo: function (msg) { toast('ok', msg); },
          onCreated: function (account) {
            setDialog(null);
            toast('ok', '已创建「' + (account.name || '') + '」，正在打开登录窗口…');
            // 创建后直接拉起登录窗口：用户点完"创建"下一步就是登录，没必要再让他点一次
            api('/accounts/' + encodeURIComponent(account.id) + '/open', { method: 'POST', body: { mode: 'login' } })
              .then(function () { return load(true); })
              .catch(function (err) { toast('err', err.message || String(err)); });
          },
        }));
    }

    exports.name = PACKAGE;
    exports.inject = ['slots'];
    exports.apply = function apply(ctx) {
      injectCss();
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
