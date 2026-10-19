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

## 定时检测（排期）

列表上方有一条排期横幅：「每天 09:05 起 · 每组 2 个店铺，组间隔 30 分钟」，右边是 **调整排期**。
到点它会对店铺做一次**静默检测**（无头 Chrome 探一次、不弹窗），结果写回 `lastCheck`，
于是列表里的「登录状态」自己就跟着刷新 —— 不用人一个个点「检测」。规则：

- **每天从起始时间开始，把全部店铺排成一队**，每 `每组店铺数` 个一组，组与组之间隔 `组间隔` 分钟；
  同一组里的店铺共用同一个时间点（所以预览里会出现两行同一个时间）。
- **店铺自己的开关只管「到点跑不跑」，不影响它占的时间点**：暂停一家店不会让后面的店铺提前。
- **每组店铺数留空 = 自动**：内存 ≤16GB 为 1，>16GB 为 2（一次只起一只无头 Chrome，别把机器顶爆）。
- **错过不补跑**：只有到点后 2 分钟内才执行。机器睡了一觉、隔天才开，就跳过，不在半夜补一堆检测。
- **同一天同一个时间点只跑一次**（记账在 `config.schedule.lastSlots`，重启也不会重复）。
- 正在**等登录**、或者**浏览器正开着**的店铺直接跳过 —— 定时检测不打断你手里的活。
- 宿主每 20 秒看一次排期（`setInterval` + `unref`，不拖住宿主退出）；界面在排期开着时每 20 秒自己刷新一次。
- 检测失败也会记下来（`lastSchedError`），前端行内显示「上次失败」，悬停看原因。

## 更新插件（检测 / 一键更新）

「浏览器设置」面板里多了一张「版本与更新」卡片：

- **当前版本**：现在跑着的这份代码的版本号。
- **更新源目录**：本插件的 git 源码仓库（留空 = 自动猜：自己在 git 仓库里就用自己；否则看
  profile 的 `package.json` 里 `"dsh-plugin-shop-accounts": "file:D:/..."` 这类依赖反推）。
- **检测更新**：`git fetch` 后比较三样东西 —— 现在跑着的版本、源码仓库当前提交的版本、GitHub 上
  （`origin/main`）的版本；落后几个提交也会一并显示。只查询，不动任何文件。
- **更新到最新**：源码仓库 `git merge --ff-only origin/main`（有未提交改动会拒绝，不会替你提交），
  然后把 `lib/` `package.json` `README.md` `test/` 覆盖到 profile 里这份安装拷贝。
  **只有「检测更新」的结果里确实有新版本时这个按钮才可点**——没检测过、检测失败、已是最新，它都是灰的
  （要更新就一步一步来：先检测，确认有新东西，再点更新；不靠手滑）。

> **覆盖完要重启 DSH Desktop**：宿主启动时就把插件代码读进内存了，换文件不会热更新。
> 界面会在更新成功后提示「重启 DSH Desktop 生效」。

安全边界：只跑 `git -C <更新源目录> fetch/merge` 和文件拷贝，不执行任何远端代码；拖的是你自己的仓库。

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
lib/schedule.mjs    定时检测的排期算法（纯函数：分组、时间点、到点、下次、记账）
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

## 本机验证记录（2026-10-19 晚：判定措辞 / v0.3.3）

- 「未登录」是确定结论，但旧原因写的是「cookie 罐里还有 `PASS_ID`、`SUB_PASS_ID`，多半已失效」——
  前半句是观测，后半句是在猜「为什么罐里还有 cookie」，所以句尾带了个含糊的「多半」，后来还变成了一长串。
- 为了排除「无头模式被站点识别」这个可能，用**有头**窗口、正常 UA（`Chrome/155`，不是 `HeadlessChrome`）
  打开同一份拼多多档案重测：同样被按回 `https://mms.pinduoduo.com/login/?redirectUrl=...`，
  cookie 仍然 22 个、`judgeLogin` 输出一模一样 → 是站点真把这个会话作废了，与无头无关。
- 最终措辞按「这家店以前登录过没有」分两种，一句话说完（店铺名由界面自己加在前面）：
  - 登过、现在掉线 → **登录已失效，请重新登录**（状态列显示「登录已失效」）；
  - 从没登过 → **未登录，请前往登录页登录**（状态列显示「未登录」）。
  判据用 `account.lastLoginAt`，不用 cookie 罐里有没有残留 —— 新档案首次打开站点也可能种下 `mms_b84d1838` 这类 cookie。
- 真机验过两条分支：拼多多老档案 → `登录已失效，请重新登录`（2.7s）；另建一份空档案（无 `lastLoginAt`）
  → `未登录，请前往登录页登录`（3.1s），两者都被按回同一个登录页 URL。
- `test/smoke.mjs` 加断言钉住这两句话，并禁止「多半/也许/似乎/疑似/可能」这类猜测措辞。

## 本机验证记录（2026-10-19 晚：检测 / 一键更新 / v0.4.0）

- 新增「版本与更新」卡片：**检测更新**（`git fetch` 后比较跑着的版本 / 源码 HEAD / GitHub `origin/main`，
  显示落后几个提交）和 **更新到最新**（`merge --ff-only` + 覆盖 `lib/ package.json README.md test/`）。
- 本地三件套回归（`shop-accounts-diag/update-local.mjs`，bare 远端 ← 落后 1 提交的克隆 ← 更旧的安装拷贝，
  不联网不碰真目录）：检测 → `localVersion 0.9.0 / remoteVersion 1.1.0 / behind 1 / needsUpdate true`；
  更新 → `merged true / copied 2 / 安装拷贝 package.json 变 1.1.0 / lib 代码被覆盖 / restartRequired true`；
  再点一次 → `updated false, upToDate true`，不谎报需要重启；工作区有未提交改动 → 拒绝合并；17 项全过。
- 真机路径（`shop-accounts-diag/update.mjs`，打真实 `/update` 路由）：已装拷贝 0.3.3 → 检测出源码 0.4.0
  → 一键更新把 0.4.0 覆盖进 profile 副本 → 再检测 `upToDate`。
- smoke 补了 3 条：`/state` 带版本号、非 git 目录时如实报错（不联网瞎猜）、`syncFromSource` 覆盖与自踩保护 → 35 项全过。

## 本机验证记录（2026-10-19 晚：「更新到最新」按需变灰 / v0.4.1）

- 用户要求：更新按钮只在**检测出有新版本**时才能点。此前它只受「忙不忙」约束，没检测过也能按。
- 实现：`ConfigPanel` 里加 `var canApply = Boolean(updInfo && updInfo.ok !== false && updInfo.needsUpdate)`；
  「更新到最新」`disabled: Boolean(updBusy) || !canApply`；`runUpd()` 开头也自查同一条件（按钮灰着但函数还能被调的情况要堵住）；
  没检测过时多一行提示「先点『检测更新』…」，检测失败（`ok:false`）时同样灰。
- 更新成功后的返回里 `needsUpdate:false`，按钮随即自动变灰，不会让人重复按。
- `test/smoke.mjs` 补 1 条源码级断言（按钮可用性必须由 `needsUpdate` 决定、disabled 同时受 busy/canApply 约束、`runUpd` 里有函数内自查）→ 36 项全过。

## 本机验证记录（2026-10-19 晚：定时检测排期 / v0.5.0）

- 用户给了别家软件的截图（「账号管理 / 定时采集 / 调整排期」），要同样的能力：**定时任务，更新店铺状态**。
  本仓库里没有那套代码，按截图语义自己实现：定时 = 到点做一次静默检测，不采集商品、不打开窗口。
- 新增 `lib/schedule.mjs`：排期算法全在这里（纯函数、零依赖，时钟由调用方传入，所以能拿固定时间点断言）——
  `normalizeSchedule` / `planSchedule` / `dueRows` / `nextRun` / `markRan` / `groupSizeFor` / `resolveOrder`。
  组内共享时间点、暂停的店照样占位、错过 2 分钟不补跑、同一天同一点只跑一次，都由它保证。
- 宿主（`lib/index.js`）：`scheduleView()`（界面视图，带 `nextRunAt`/`autoGroupSize`/`memGB`）、
  `tickSchedule()`（**先记账再执行**，否则失败后每 20 秒重试会把无头 Chrome 起爆；`checkFn` 可注入给自检）、
  20 秒心跳（`setInterval` + `unref` + 卸载时 `clearInterval`）；路由 `GET/PUT /schedule`、
  `POST /schedule/preview`（只试算）、`POST /accounts/:id/schedule`（单店开关）；`/state` 里每行带
  `schedTime` / `schedEnabled` / `lastSchedAt` / `lastSchedError`。
- 界面（`lib/client.js`）：列表上方排期横幅（每天几点起、每组几个、间隔、下次时间、总开关状态）、
  「定时检测」列（行内 开启/暂停·时间点 + 详细配置）、「调整排期」弹窗（起始时间 / 组间隔 / 每组店铺数 /
  总开关 / 已排序预览 ↑↓ / 取消 / 保存排期）。预览一律问宿主，界面不自己算第二套时间。
- `test/smoke.mjs` 新增 9 条（排期算法 3 条 + 路由/preview/单店开关/`tickSchedule` 2 条 + 整页与弹窗渲染 1 条，
  其余是路径契约）→ **45 项全过**。渲染那条用桩 React 把整页跑一遍：喂一份假的 `/state`（带排期）验证
  横幅、定时检测列、上次失败标记都在；再把 `schedOpen` 喂 true，验证「调整排期」弹窗能渲染 —— 不靠浏览器就能挡住白屏。
- 真机自检（`shop-accounts-diag/schedule-check.mjs`，真路由 + 真 tick）：3 家店 → 保存 09:05/每组 2 →
  预览 07:00 不落盘 → 单店暂停后时间点不变 → **真 tick 起无头 Chrome 跑完 2 家店**，空档案如实报
  `evidence: login-page`（未登录），`lastCheckAt`/`lastSchedAt` 都写回，同一点再 tick 不重复，
  23:59 不补跑 → 25 项全过（本机 15.8GB → 自动每组 1 个）。

## 本机验证记录（2026-10-19 晚：拖拽排序 + 界面修正 / v0.5.1）

用户装 v0.5.0 后截图反馈三个问题：「做拖拽吧，而且上面的字都是看不清的，下面的表格样式也变了」。全部定位到真因，不是调参：

- **表格错位**：行里早就是 6 个格子（多了「定时检测」列），但 `.sa-rowhead,.sa-row` 的网格还是 5 列
  （`minmax(0,1.7fr) 54px minmax(86px,1fr) 60px 146px`）→ 第 6 格换行、整张表错位。
  改成 6 列 `minmax(120px,1.6fr) 54px minmax(96px,1fr) minmax(84px,1fr) 60px 132px` + `min-width:660px`（窄了横向滚）。
- **字看不清**：弹窗底色用的是 `--dsw-menu-surface-fill`，而 DSH 主题里它是**带 alpha 的菜单底色**
  （浅色 `#f8f9fa94` / 深色 `#43454a73`），弹窗半透明 → 底下列表文字透上来叠一起。
  改成实色的 `--dsw-alias-bg-base`，并留注释提醒别再换回去。
- **弹窗按钮被挤出视野**：`.sa-dialog` 原来是整体 `overflow:auto`。改成弹窗 `overflow:hidden` +
  正文 `.sa-dialog-body` 自己滚 + 底部按钮固定，窗口矮时「保存排期」也不会跑到看不见的地方。
- **预览列表被压成一条线**：`.sa-plist` 在弹窗 flex 列里被 `flex-shrink` 压到 4px（行全看不见）。
  给 `.sa-plist` / `.sa-scroll` 加 `flex:0 0 auto`，按内容长，太高自己滚。
- **拖拽排序**：排期预览每行可拖（HTML5 drag&drop，带 `⠿` 手柄、拖起来时目标行描边），
  ↑↓ 按钮当时保留当无障碍兜底（v0.5.2 已按用户要求删掉，见下节）；拖拽和箭头共用同一个 `reorder(from,to)`，不写两套顺序逻辑。
- **可视化验证**（新增 `shop-accounts-diag/preview.mjs`）：不开 DSH、不用真 Host，本地起个服务返回
  「桩 React + 真 client.js」，用挪到屏幕外的真实 Chrome 窗口（1280×900）渲染整页和弹窗，
  `Page.captureScreenshot` 存图 → 看图确认没重叠、6 列对齐、预览 3 行都在、手柄可见。
- `test/smoke.mjs` 加一条「样式契约」：6 列网格、弹窗不许用 menu-surface-fill、两个弹窗都有可滚正文、
  预览列表/滚动区不许被 flex 压扁、行上必须有 drag 事件与 `⠿` 手柄、拖拽与箭头共用 `reorder` → **46 项全过**。

## 本机验证记录（2026-10-19 晚：去掉 ↑↓、拖拽不透明 / v0.5.2）

用户看完 v0.5.1 的截图又提两点：「这个上下箭头去掉，拖动时是透明的，改成不透明的」。

- **去掉 ↑↓**：`.sa-pitem` 网格从 `16px 52px 56px 1fr auto 56px` 改为 `16px 52px 56px 1fr auto`，
  删掉 `.sa-pmove` 样式、`move(i, dir)` 函数和行内两个箭头按钮；排序只走拖拽，提示语也去掉「也可以用 ↑↓」。
- **拖动中的行不透明**：原来那行用 `opacity:.4` 表达，看着像整行被抠掉了。改成
  `opacity:1` + 实底 `color-mix(in srgb, #2f9e5f 16%, var(--dsw-alias-bg-base))` + 绿色内描边；
  落点那行用 `data-drag="2"` 的灰色描边。
- **干掉浏览器自带的半透明拖影**：`onDragStart` 里 `dataTransfer.setDragImage(1×1 空白 canvas, 0, 0)`。
  HTML5 拖拽时浏览器会在光标下方画一张半透明的行快照，用户看到的「透明」主要来自它，不设就治不好。
- 验证：`preview.mjs --dialog --drag` 用真 `DragEvent` + `DataTransfer`，第 1 行 dispatch dragstart、第 3 行 dragover，
  等 400ms（桩 React 异步重渲）再读属性 → `data-drag='1'` / `'2'`、`opacity:"1"`、
  底色 `color(srgb 0.86949 0.939137 0.899608)`（实色）、阴影含 `rgba(47,158,95,.75) inset`；
  截图 `shop-accounts-diag/ui-drag.png` 里箭头已消失、第 1 行绿色实底、第 3 行描边。
- `test/smoke.mjs` 样式契约加断言：不许再出现 `sa-pmove` / `'↑'` / `'↓'`；`data-drag="1"` 不许用半透明
  opacity（只能是 1）、必须有实底 background、必须调 `setDragImage` → **46 项全过**。

## 本机验证记录（2026-10-19 晚：窄窗口自适应 / v0.5.3）

用户装 v0.5.2 后截图问「怎么是这样的」：DSH 窗口窄（内容区 ~590px）时，表格右侧的「操作」列被顶到屏幕外，
搜索框和排期横幅也一起往右溢出，看着像整页错位。

- 真因：`.sa-rowhead,.sa-row` 写死 `min-width:660px`，6 列在窄面板里硬撑。`.sa-list` 虽然有 `overflow-x:auto`，
  但页面里其它块（横幅、搜索框、顶栏按钮）跟着这个宽度走，用户看到的是「整页往右跑」，而不是「表格自己能滚」。
- 修法：给 `.sa-list` 加 `container-type:inline-size`（顺带拿到 inline-size containment，内容再宽也撑不出页面横向滚动）；
  加 `@container (max-width:700px)`：网格换成 5 列
  `minmax(110px,1.7fr) 52px minmax(84px,1.1fr) minmax(74px,1fr) 122px` + `min-width:0`，
  隐藏「调试端口」列（`.sa-c-port`），端口改用 `.sa-port-inline` 并到店铺名下面那行（`· 端口 :9225`，不丢信息），
  平台标签加 `white-space:nowrap`（否则 52px 列会把「拼多多」拆成两行）。
- 可视化验证：`preview.mjs` 新增 `--width=` / `--height=`（默认 1280×900），590×660 与 460×660 各渲一遍，
  探针 `pageOverflowX` 都是 0；590 时六列自动变五列、操作按钮完整可见、弹窗也完整；
  1280 时仍是 6 列（含调试端口）。截图：`shop-accounts-diag/ui-narrow.png`、`ui-wide.png`、`ui-dialog-narrow.png`。
- `test/smoke.mjs` 样式契约加断言：`.sa-list` 必须有 `container-type:inline-size`、必须有 `@container (max-width:700px)`、
  窄态要隐藏 `.sa-c-port` 且端口信息要在 `.sa-port-inline` 里补回来 → **46 项全过**。

## 本机验证记录（2026-10-19 晚：小字对比度 + 居中 / v0.5.4）

用户看完 v0.5.3 的截图又提两点：「这个详细配置太奇怪，不居中」「灰色的字和背景太像了，看不清楚」。

- 不居中的真因：`.sa-schedcell` 是 `align-items:flex-start`，排期胶囊和它下面的「详细配置」各靠左，
  在 86px 的窄列里看着像错位。改成 `align-items:center`（探针实测：胶囊 250–325、链接 265–309，列中心 288，两者都居中）。
- 看不清的真因（这次有数字）：说明性小字全用 `--dsw-alias-label-caption`，而 DSH **浅色主题**里它是
  `#adb2b8`（neutral-bluish-400），对白底对比度只有 **2.0:1**（正文最低要求 4.5:1）。
  改用 `--dsw-alias-label-secondary`：浅色 `#61666b`（bluish-700）→ **5.8:1**，深色 `#cfd3d6`（bluish-300）→ **12.1:1**。
  影响 `.sa-sub` / `.sa-note` / `.sa-hint` / `.sa-rowhead` / `.sa-empty` / `.sa-dlabel` / `.sa-dmeta` / `.sa-handle`。
- 「详细配置」链接本身从 `opacity:.75` 提到 `.9`，保留下划线 + `text-underline-offset:2px`，一眼能看出可点。
- 验证工具升级：`preview.mjs` 加了**对比度探针**（读 `getComputedStyle().color`，向上找第一个不透明背景，
  按 WCAG 公式算 ratio）和 `--dark`（整套深色 token）。实测浅色 5.8:1 / 深色 12.1:1；
  截图 `ui-narrow.png`（浅色）与 `ui-dark.png`（深色）。
- `test/smoke.mjs` 样式契约加断言：代码里不许再出现 `--dsw-alias-label-caption`、必须有 `label-secondary`、
  `.sa-schedcell` 必须 `align-items:center` → **46 项全过**。

## 已知边界

- **不代登录、不破验证码**：扫码/短信/滑块都由你在真实窗口里完成。
- 一个 profile 目录同一时间只能被一个 Chrome 实例占用（插件会先探测端口，不会硬起第二个）。
- 不做多账号并发抢端口：端口按店铺固定分配，冲突时报错而不是静默换端口。
- 只支持拼多多 / 淘宝 / 天猫 / 抖音 / 京东 / 1688 这六家（都是商家端）；加平台只需在
  `lib/platforms.mjs` 里补一条记录，再按「空档案登录页不误判」跑一遍 `node test/live-probe.mjs <新id>`。
