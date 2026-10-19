# dsh-plugin-shop-accounts（账号管理）

DSH 的一个插件：**统一管理电商平台的店铺/账号登录态**。在「设置 → 账号管理」里增删店铺、
一键拉起登录窗口，登录完点「完成」，浏览器窗口自动关掉、登录态留在磁盘上；
后续上架流程直接复用同一份浏览器档案，**不用重新登录**。
目前支持 **拼多多 / 淘宝 / 天猫 / 抖音（抖店）/ 京东（京麦）/ 1688**，**全部是商家端**（卖家后台，
不是买家/消费端）。

## 它到底怎么保住登录态

一个店铺 = 一份**独立的 Chrome 用户目录（profile）** + 一个固定的**调试端口（CDP）**。

| 你要的东西 | 落点 |
| --- | --- |
| 店铺清单 / 配置 | `%DSH_HOME%\shop-accounts\accounts.json`、`config.json`（`%DSH_HOME%` 默认是 `~/.dsh`） |
| 登录态（cookie 等） | 每个店铺自己的 Chrome user-data-dir，默认 `%DSH_HOME%\shop-accounts\profiles\<账号id>\` |
| 调试端口 | 从 `portBase`（默认 9222）起自动找空位，一店一端口 |

登录窗口就是一个**真实的有头 Chrome**（不是无头、不是抓包），你在里面正常扫码/输密码/过滑块。
插件在后台轮询这个端口的登录态；一旦判成已登录，「完成」按钮就变可点，点下去窗口自动关闭。

## 用法

1. 「设置 → 账号管理」→ **新增店铺** → 选平台、填店铺名/备注（端口可留空自动分配）→ **创建并去登录**。
2. 在弹出的 Chrome 窗口里正常登录到**卖家端**商家后台（见下面那张平台表；淘宝/天猫是 `loginmyseller.taobao.com` → 千牛，拼多多是 `mms.pinduoduo.com`，抖音是抖店 `fxg.jinritemai.com`，京东是京麦 `passport.shop.jd.com`，1688 是 `login.1688.com`）。
3. 回到 DSH，行内状态会自己变成「已登录」→ 点该行的 **完成并关闭**。
4. 之后这个店铺就一直显示登录态；上架时把它的 `profileDir` + `port` 交给上架脚本复用。

其它动作：**检测**（静默复核登录态，不开窗口）、**打开**（重新拉起窗口到工作台）、**去登录 / 重新登录**、
**重扫**（清空这个店铺的本地档案再打开登录页 —— 站点在档案里留着半死会话、登录页直接跳回后台不给二维码时用）、
**完成并关闭**、**关闭**、**复制路径**（复制该账号的档案目录，给上架脚本用）、**编辑**、**删除**（可选连同磁盘档案目录一起删）。
每行最左边的 **管理** 会打开该店铺的详情页（见下节）。

> 关于「重新登录」：窗口**已经开着**的店铺，点「去登录 / 重新登录」会在**已有的那个浏览器里新开一个登录页标签页**，
> 不会再拉起第二只 Chrome（Chrome 是单实例，同档案再启一次只会把 URL 转给已有窗口然后自己退出，
> 而调试端口仍被老实例占着 —— 老版本在这里会变成"点了没反应"）。没开着的店铺才会启动新窗口。

## 支持的平台（都是商家端）

| 平台 | 登录页（新增店铺时打开的） | 「打开」落到的工作台 | 登录态认哪个 cookie |
| --- | --- | --- | --- |
| 拼多多 | `mms.pinduoduo.com/login` | 商家后台 / 商品列表 | `PASS_ID` / `SUB_PASS_ID` |
| 淘宝 | `loginmyseller.taobao.com`（千牛） | 千牛工作台 `qn.taobao.com/home.htm` | `unb` / `sgcookie`（必须命中其一） |
| 天猫 | `loginmyseller.taobao.com`（千牛） | 天猫商家中心 `myseller.taobao.com/home.htm` | 同淘宝（同一套账号体系） |
| 抖音 | 抖店 `fxg.jinritemai.com/login/common` | 抖店 `fxg.jinritemai.com/ffa/mshop/homepage/index` | `passport_assist_user` / `sessionid` / `sessionid_ss` / `passport_uid` |
| 京东 | 京麦 `passport.shop.jd.com/login/index.action` | 京麦 `jm.jd.com/index/index.html` | `pt_key` / `pt_pin` |
| 1688 | `login.1688.com/member/signin.htm` | 1688 卖家工作台 `work.1688.com/home/page/index.htm` | `_nk_` / `__cn_logon__=true` |

几个实测结论（2026-10-14，Chrome 154，无头 + 临时档案）：

- **天猫商家就是千牛**：`tmall.seller.taobao.com` 这个域名压根不存在，`sell.tmall.com` 报
  `error.taobao.com`（老后台已下线），`myseller.taobao.com/home.htm` 跳到 `loginmyseller.taobao.com`
  —— 和淘宝卖家同一套账号、同一套 cookie，所以判据完全一样，只是分组和工作台入口分开。
- **京东**：登录态在统一 SSO 的 `pt_key` / `pt_pin`；未登录的登录页上这两个都没有，
  但已经有 `sdtoken` / `JSESSIONID` / `3AB9D23F7A4B3C9B` / `__jda…`，所以这些一律不当判据。
- **1688**：未登录时 cookie 罐里就有 `cookie2` / `_tb_token_` / `t`，而且 **`__cn_logon__=false`**
  —— 名字在、值是 false，只看名字会误判成已登录，所以这条额外走「值判据」（`identityCookieValues`）。
- **抖店**：未登录的登录页上就有 `passport_csrf_token`，原先把它当身份 cookie 会把"没登录"说成"已登录"，已移除。
- 各平台的**上架/发品页**（千牛发布商品、京麦商品管理、1688 发布产品…）等有真实账号登录后再钉准，**不猜地址**。

## 店铺详情页（行上最左边的「管理」）

点某一行的 **管理** 进入该店铺的详情页，字段与动作：

| 字段 | 说明 |
| --- | --- |
| 平台 / 店铺名 | 只读；改名走详情页底部的「编辑店铺」 |
| 店铺 URL | 选填。**填了就作为「打开」时的工作台地址**（覆盖平台默认工作台）——上架要用哪个页面就记在这儿 |
| 账号 | 登录账号名（例如 `韩品兰坊;阿荣`），备注性质 |
| 账号类型 | 商家账号 / 个人账号 / 不填 |
| 登录状态 | 与列表一致，另附检测时间、端口、上次登录时间 |

底部：左下 **删除账号**（只删记录，档案目录保留），右下 **重新登录 / 去登录**；
该店铺正在「等待登录」时，右下换成 **完成并保存 / 取消登录**。
再下面一行是 **检测登录态 / 打开工作台（或关闭浏览器）/ 重扫（清档案）/ 复制档案路径 / 编辑店铺**。
左上角 **←** 返回列表。

## 登录态怎么判的（判据优先级）

1. **登录页最硬**：站点把你按回登录页 = 站点不认这个会话，哪怕 cookie 罐里还留着身份 cookie
   （服务端过期不会去清浏览器里的 cookie）也判未登录。
2. **身份 cookie**：域名对得上 + 名字命中该平台的身份 cookie（如拼多多 `PASS_ID`、京东 `pt_key`）+
   值不是占位符。匿名 cookie（`cna`、`_m_h5_tk`、`sdtoken` 这类）人人都有，**不算**登录凭证。
   个别平台还额外点明 `identityCookies`：真机实测空档案停在千牛登录页时 cookie 罐里已经有
   `cookie2` / `_tb_token_`，光数数量会把它当成已登录，所以淘宝/天猫要求必须命中 `unb` / `sgcookie`。
   1688 更特殊：`__cn_logon__` 在未登录时就存在、值是 `false`，所以用 `identityCookieValues`
   卡值 —— 只有 `=true` 才算数。
3. **URL 弱判据**：只有 CDP 读 cookie 失败时才退到它，且如实标成 `evidence: 'url'`，
   界面上和「确定」区分开。

这三条就是 `test/smoke.mjs` 里逐条钉住的契约 —— 判错登录态的代价是上架脚本跑到一半要求登录。

### 静默检测为什么要「等导航稳」

浏览器没开时，检测会用一个**无头** Chrome 打开同一份档案探一次。这里有个坑（v0.3.0 的真 bug，2026-10-19 修）：
把工作台 URL 作为启动参数丢给 Chrome，页面目标**一上来**就停在工作台 URL 上（实测 +377ms 就能看到，CDP +358ms 起来），
而站点把人甩到登录页是 +632ms 的事。旧实现「看到平台域名就算稳」，于是判的是工作台 URL + 档案里还没被清掉的
`PASS_ID` / `SUB_PASS_ID` → **明明掉线了也报「已登录」**；开着窗口时靠实时读 URL 还能发现，关着窗口就永远发现不了。

现在 `settlePage()` 只认「导航真正结束」：`document.readyState === 'complete'` 且 URL 连续 1.5s 不再变化
（资源一直不结束的站点，URL 稳定 4s 也认；总上限 12s），判据用的就是等稳后的那个 URL。
`test/live-probe.mjs` 用本地页复现了同一时序（先渲染"工作台"，400ms 后 JS 跳 `/login`），把这条回归钉住。

## 上架流程怎么接

````powershell
# 拼多多那条上架流程（dsh-plugin-pdd-product-listing / pdd-product-listing 技能）复用某个账号时，要对上两样：
#   · 调试端口   → 行上「调试端口」列显示的那个（对外就是 PDD_PORT）
#   · 浏览器档案 → 该账号的档案目录（行上「复制路径」复制到的就是它；
#                  给脚本用的时候是 open_browser.ps1 -Profile <档案目录>，或 config.json 里的 chrome_profile）
````

插件只负责**把登录态养在那里**；它不碰商品、不提交、不改价。

账号行已经显示「CDP 可用」时，说明这个店铺的浏览器正开着——上架脚本直接连这个端口就行，
**不要再另起一个 Chrome**（同一个档案目录被两个实例抢会报错，也不符合上架技能「复用已登录 profile」的要求）。

## 自检

````powershell
node test/smoke.mjs           # 32 项：平台判据 / 持久化（含运行期登记表）/ 宿主 HTTP 面 / 客户端 bundle 契约
node test/live-probe.mjs pdd  # 真机链路：临时档案里拉一个无头 Chrome，读一遍 cookie 再关掉
node test/live-probe.mjs all  # 六个平台都过一遍（建议一个一个跑，共用档案会串 cookie）
````

`smoke.mjs` 用 `DSH_SHOP_ACCOUNTS_DIR` 把数据目录指到临时目录，**不会碰真实账号**，也**不会启动任何浏览器**。

`live-probe.mjs` 会真的拉起一个**无头** Chrome（临时档案、不弹窗口、不碰店铺档案），验证
「启动 → 调试端口起来 → `Network.getAllCookies` 能读（HttpOnly 的唯一正路）→ `Browser.close` 正常关掉」这条链路；
带平台参数时还会用空档案打开该平台登录页，断言**不能**被误判成「已登录」；另外每次都会跑一条「慢跳转」回归
（本地页 400ms 后 JS 跳 `/login`，断言 `settlePage` 等的是最终那个 URL）。怀疑登录态判得不准时跑它。

## 安装

DSH 的插件是「profile 里的一个 npm 包 + 一行 bundle 登记」。两种装法：

**A. 从本目录直接装（开发时推荐）**

```powershell
dsh plugin --profile <profile名> add file:D:\path\to\dsh-plugin-shop-accounts
```

**B. 手动装（GUI 里没有安装入口时）**

1. 把整个目录复制到 `%DSH_HOME%\profiles\<profile名>\node_modules\dsh-plugin-shop-accounts\`；
2. 在 `%DSH_HOME%\profiles\<profile名>\package.json` 里登记两处：
   - `dsh.profile.bundles` 数组里加一项 `"dsh-plugin-shop-accounts"`；
   - `dependencies` 里加 `"dsh-plugin-shop-accounts": "file:<本目录的绝对路径>"`；
3. **重启 DSH Desktop**。

> 插件是**启动时挂载**的：宿主半身（`lib/index.js`）改了必须重启；只改客户端半身（`lib/client.js`）
> 刷新页面即可，但要先把文件同步到 profile 的 `node_modules` 副本里。

装好之后「设置」里会出现 **账号管理** 一节。

## 目录结构

````
lib/platforms.mjs   六个平台的登录页/主页/工作页、身份 cookie、域判据
lib/cdp.mjs         极简 CDP 客户端（裸 WebSocket，无第三方依赖）
lib/chrome.mjs      找浏览器、选端口、拉起/关闭/探测，读写登录态
lib/store.mjs       accounts.json / config.json / runtime.json 的原子读写与降级
lib/index.js        宿主：webServer 路由 /shop-accounts/*、页面用到的全部动作
lib/client.js       客户端 bundle：设置页「账号管理」整页 UI
cordis.patch.yml    插件挂载点（id: shop-accounts）
test/smoke.mjs      自检（不启动浏览器）
test/live-probe.mjs 真机链路探针（会拉起一个无头 Chrome，临时档案）
````

## 本机验证记录（2026-10-14）

- `node test/smoke.mjs` → 32 项全过；`node test/live-probe.mjs <平台>` 六个平台各自单跑 → 全过。
- 真机链路：Chrome 154.0.8037.99，无头拉起 → `/json/version` 有响应 → 页面目标可见 →
  `Network.getAllCookies` 返回数组 → 关掉后端口释放。
- 六个平台的**空档案**登录页都判成未登录，没有误判：
  拼多多 `matched: []`、淘宝 `matched: ['cookie2','_tb_token_']`（要命中 2 个才算，故仍判未登录）、
  天猫 同淘宝、抖音 `matched: []`、京东 `matched: []`、1688 `matched: ['cookie2','t','_tb_token_']`
  （`__cn_logon__=false` 已被值判据挡掉）。
- 这条实测顺手改掉一个真 bug：抖店的 `passport_csrf_token` 在**未登录**的登录页上就有，
  原先把它当身份 cookie，会让「没登录」被说成「已登录」——已从判据里移除。
- 「已运行的店铺点去登录」真机回归：先在临时档案里拉一只无头 Chrome 当"已运行"，再打真实路由
  `POST /accounts/:id/open {mode:'login'}` → 返回 `reused:true`、端口不漂移、**已有浏览器里多出登录页标签页**、
  账号进入「等待登录」（会出「完成并保存」）。
- 端口归属判定不用 CDP 的 `Browser.getBrowserCommandLine`：实测它必须配合 `--enable-automation`
  才返回命令行（`Command line not returned because --enable-automation not set.`），而那个开关会设置
  `navigator.webdriver`、登录站点有可能识别 —— 改成"自己起的浏览器自己登记（`runtime.json`）+ 进程命令行查询兜底"。

## 本机验证记录（2026-10-19：修「关着窗口检测不出登录掉了」/ v0.3.1）

- 根因不再是猜的：无头检测把工作台 URL 当启动参数，页面目标 +377ms 就停在工作台 URL 上，
  站点 +632ms 才跳登录页；旧 `settlePage` 一看到平台域名就判稳 → 读的是工作台 URL +
  档案里还没被清掉的 `PASS_ID` / `SUB_PASS_ID` → 报「已登录」。
- 修法：`settlePage` 等 `readyState === 'complete'` 且 URL 稳定 1.5s（资源不结束则稳定 4s 也认，上限 12s），
  并把等稳后的 URL 直接交给 `judgeLogin`（`readLoginFrom(port, platform, preferUrl)`）。
- 真机回归（两个真档案、浏览器都没开，改前都报假的 `loggedIn:true`）：
  拼多多 → `loggedIn:false` / `evidence:login-page` / url `https://mms.pinduoduo.com/login/?redirectUrl=...`，耗时 ~2.7s；
  淘宝 → `loggedIn:false` / `evidence:login-page` / url `https://loginmyseller.taobao.com/?...`，耗时 ~2.6s。
- `node test/smoke.mjs` → 32 项全过；`node test/live-probe.mjs pdd` → 全过，新增的「慢跳转」回归
  （本地页 400ms 后 JS 跳 `/login`）实测 `settlePage` 等到最终 URL、耗时 2098ms —— 旧实现会在第一次
  poll（~200ms）就返回工作台 URL，这条断言能直接钉住回归。
- 生效方式：宿主在启动时把插件代码加载进内存，改完要**重启 DSH Desktop**（改 profile 的
  `node_modules/dsh-plugin-shop-accounts` 副本也一样）。

## 本机验证记录（2026-10-19 晚：判定措辞 / v0.3.2）

- 「未登录」是确定结论，但旧原因写的是「cookie 罐里还有 `PASS_ID`、`SUB_PASS_ID`，多半已失效」——
  前半句是观测，后半句是在猜「为什么罐里还有 cookie」，所以句尾带了个含糊的「多半」。
- 为了排除「无头模式被站点识别」这个可能，用**有头**窗口、正常 UA（`Chrome/155`，不是 `HeadlessChrome`）
  打开同一份拼多多档案重测：同样被按回 `https://mms.pinduoduo.com/login/?redirectUrl=...`，
  cookie 仍然 22 个、`judgeLogin` 输出一模一样 → 是站点真把这个会话作废了，与无头无关。
- 措辞改成确定表述：「当前停在登录页：站点已经把这个会话作废，得重新登录（cookie 罐里还留着 …—— 服务端让会话失效时不会顺手去清浏览器里的 cookie）」。
- `test/smoke.mjs` 加断言钉住措辞：原因里必须有「重新登录」、不得出现「多半/也许/似乎/疑似/可能」、
  并且必须解释「罐里还有 cookie」与「会话已失效」不矛盾。

## 已知边界

- **不代登录、不破验证码**：扫码/短信/滑块都由你在真实窗口里完成。
- 一个 profile 目录同一时间只能被一个 Chrome 实例占用（插件会先探测端口，不会硬起第二个）。
- 不做多账号并发抢端口：端口按店铺固定分配，冲突时报错而不是静默换端口。
- 只支持拼多多 / 淘宝 / 天猫 / 抖音 / 京东 / 1688 这六家（都是商家端）；加平台只需在
  `lib/platforms.mjs` 里补一条记录，再按「空档案登录页不误判」跑一遍 `node test/live-probe.mjs <新id>`。
