# 变更历史

> 每个版本都是在本机（Windows + Chrome）真机验过的；「验证」条目就是当时的实测证据，
> 数字都当真跑出来的看。自检项数指 `node test/smoke.mjs` 的条数。

## v0.6.9

- **加真机诊断日志**：`<数据目录>/debug.log`（默认 `C:\Users\mo\.dsh\shop-accounts\debug.log`）按时间顺序记下
  `open` / `close` / `check` / `finish` 四类动作，每条带当时的 URL 和「关键 cookie 快照」
  （`sessionCookies` + `identityCookies` + `QNWORKBENCH_SESSION`，只记名字/域/到期，**不记值**）、
  `finish` 的结果与未保存原因、身份 cookie 门等了多久、缺哪个。超过 512KB 自动重开。
- 起因：复现路径是「登录完 → 点打开工作台 → 关掉 → 再点检测 → 失效」，光靠聊天问不出哪一步把 `unb` 弄丢了，
  所以把每一步的现场落盘，下一次直接看时间线定位。
- 验证：smoke 51 项；`check.mjs` 跑 `silent-check` / `finish` 后 `debug.log` 里能看到对应条目（含 cookie 快照）。

## v0.6.8

- **诊断加强：界面能识破「文件更新了、但 DSH 没重启」**。`/state` 新增 `loadedVersion`（模块加载那一刻
  记下的版本，见 `lib/index.js` 的 `LOADED_VERSION`），「版本与更新」卡片会显示
  「当前版本：v0.6.8（本次启动加载的是 v0.6.7）」，两者不一致时直接红字提示「关掉 DSH Desktop 再打开」。
- 起因：v0.6.7 的修法装到磁盘后，用户又试了一次还是失败 —— 一查宿主进程启动时间还是 14:34，
  内存里跑的是 v0.6.6，新代码根本没加载。以前 `ownVersion()` 读的是磁盘 `package.json`，
  所以界面显示新版本号、实际跑旧代码，把人和用户都骗了。
- 验证：smoke 51 项（`/state` 必须带 `loadedVersion`，自检环境下两者应相同）。

## v0.6.7

- **接着修「千牛保存了还是未登录」的第二层原因**：v0.6.6 让会话级 cookie 能落盘了，但真机第二次还是翻车。
  这次在用户登录的窗口上挂 CDP 监听（`C:\Users\mo\cluade\shop-accounts-diag\watch-login.mjs`），
  抓到了确切时间线：`08:09:41` 工作台已能打开，但**身份 cookie `unb` 要到工作台自己再页内跳一次才种下来**
  （`08:09:41` 那一次就齐了；更早那次 `08:04` 用户一点保存就关窗，`unb` 根本没下来）。
  也就是说：**用户点保存点早了**，关窗带走的是一个还没拿到身份的会话。
- 修法：`finish` 关窗**之前**新增一道门 `waitForIdentityCookies` —— 按平台的 `identityCookies`
  （淘宝 = `unb` + `sgcookie`）逐个核对，缺就每秒重读、最长等 20 秒；等 5 秒还不齐就
  主动把窗口导回一次工作台（`navigatePageTo`）催站点下发；等到超时仍不齐 → **不关窗、回 `saved:false`**
  并直说「还没拿到身份 cookie（unb）……等能看见店铺数据了再点一次」。
- 验证：`node test/smoke.mjs` **51 项**（新增假时钟单测：缺 unb 时继续等、5 秒后催工作台、
  一直不齐不放行并指名缺哪个、没身份要求的平台不空等）；真机 `check.mjs --action=finish` →
  `saved:true`、`closed:true`、复核 `loggedIn:true`（matched 含 `unb`）、7257ms；
  随后独立再跑一次静默检测（全新无头浏览器）仍 `loggedIn:true`、`cookieCount:85`、url 工作台 →
  **登录态真的活过了关窗**。

## v0.6.6

- **修「千牛登录完说保存了、状态也变了，下一秒打开还是未登录」**。真机查到的账：
  淘宝卖家登录靠的 `cookie2` / `_tb_token_` 是**会话级 cookie**（cookie 库里 `is_persistent=0`），
  Chrome 默认**关窗就丢**；而 `QNWORKBENCH_SESSION`、`sgcookie` 是持久 cookie、留下来了 ——
  可缺了会话级那两个，站点照样把你按回登录页。所以「保存时窗口里已登录」和「档案里存着登录态」是两件事。
- 修法 ①：`launchBrowser` 一律加 `--restore-last-session`，Chrome 才会把会话级 cookie 落盘并在下次启动读回
  （实测：不加 → 丢；只写 Preferences 的 `session.restore_on_startup=1` → 也丢；加这个开关 → 留得住）。
- 修法 ②：这个开关会顺带恢复上次的标签页，静默检测改成「自己开一个干净标签 → 关掉其它页面目标 →
  只认这个标签页」（`settlePage` 新增 `opts.targetId`），免得挑中恢复出来的旧登录页。
- 修法 ③：`finish`（保存登录态）关窗之后**再静默复核一次**，复核不过就 `saved:false` 并说明原因，
  不再出现「说保存了、其实是假的」。
- 验证：`node test/smoke.mjs` 50 项；`C:\Users\mo\cluade\shop-accounts-diag\session-cookie-plugin.mjs`
  用插件自己的启动器实测「会话 cookie 活过关窗 ✅」；真机静默检测照旧（拼多多已登录 / 淘宝未登录如实报）。

## v0.6.5

- 去掉行内「开启·HH:MM」胶囊的悬停提示（`title` 里那串「到点自动做一次静默检测…」浮出来挡视线）。
- 验证：smoke 47 项（新增断言：源码里不许再出现那句 title 文案）。

## v0.6.4

- 去掉数字框的自定义 `− / +` 按钮：`type=number` 自带上下箭头，两个并存显得重复。
  `NumberField` 回归成一个 `<input type="number">`（原生箭头可点、键盘 ↑↓ 可用、浏览器自己过滤非法字符）。
- 顺带删掉 `.sa-num` / `.sa-numinput` / `.sa-numbtn` 三组样式。
- 验证：smoke 47 项（断言反过来钉住 `sa-numbtn` 与 `'−'` 不许再出现）；渲染复核输入框可输入、值 3、预览请求 `groupSize:3`。

## v0.6.3

- 用户反馈「每组店铺数调不了 —— 打字没反应」。先用可视化探针排除了遮挡/禁用/逻辑问题
  （输入框中心命中自己、模拟打字后值变 3、预览请求体 `groupSize:3`），最终改成 `NumberField`：
  `type=number` + `− / +` 步进按钮，并去掉手写的 `replace(/[^\d]/g,'')`（它会把全角数字直接吞掉）。
- 验证：smoke 47 项。

## v0.6.2

- 排期横幅第二行文案按用户给的参考原话定死：「适用于全部店铺，含已暂停任务；错过时间不补跑。」
  「· 下次 …」挪到横幅悬停提示，保证横幅永远两行。
- 验证：smoke 断言第二行含该原文且不许出现「下次 」；截图 `ui-banner-wide.png`。

## v0.6.1

- 排期横幅贴合参考样式：不再折行（`space-between`），左侧两行（`.sa-schedtitle` 粗 / `.sa-schedsub` 淡），
  右侧描边胶囊按钮 `.sa-schedpill` 承载「调整排期」。
- 验证：smoke 47 项；渲染 1280（一行）/ 590（折两行但按钮在右）/ 深色三张对照图。

## v0.6.0

- 新增**保活（尽量续期）**：定时检测判「已登录」后让页面再留 `keepaliveSec`（默认 8 秒，0 = 关闭）再复查。
- 新增 `tokenExpiryOf(cookies, platform)`：取平台会话 cookie 里最晚的到期时间，详情页显示「凭证到期」。
- 实测证据（拼多多真档案）：`--keepalive=8` → 10898ms、`loggedIn:true`、`keptAliveSec:8`、
  `tokenExpiry:2027-01-27T03:47:18Z`；18 秒后再测 → `tokenExpiry:…03:47:36Z` ——
  每次访问工作台站点都把身份 cookie 重发成「当时 + 100 天」，**访问本身就在续签**。
  淘宝（已掉线）走保活路径 → 2776ms、不做无谓停留、仍判登录页。
- 边界：纸面到期 ≠ 会话可用（掉线店铺 cookie 常还躺一年）；保活不保证永不掉线。
- 验证：smoke 46 → 47 项。

## v0.5.4

- 修「详细配置不居中」：`.sa-schedcell` 改 `align-items:center`。
- 修「灰色小字看不清」：说明性小字从 `--dsw-alias-label-caption` 换成 `--dsw-alias-label-secondary` ——
  浅色主题下前者 `#adb2b8` 对白底只有 **2.0:1**，后者 `#61666b` → **5.8:1**（深色 `#cfd3d6` → **12.1:1**）。
- 验证：`preview.mjs` 加对比度探针（getComputedStyle + WCAG 公式）实测 5.8:1 / 12.1:1；smoke 46 项。

## v0.5.3

- 修窄窗口错位：DSH 窗口窄（内容区 ~590px）时「操作」列被顶出屏幕、整页右溢。
  给 `.sa-list` 加 `container-type:inline-size`，加 `@container (max-width:700px)`：6 列自动变 5 列、
  隐藏「调试端口」列（端口并到店铺名下面），`min-width` 归零。
- 验证：`preview.mjs` 新增 `--width/--height` + overflow 探针，590 与 460 宽 `pageOverflowX` 均为 0；smoke 46 项。

## v0.5.2

- 去掉排期预览的 ↑↓ 按钮（只留拖拽）。
- 拖动中的行不再半透明：`opacity:1` + 实底 `color-mix(in srgb, #2f9e5f 16%, var(--dsw-alias-bg-base))` + 绿色内描边；
  并用 `dataTransfer.setDragImage(1×1 空白 canvas)` 干掉浏览器自带的半透明拖影。
- 验证：`preview.mjs --dialog --drag` 派发真 `DragEvent` 读到 `data-drag='1'/'2'`、`opacity:"1"`、实色底；smoke 46 项。

## v0.5.1

用户反馈「做拖拽吧，上面的字看不清，下面的表格样式也变了」，三处真因：

- **表格错位**：行里已有 6 个格子，网格还是 5 列 → 改成 6 列 `minmax(120px,1.6fr) 54px minmax(96px,1fr) minmax(84px,1fr) 60px 132px`。
- **字看不清**：弹窗底色用了带 alpha 的 `--dsw-menu-surface-fill`（浅色 `#f8f9fa94` / 深色 `#43454a73`），
  底下列表透上来 → 改实色 `--dsw-alias-bg-base`。
- **弹窗按钮被挤出视野 / 预览列表被压扁**：`.sa-dialog` 改 `overflow:hidden` + 正文 `.sa-dialog-body` 自己滚；
  `.sa-plist` / `.sa-scroll` 加 `flex:0 0 auto`。
- **拖拽排序**：预览行可拖（`⠿` 手柄、目标行描边）。
- 新增可视化验证工具 `shop-accounts-diag/preview.mjs`：本地起服务 + 桩 React + 真 client.js，
  用挪到屏幕外的真实 Chrome（1280×900）渲染并截图。
- 验证：smoke 45 → 46 项（样式契约）。

## v0.5.0

- 新增**定时检测（排期）**：每天定点把全部店铺排成一队做静默检测，结果写回、列表状态自动刷新。
- 新增 `lib/schedule.mjs`（纯函数排期算法：`normalizeSchedule` / `planSchedule` / `dueRows` / `nextRun` / `markRan` …），
  宿主 `scheduleView()` / `tickSchedule()`（**先记账再执行**，避免失败后每 20 秒重试把无头 Chrome 起爆）、
  20 秒心跳；路由 `GET/PUT /schedule`、`POST /schedule/preview`、`POST /accounts/:id/schedule`。
- 界面：排期横幅、「定时检测」列、调整排期弹窗（起始时间/组间隔/每组店铺数/总开关/预览排序）。
- 验证：smoke 45 项（含整页与弹窗的桩 React 渲染）；真机 `schedule-check.mjs` 25 项全过
  （真起无头 Chrome 跑 tick、空档案如实未登录、写回 `lastCheckAt`/`lastSchedAt`、同点不重复、23:59 不补跑）。

## v0.4.1

- 「更新到最新」按钮改为**只有检测出新版本时才可点**：`canApply = updInfo.ok !== false && updInfo.needsUpdate`，
  `disabled: busy || !canApply`，`runUpd()` 内再做一次自查。更新成功后 `needsUpdate:false`，按钮自动变灰。
- 验证：smoke 36 项（源码级断言）；期间 GitHub 443 一度不通，插件 `/update` 如实返回 `ok:false`，按钮保持灰。

## v0.4.0

- 新增**版本与更新**卡片：检测更新（`git fetch` 后比较本地版本 / 源码 HEAD / `origin/main`，显示落后几个提交）、
  更新到最新（`merge --ff-only` + 覆盖 `lib/ package.json README.md test/`）。
- 验证：本地三件套回归 17 项（bare 远端 ← 落后 1 提交的克隆 ← 更旧的安装拷贝）；真机把 0.3.3 安装副本更新到 0.4.0；
  smoke 35 项。

## v0.3.3

- 登录态文案收紧成一句话：登过掉线 → **登录已失效，请重新登录**（状态列显示「登录已失效」）；
  从没登过 → **未登录，请前往登录页登录**。判据用 `account.lastLoginAt`（不用 cookie 罐里有没有残留）。
- 顺带查清一件事：用**有头**窗口 + 正常 UA（`Chrome/155`，非 `HeadlessChrome`）打开同一份拼多多档案，
  同样被按回登录页、cookie 还是 22 个 —— 会话确实被站点作废，与无头无关。
- 验证：两条分支都真机跑过（老档案 2.7s / 空档案 3.1s）；smoke 断言钉住这两句话并禁「多半/也许/似乎/疑似/可能」。

## v0.3.1

- 修 **「浏览器关着时检测不出登录掉了」**（v0.3.0 的真 bug）：无头检测把工作台 URL 当启动参数，
  页面目标 +377ms 就停在工作台 URL 上，站点 +632ms 才跳登录页；旧 `settlePage` 一看到平台域名就算稳
  → 判的是工作台 URL + 罐里没清掉的 `PASS_ID`/`SUB_PASS_ID` → 报「已登录」。
- 修法：`settlePage` 等 `readyState === 'complete'` 且 URL 稳定 1.5s（资源不结束则 4s 也认，上限 12s），
  把等稳后的 URL 交给 `judgeLogin`（`readLoginFrom(port, platform, preferUrl)`）。
- 验证：两个真档案（改前都报假的 `loggedIn:true`）→ 拼多多 `evidence:'login-page'` ~2.7s、淘宝同 ~2.6s；
  `live-probe.mjs` 新增「慢跳转」回归（本地页 400ms 后 JS 跳 `/login`）实测等到最终 URL、2098ms；smoke 32 项。

## v0.3.0 及更早（2026-10-14 首版基线）

- 一店一档案 + 固定调试端口；有头窗口登录、后台轮询判定、点「完成」自动关窗。
- 六个商家端平台的登录页/工作台/身份 cookie 判据（见 README 平台表）。
- 实测结论：天猫商家就是千牛（`tmall.seller.taobao.com` 不存在）；京东登录态看 `pt_key`/`pt_pin`；
  1688 未登录时 `__cn_logon__=false`（卡值）；抖店未登录页就有 `passport_csrf_token`（已从判据移除）。
- 空档案登录页六个平台都判未登录，没有误判。
- 端口归属不用 `Browser.getBrowserCommandLine`（它要配合 `--enable-automation`，会设置 `navigator.webdriver`），
  改成「自己起的浏览器自己登记（`runtime.json`）+ 进程命令行查询兜底」。
- 验证：smoke 32 项；`live-probe.mjs` 六平台各自单跑全过（Chrome 154.0.8037.99）。
