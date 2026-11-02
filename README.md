# dsh-plugin-shop-accounts · 账号管理

> 把电商卖家后台的登录态集中管起来：**一个店铺 = 一份独立的登录档案（ego lite 的 profile，或 Chrome 的 user-data-dir）**。
> 登录一次就长期复用，上架脚本直接复用那份档案，不用重新登录。
>
> **自 v0.7.0 起支持 ego lite 后端**：检测到 ego lite 时优先使用（每店一个 profile + 一个 TaskSpace，无需手动创建实例）；
> 未安装时回退至 Chrome（每店一份档案 + 一个固定调试端口）。设置页可指定后端。详见[更新说明](#更新说明)。
>
> **自 v0.10.0 起支持 macOS**：密码改用**系统钥匙串**加密（Windows 是 DPAPI），浏览器从 `/Applications` 探测，
> 「在文件夹中显示」走 Finder。所有平台相关代码收在 `lib/platform/` 一处，业务代码不再判断操作系统。

DSH 插件，支持 **拼多多 / 淘宝 / 天猫 / 抖音（抖店）/ 京东（京麦）/ 1688** —— 全部是**商家端**（卖家后台），
另外支持给这些平台的 **C 端买家账号**建档（买家账号只做浏览/采集，不上架）。

- 版本：**0.10.1**（变更历史见 [CHANGELOG.md](CHANGELOG.md)）
- 自检：`node test/smoke.mjs` → 113 项、`node test/features-v090.mjs` → 30 项、
  `node test/features-v0101.mjs` → 15 项、`node test/platform.mjs` → 12 项全过
  （不启动浏览器、不碰真实账号；`npm test` 一次跑完）

---

## 目录

- [更新说明](#更新说明)
- [它能干什么](#它能干什么)
- [安装](#安装)
- [五分钟上手](#五分钟上手)
- [界面说明](#界面说明)
- [定时检测（排期）](#定时检测排期)
- [登录态怎么判](#登录态怎么判)
- [支持的平台](#支持的平台)
- [和上架流程怎么接](#和上架流程怎么接)
- [版本与更新](#版本与更新)
- [数据放在哪](#数据放在哪)
- [自检](#自检)
- [已知边界](#已知边界)

---

## 更新说明

### v0.9.0 – v0.10.1：存密码 / 账密登录 / 买家账号 / 数据采集 / macOS 适配 / 配置迁移

这一区间是按逆向 Accio Work「设置 → 账号管理」的结论补齐的能力（对照证据见 CHANGELOG 对应版本）：

- **密码库（v0.9.0）**：`<数据目录>/account-secrets.enc`，复用 cookie 罐那把主密钥 + AES-256-GCM。
  密码**不写进 `accounts.json`、不进 `/state`、不进日志**，账号表只有「已保存 / 更新时间」。
  没有可用密钥后端的平台（例如未适配的 Linux）**整库禁用，绝不退化成明文**。
- **账密登录（v0.9.2 起语义对齐 Accio）**：新建店铺时「登录账号」「登录密码」都是**必填**；
  点「打开店铺」就用保存的账密代填并提交，不需要再单独点「自动登录」按钮。
  代填结果会明确回报（成功 / 需要验证码 / 找不到输入框），验证码与短信仍需你手动完成。
- **卖家 / 买家账号（v0.9.0）**：`accountType` = `seller` / `buyer`，买家有独立登录入口；
  能力位区分「能否上架」「能否填店铺 URL」「能否采集」——买家账号不做上架。
- **数据采集（v0.9.0）**：只做**配置与调度**（选 5 个业务域、每天几点、最近 30 个完整自然日），
  真正的抓取交给 agent/skill —— 平台改版时只改 skill，不用改插件。
- **macOS 适配（v0.10.0）**：新增 `lib/platform/`，Windows 用 DPAPI + Program Files 探测 + PowerShell 进程匹配，
  macOS 用**钥匙串**（`/usr/bin/security`）+ `/Applications` 的 `.app` + `ps` 解析 + `open`。
  ⚠️ macOS 这一支**尚未真机验证**，验收清单见 CHANGELOG v0.10.0。
- **登录账号查重（v0.10.1）**：同平台 + 同登录账号（大小写、前后空格、Unicode 归一后比较）= 同一个人，
  新建和编辑都会被挡下（`ACCOUNT_LOGIN_NAME_DUPLICATE`）；跨平台同名正常允许。
  对齐 Accio「账号管理」的双唯一性校验 —— 重复记录会让「代填哪个密码、采集算谁的」对不上。
- **店铺配置导出 / 导入（v0.10.1）**：设置页「路径与高级选项 → 店铺配置迁移」，导出一个 JSON 带走
  平台 / 店名 / 登录账号 / 店铺 URL / 采集设置，换机器（尤其 Windows → mac）不用一条条重填。
  **只搬配置不搬秘密**：密码、登录态、档案路径、端口都不进包（密码与本机密钥绑定，搬过去也解不开）；
  导入逐条校验，坏数据跳过并说明原因，重复条目自动跳过（导两次不会翻倍）。

### v0.7.0 – v0.8.5：新增 ego lite 浏览器后端

本版本区间的主要变更为新增 ego lite 浏览器后端支持。未安装 ego lite 时，插件行为与 v0.6.10 保持一致，
继续使用 Chrome / CDP 后端。

- **账号隔离**：每个店铺对应 ego lite 中的一个 profile 与一个 TaskSpace。profile 为登录态隔离单位，
  TaskSpace 仅承载窗口；登录态保存在 ego lite 的 `User Data` 目录中，与用户在 ego 界面内建立的会话一致。
  上架脚本可通过接口字段 `egoProfile` 复用同一 profile，空间名可选。
- **后端选择**：设置页提供 `自动` / `ego lite` / `Chrome` 三种模式，默认 `自动`（检测到 ego lite 时优先使用）。
  状态胶囊显示当前生效后端与可用 profile 数量；Chrome 模式下不渲染 ego 相关字段。
- **后台检测**：ego lite 未运行时，检测以同一 `User Data` 目录启动无窗口实例（`--headless=new`），
  经 CDP `Network.getAllCookies` 读取 cookie 后立即关闭。实测耗时：淘宝 1697–2086 ms，拼多多 1627 ms；
  检测结束后无残留进程与窗口。ego lite 运行中时，改为在同一 profile 下创建临时 TaskSpace 读取，
  读取完成后销毁，不影响用户当前窗口。
- **进程控制**：所有 ego CLI 调用前先检测主进程状态；仅「打开店铺」「重扫」「启动 ego」允许拉起进程，
  其余操作在未运行时直接返回状态。由此避免了状态轮询触发的浏览器启动与历史标签页恢复。
- **控制权交还**：每次操作完成后调用 `handOff()`（失败重试 3 次），TaskSpace 控制权归还用户；
  关联上架插件在会话结束时同样交还。
- **profile 分配**：新建店铺时自动分配未被占用的 profile（优先非默认项）。ego 的 SDK 不支持新建 profile，
  可用 profile 耗尽时返回明确错误。
- **冲突处理**：ego 模式下店铺名即 TaskSpace 名，重名创建返回 400；重置登录态时按平台域名逐条删除 cookie，
  不再清空整个 cookie 库。
- **定时检测**：修复「已点完成」的店铺因 TaskSpace 存在而被持续跳过的问题（v0.8.0）；
  ego lite 未运行时不再跳过检测（v0.8.2）。
- **检测结果处理**：检测失败（进程未运行、CLI 超时、无窗口实例启动失败）时仅记录 `lastCheckError`，
  不覆盖上一次检测结论。
- **已知限制**：
  - ego lite 的 cookie 采用 Chromium 127+ App-Bound 加密，复制档案后无法解密（实测读取 0 个 cookie），
    因此仅支持复用原始档案；
  - 同一 `User Data` 目录同时仅允许一个实例（SingletonLock），插件已对相关调用做串行化处理。

### v0.8.3 – v0.8.4：安全加固

- 移除 CDP 的 `--remote-allow-origins=*` 参数（该参数会使任意网页在 DNS rebinding 之后读取全部登录态）；
- 递归删除、浏览器进程终止、端口归属判定与 cookie 读写，均限制为「该账号自身的档案与端口」；
- HTTP 接口增加访问控制：请求须携带自定义头，拒绝跨站请求，写操作须使用 `application/json`，
  `Host` 须为 IP 字面量或 localhost（用于防御 DNS rebinding）；
- 会话 cookie 备份改为加密存储（Windows DPAPI 保护主密钥 + AES-256-GCM）；
- 自更新仅部署经校验的上游 commit：工作区存在未提交改动时拒绝，无法取得版本号时拒绝，
  `git` 调用禁用 `ext::` 传输并覆盖 hooks 相关配置；
- 拼多多登录态判定收紧：须命中至少 2 个身份 cookie，且必须包含 `PASS_ID` 或 `SUB_PASS_ID`。

各项变更的原因与实测证据见 [CHANGELOG.md](CHANGELOG.md)。

### v0.8.5：设置页「路径与高级选项」排版调整

本版本仅调整排版，接口与逻辑未变更。

- 移除折叠块自身的底色、圆角与边框（该块位于「浏览器设置」卡片内，嵌套边框造成层级混淆），
  改为顶部分隔线与分组标题（标题右侧延伸细线至边界）；
- 标签列宽度 104 → 88 px 并改为顶部对齐，值列宽度 252 → 304 px；路径输入框补充 `title`，悬停可查看完整内容；
- 「Chrome / Edge」字段不再以独立一行显示探测结果（该行使行高由 28 px 增至 64 px，破坏行距一致性），
  探测结果改由占位符呈现；仅在未探测到浏览器时，于值列下方显示提示；
- 两个复选框与「信息」组的只读值纳入同一「左标签右内容」网格，左边缘与输入框对齐；
- 分组标题移除 `text-transform:uppercase`（该样式会将「Chrome 回退」渲染为「CHROME 回退」）。

---

## 它能干什么

| 能力 | 说明 |
| --- | --- |
| 一店一档案 | 每个店铺独立档案，互不串 cookie。ego 模式 = 一店一个 **profile** + 一个 **TaskSpace**；Chrome 模式 = 一店一个 `user-data-dir` + 一个 CDP 端口 |
| 浏览器后端可选 | **auto**（默认：装了 ego 就用 ego）/ **egolite**（只用 ego）/ **chrome**（只用 Chrome）；ego 优先是因为它本来就为「人 + Agent 共用」设计，登录态和窗口都在它里面 |
| 真实窗口登录 | 拉起的是**有头**浏览器，你正常扫码/密码/滑块；插件后台轮询，判成已登录后点「完成」，登录态留在档案里 |
| 静默检测 | 不惊动你地探一次登录态并写回。Chrome 用无头实例（约 2.6–3.1 秒/店）；ego 在店铺自己的 TaskSpace 里读 cookie（会短暂开一下那个空间） |
| 定时检测 | 每天定点把全部店铺排成一队依次体检，状态自己刷新，不用人一个个点 |
| 保活 | 判已登录后让页面多停留几秒再复查，把「活跃」做足（站点访问本身就会续期凭证） |
| 版本与更新 | 面板里检测 GitHub 新提交，一键快进合并 + 覆盖安装副本 |
| 多店铺管理 | 搜索、按平台筛选、详情页、单店暂停、拖拽排序排期 |

插件只负责**把登录态养在那里**：不碰商品、不提交、不改价。

## 安装

**前置**：DSH Desktop；本机有 **ego lite**（推荐，装了自动优先用），或 Chrome（没有则用 Edge 兜底）。

### A. 从源码目录装（开发时推荐）

```powershell
dsh plugin --profile <profile名> add file:D:\path\to\dsh-plugin-shop-accounts
```

### B. 手动装（GUI 里没有安装入口时）

1. 把整个目录复制到 `%DSH_HOME%\profiles\<profile名>\node_modules\dsh-plugin-shop-accounts\`；
2. 改 `%DSH_HOME%\profiles\<profile名>\package.json` 两处：
   - `dsh.profile.bundles` 数组里加 `"dsh-plugin-shop-accounts"`；
   - `dependencies` 里加 `"dsh-plugin-shop-accounts": "file:<本目录绝对路径>"`；
3. **重启 DSH Desktop**。

> `%DSH_HOME%` 默认是 `~/.dsh`。
> 插件是**启动时挂载**的：改宿主半身（`lib/index.js` 等）必须重启；只改客户端半身（`lib/client.js`）
> 刷新页面即可 —— 但两种都要先把文件同步进 profile 的 `node_modules` 副本。

装好之后，「设置」里会出现 **账号管理**。

## 五分钟上手

1. **设置 → 账号管理 → + 新增店铺**：选平台、填店铺名（备注可选；Chrome 模式下端口留空 = 自动分配）。
2. 点 **创建并去登录** → 弹出真实浏览器窗口（ego 模式下是这个店铺自己的 **TaskSpace**）。
3. 在里面登录到**卖家端**后台（各平台入口见[平台表](#支持的平台)）。
4. 回到 DSH，行内状态会自己变成「已登录」→ 点该行的 **完成并保存**（**ego 模式只存状态，那个 TaskSpace 留着不关** ——
   空间是独立窗口，不挡你正常用浏览器；Chrome 模式才会关掉窗口。登录态都已落在档案里，想收掉空间再点「关闭」）。
5. 之后这个店铺就一直显示登录态：行内给上架脚本用的两样东西 ——
   **ego 模式**是「profile + 空间名」，**Chrome 模式**是「调试端口 + 复制路径」。
6. （可选）点 **调整排期**，勾上「开启定时检测」，让插件每天自动体检一次。

> ego 模式用哪几个 profile？插件会**自动给每个店铺分一个没被占用的 profile**（优先非默认那个）；
> profile 用完了会明确报错，让你先在 ego 里新建一个「用户配置」—— ego 的 SDK 只能列出/使用已有 profile，不能新建。
> 想让两家店共用一个 profile 也可以（拼多多和抖音互不打架），但** cookie 域重叠的平台（淘宝/天猫/1688）必须分开**。

## 界面说明

### 列表页

```
[浏览器设置] [刷新] [+ 新增店铺]
┌ 每天 10:00 起 · 每组 1 个店铺，组间隔 30 分钟        [调整排期] ┐
│ 适用于全部店铺，含已暂停任务；错过时间不补跑。                  │
└──────────────────────────────────────────────────────────────┘
[全部 3] [拼多多 2] [淘宝 1] …
[搜索 店铺名、备注、平台或端口]
店铺名 | 平台 | 定时检测 | 登录状态 | 调试端口 | 操作
韩品兰坊  淘宝   开启·10:30   已登录    :9224    [检测] [管理]
```

- **登录状态**：`已登录` / `登录已失效`（以前登过、现在掉线 → 需重新登录）/ `未登录`（从没登过）/
  `未检测` / `运行中·待检测` / `等待登录`。下面一行是「检测于 …」。
- **定时检测**：行内胶囊 `开启·HH:MM` / `暂停·HH:MM`，点一下切换这家店跑不跑；下面的「详细配置」打开排期弹窗。
- **操作**：`检测`（静默复核）、`管理`（进详情页）、以及按状态出现的 `去登录` / `完成并保存`。

行内对话框里的其它动作：**打开**（把窗口重新拉到工作台）、**重扫**（清掉本地档案再打开登录页——
站点在档案里留着半死会话、登录页直接跳回后台时用）、**关闭**、**复制路径**、**编辑**、**删除**（可选连档案目录一起删）。

> 窗口**已经开着**的店铺点「去登录/重新登录」，会在**已有的浏览器里新开一个登录页标签页**，不会再拉第二只
> Chrome（Chrome 单实例：同档案再启一次只会把 URL 转给已有窗口；调试端口仍被老实例占着，强行再启会变「点了没反应」）。

### 店铺详情页（行内「管理」）

平台/店铺名（只读）· 店铺 URL（选填，填了就作为「打开」时的地址）· 账号 · 账号类型 · 登录状态、端口、
上次登录、**凭证到期**、保活停留。底部：`删除账号`、`重新登录/去登录`，以及
`检测登录态 / 打开工作台 / 重扫 / 复制档案路径 / 编辑店铺`。

### 浏览器设置

- **浏览器后端**：`自动`（默认，装了 ego lite 就用 ego）/ `只用 ego lite` / `只用 Chrome`。
  切完点「保存设置」立刻生效；下面那行会告诉你**当前实际用的是哪个**、探测到的 CLI 路径、以及 ego 里的 profile 列表。
- **ego-browser CLI**：留空 = 自动探测（`~/.local/share/ego/active_version_dir/ego-browser.exe`）；探测不到时手填。
- **Chrome 可执行文件**：留空 = 自动找 Chrome，没有就用 Edge。
- **启动 ego**（仅当 ego 没在运行时出现）：只把 ego 的主程序拉起来，**不碰任何 TaskSpace**。
- **刷新 ego**：重新读一遍 ego 的 profile / TaskSpace 列表（ego 没开着时读不到，会直接告诉你「没在运行」）。
- **路径与高级选项**（默认收起，v0.8.5 重排）：分三组 ——
  **路径**（ego-browser CLI / Chrome / Edge / 档案根目录）、
  **Chrome 回退**（起始端口、打开时顺带开商品列表页、关闭时先让浏览器自己退出）、
  **信息**（ego profile、数据目录）。少数人才改的东西都收在这里，设置页默认只留「后端 + 生效状态」。
- 以及 **版本与更新** 卡片。

> **插件不会为了「读一下状态」把 ego 整个拉起来。** 以前只要调一次 ego CLI，即便 ego 是关着的，
> 也会把它连同上次几十个标签一起恢复（实测 5.7 秒、3 GB）—— 现在所有 CLI 调用前都先问「ego 主程序在不在跑」：
> 没在跑就如实报 `running:false`，只有**你点「打开店铺」或「启动 ego」**才会拉起它。

## 定时检测（排期）

列表上方那条横幅就是排期：到点对店铺做一次**静默检测**（Chrome 后端拉无头实例、不弹窗；ego 后端在店铺自己的空间里只读 cookie），
结果写回，列表里的「登录状态」自己就跟着刷新。点 **调整排期** 设置：

| 字段 | 说明 |
| --- | --- |
| 每日起始时间 | 每天从几点开始跑 |
| 组间隔（分钟） | 组与组之间隔多久 |
| 每组店铺数 | 一组跑几个；**留空 = 自动**（内存 ≤16GB → 1，>16GB → 2） |
| 保活停留（秒） | 判已登录后多停几秒再复查，默认 8，0 = 检测完就关 |
| 开启定时检测 | 总开关（关着时横幅变灰、什么都不跑） |
| 排期预览 | 每个店铺的时间点，**按住 ⠿ 拖动**调整顺序 |

规则：

- **全店排成一队**：每 `每组店铺数` 个为一组，同一组共用同一个时间点，下一组 = 上一组 + `组间隔` 分钟。
- **单店开关只管「跑不跑」，不影响它占的时间点** —— 暂停一家不会让后面的店铺提前。
- **错过不补跑**：只有到点后 2 分钟内执行；机器睡了一觉、隔天才开就跳过，不在半夜补一堆检测。
- **同一天同一个时间点只跑一次**（记账在 `config.schedule.lastSlots`，重启 DSH 也不会重复）。
- **跳过两类店**：正在等你登录的（`pendingLogin`）、Chrome 后端里浏览器正开着的 —— 不打断你手里的活。
  ego 后端**不再因为「空间开着」跳过**（v0.8.0 起）：检测是在同一个 profile 下**另开一个临时空间**读 cookie，
  读完就收掉，全程不接管你那个窗口，所以「点过完成的店永远不再检测」这个老问题没有了。
  临时空间读不到（ego 没在跑）就跳过并记原因，**不会为了检测去启动 ego**。
- 宿主每 20 秒看一次排期；界面在排期开着时每 20 秒刷新一次。Chrome 模式一轮只起一只无头实例、串行跑；
  ego 模式在临时空间里读 cookie（约 2–3 秒，不开用户窗口）。同一家店的手动操作和定时检测**共用一把锁**，
  撞上时定时检测让路（记「正在手动操作」），不会出现两个 ego CLI 同时对同一空间 takeOver/finish。
- 检测失败记在 `lastSchedError`，行内显示「上次失败」，悬停看原因。

### 保活（尽量续期）

判定「已登录」之后不会立刻关浏览器，而是让页面**再留 `保活停留` 秒**再复查一次 —— 这期间页面自己的
心跳/XHR 会照常发出去，站点就把这次访问当活跃。实测（2026-10-19，拼多多真档案）：

| 时刻 | 读到的凭证到期时间 |
| --- | --- |
| 11:47:18 那次检测后 | `2027-01-27T03:47:18Z` |
| 18 秒后再检测一次 | `2027-01-27T03:47:36Z` |

也就是**每访问一次工作台，站点就把身份 cookie 重发一遍、到期时间重置成「当时 + 100 天」**。
所以「续签」不需要调什么刷新接口，定期访问本身就在续。

两条别被「到期时间」骗了的边界：

- **纸面到期 ≠ 会话可用**：掉线的店里 cookie 常常还躺着一整年（淘宝那家掉线时 `sgcookie` 还有一年），
  但服务端会话已经作废 —— 判登录态仍以「站点把不把按回登录页」为准。
- 保活只是把「活跃」做足，**不保证永不掉线**；掉了照样如实报「登录已失效，请重新登录」。

### 关窗之后登录态还在不在（会话级 cookie）

淘宝卖家登录靠的 `cookie2` / `_tb_token_` 是**会话级 cookie**（档案 cookie 库里 `is_persistent=0`），
Chrome 默认**关窗就丢**。这就是「登录完点保存 → 关窗 → 再打开又是登录页」的真因（v0.6.6 起修复）：

- 启动参数固定带 `--restore-last-session`：Chrome 才会把会话级 cookie 落盘、下次启动读回。
  实测（`shop-accounts-diag/session-cookie-plugin.mjs`，走插件自己的启动器）：不加 → 关窗就丢；加了 → 留得住。
- 这个开关会顺便恢复上次的标签页，所以静默检测改成「自己开一个干净标签 → 关掉其它页面目标 →
  只认这个标签页」，免得拿恢复出来的旧登录页当判定依据。
- 点「保存登录态」时，关窗之后还会**再复核一次**：复核不过就回 `saved:false` 并说明原因，
  不会再出现「提示保存成功、下一秒却是未登录」。
- 关窗**之前**还有一道门：按平台的身份 cookie（淘宝 = `unb` + `sgcookie`）逐个核对，
  缺就每秒重读、最长等 20 秒；等 5 秒还不齐会主动把窗口导回工作台催一次；等到超时仍不齐 →
  **不关窗**、回 `saved:false` 并直说要等多久（v0.6.7）。
  为什么要等：2026-10-19 抓到的真事 —— 工作台已经能看见店铺数据时，`unb` 可能还没种下来，
  这一点就点保存，关窗带走的是一个还没拿到身份的会话。

### cookie 罐本地备份（点窗口红叉也能救回来）

`--restore-last-session` 管得住「插件自己关窗」，管不住用户**直接点窗口红叉**：2026-10-19 的真机日志里，
那次关窗后档案从 86 个 cookie 掉到 42 个，`unb` 直接没了，下次启动就被按回登录页（v0.6.10 起兜底）。

- 只要浏览器里读到「已登录」，就把整罐 cookie 存一份到档案目录的 `dsh-session-cookies.json`
  （`<数据目录>/profiles/<账号>/dsh-session-cookies.json`，含会话级 cookie 的值。**v0.8.3 起加密**：
  AES-256-GCM，主密钥由 Windows DPAPI（CurrentUser）保护 —— 换 Windows 账号、把文件拷到别的机器都解不开）。
- 下次启动浏览器（静默检测、定时检测、点「打开」）时，先走 CDP `Network.setCookies` 把**档案里缺的那些**
  补回去，再打开页面。只补缺的、不覆盖已有的 —— 档案里已经有的同名 cookie 一定比备份新。
- 这个文件会被「清空档案（重扫）」一并删掉；不想留就手动删，删了不影响功能（只是少了这层兜底）。
- 验证：`shop-accounts-diag/cookie-backup.mjs` 8 项全过（存罐子 → 页面里把会话级 cookie 过期掉 →
  补罐子 → 会话级 cookie 回来且页面认；档案里的新值不会被旧备份盖掉）。

## 登录态怎么判

1. **登录页最硬**：站点把你按回登录页 = 站点不认这个会话，哪怕 cookie 罐里还留着身份 cookie
   （服务端过期不会去清浏览器里的 cookie）也判未登录。文案按「这家店以前登过没有」分两种：
   登过 → **登录已失效，请重新登录**；从没登过 → **未登录，请前往登录页登录**。
2. **身份 cookie**：域名对得上 + 名字命中该平台的身份 cookie + 值不是占位符。匿名 cookie
   （`cna`、`_m_h5_tk`、`sdtoken`…）人人都有，**不算**凭证。淘宝/天猫要求必须命中 `unb` / `sgcookie`
   （空档案停在千牛登录页时罐里就已经有 `cookie2`/`_tb_token_`）；1688 的 `__cn_logon__` 未登录时值是
   `false`，所以卡值 —— 只有 `=true` 才算数。
3. **URL 弱判据**：只有 CDP 读 cookie 失败时才退到它，并如实标成 `evidence: 'url'`（界面上与「确定」区分）。

### 静默检测为什么要「等导航稳」

浏览器没开时检测会用无头 Chrome 打开同一份档案探一次。这里有坑（v0.3.0 的真 bug，v0.3.1 修）：

把工作台 URL 当启动参数丢给 Chrome，页面目标**一上来**就停在工作台 URL 上（+377ms 就能看到，CDP +358ms 起来），
而站点甩到登录页是 +632ms 的事。旧实现「看到平台域名就算稳」→ 判的是工作台 URL + 罐里还没被清掉的
`PASS_ID`/`SUB_PASS_ID` → **掉线了也报「已登录」**；开着窗口时靠实时读 URL 还能发现，关着窗口就永远发现不了。

现在 `settlePage()` 只认「导航真正结束」：`document.readyState === 'complete'` 且 URL 连续 1.5s 不变
（资源一直不结束的站点，URL 稳定 4s 也认；总上限 12s），判据用的就是等稳后的那个 URL。
`test/live-probe.mjs` 用本地页复现了同一时序（先渲染"工作台"，400ms 后 JS 跳 `/login`）把这条回归钉住。

## 支持的平台

| 平台 | 登录页（新增店铺时打开） | 「打开」落到的工作台 | 登录态认哪个 cookie |
| --- | --- | --- | --- |
| 拼多多 | `mms.pinduoduo.com/login` | 商家后台 / 商品列表 | 至少命中 2 个：`PASS_ID` / `SUB_PASS_ID` / `mms_b84d1838`，且必须有 `PASS_ID` 或 `SUB_PASS_ID`（v0.8.3 起） |
| 淘宝 | `loginmyseller.taobao.com`（千牛） | `qn.taobao.com/home.htm` | `unb` / `sgcookie`（必须命中其一） |
| 天猫 | `loginmyseller.taobao.com`（千牛） | `myseller.taobao.com/home.htm` | 同淘宝（一套账号体系） |
| 抖音 | 抖店 `fxg.jinritemai.com/login/common` | `fxg.jinritemai.com/ffa/mshop/homepage/index` | `passport_assist_user` / `sessionid` / `sessionid_ss` / `passport_uid` |
| 京东 | 京麦 `passport.shop.jd.com/login/index.action` | `jm.jd.com/index/index.html` | `pt_key` / `pt_pin` |
| 1688 | `login.1688.com/member/signin.htm` | `work.1688.com/home/page/index.htm` | `_nk_` / `__cn_logon__=true` |

加平台只需在 `lib/platforms.mjs` 里补一条记录，再跑 `node test/live-probe.mjs <新id>` 确认空档案登录页
不会被误判成「已登录」。

## 和上架流程怎么接

上架脚本（例如拼多多发品流程）复用某个账号时，要看后端：

**ego 模式（推荐）—— 传 profile，空间名可选**

- 该店的 **profileId**：行内/详情页显示的那个 `Profile N`，接口里是 `egoProfile` 字段；
  也可以让 Agent 直接查：`shop_accounts` 工具的 list 输出里就带 `egoProfile` / `egoSpace`。
- 上架脚本用同一个 profile 打开它自己的 TaskSpace，**登录态就是通的**（cookie 存在 profile 级，
  空间只是窗口）。拼多多插件的写法：
  ```powershell
  scripts\ego_launch.ps1 -Shop 店铺A -Profile "Profile 3" -Space "店铺-店铺A"
  ```
- 空间名传一致的话，你会在 ego 里看到**同一个窗口**；不传也行（脚本会自己开 `pdd-店铺A`），
  只要 profile 对，登录态照样在。

**Chrome 模式 —— 端口 + 档案路径**

- **调试端口**：行内「调试端口」列显示的那个（脚本侧就是 `PDD_PORT` 之类）；
- **浏览器档案**：行内「复制路径」复制到的目录（脚本侧 `-Profile <档案目录>` 或 `chrome_profile`）。

行内显示 **CDP 可用** 说明这家店浏览器正开着 —— Chrome 模式下上架脚本直接连这个端口，**不要再另起一个 Chrome**
（同一份档案被两个实例抢会报错，也不符合「复用已登录 profile」的要求）。ego 模式没有 CDP 端口（ego 不对外开），
上架脚本走 ego 自己的 SDK。

## 版本与更新

「浏览器设置」里的 **版本与更新** 卡片：

- **当前版本**：现在跑着的这份代码的版本号。
- **更新源目录**：本插件的 git 源码仓库（留空 = 自动猜：自己在 git 仓库里就用自己；否则从 profile 的
  `package.json` 里 `"dsh-plugin-shop-accounts": "file:D:/..."` 反推）。
- **检测更新**：`git fetch` 后比较三样 —— 跑着的版本 / 源码仓库当前提交的版本 / GitHub `origin/main` 的版本，
  落后几个提交也会显示。只查询，不动文件。
- **更新到最新**：`git merge --ff-only origin/main`（有未提交改动会拒绝，不替你提交），再把
  `lib/ package.json README.md test/` 覆盖到 profile 里的安装副本。
  **只有检测出确实有新版本时才可点** —— 没检测过、检测失败、已是最新，它都是灰的。

> 覆盖完**必须重启 DSH Desktop**：宿主启动时就把插件代码读进内存了，换文件不会热更新。

安全边界：只跑 `git -C <更新源目录> fetch/merge` 和本地文件拷贝，不执行任何远端代码。

## 数据放在哪

| 东西 | 位置 |
| --- | --- |
| 店铺清单 / 配置 | `%DSH_HOME%\shop-accounts\accounts.json`、`config.json` |
| 运行期登记（哪个端口起的浏览器） | `%DSH_HOME%\shop-accounts\runtime.json` |
| 登录态（Chrome 模式） | 每店一份 `user-data-dir`：`%DSH_HOME%\shop-accounts\profiles\<账号id>\` |
| 登录态（ego 模式） | 在 **ego 自己的** `User Data` 里，按 `accounts.json` 里记的 `egoProfile` 对应；本插件不复制、不挪动 |
| 会话 cookie 备份（加密） | `<数据目录>/profiles/<账号id>/dsh-session-cookies.json`：AES-256-GCM，主密钥由**系统密钥后端**保护（Windows DPAPI / macOS 钥匙串） |
| 密码库（v0.9 起） | `<数据目录>/account-secrets.enc`：同一把主密钥 + AES-256-GCM；密钥后端不可用时**整库禁用**（不存明文） |
| 调试端口 | Chrome 模式：从 `portBase`（默认 9222）起自动找空位，一店一端口；ego 模式没有端口 |

整个数据目录可以用环境变量 `DSH_SHOP_ACCOUNTS_DIR` 搬走。

### 目录结构

```
lib/platforms.mjs   六个平台的登录页/主页/工作页、身份 cookie、域判据、判登录态（含卖家/买家变体）
lib/platform/       平台适配层（v0.10.0）：win32 / darwin / unsupported + 统一入口
                    —— 密钥后端、浏览器路径、进程匹配、打开目录、ego 路径都在这里
lib/cdp.mjs         极简 CDP 客户端（裸 WebSocket，无第三方依赖）
lib/chrome.mjs      找浏览器、选端口、拉起/关闭/探测（路径与进程操作交给平台层）
lib/ego.mjs          ego lite 后端（探测 CLI、在 ego 运行时里跑脚本、TaskSpace/profile、读 cookie）
lib/secret.mjs      cookie 备份加密（平台密钥后端保护主密钥 + AES-256-GCM；不可用时退明文并标注）
lib/vault.mjs       店铺账号密码库（v0.9.0；密钥后端不可用时整库禁用，绝不退明文）
lib/autologin.mjs   账密代填（按平台选择器 + cookie 判据复核；验证码交回用户）
lib/collection.mjs  数据采集的配置与调度（真抓取交给 agent/skill）
lib/store.mjs       accounts.json / config.json / runtime.json 的原子读写与降级
lib/schedule.mjs    排期算法（纯函数：分组、时间点、到点、下次、记账）
lib/index.js        宿主：/shop-accounts/* 路由、自更新、定时心跳
lib/client.js       客户端 bundle：设置页「账号管理」整页 UI
cordis.patch.yml    插件挂载点（id: shop-accounts）
test/smoke.mjs      主自检（零依赖、不启动浏览器）
test/features-v090.mjs  v0.9 功能自检（密码库 / 采集 / 账号类型 / 新路由）
test/features-v0101.mjs v0.10.1 自检（登录账号查重 / 店铺配置导出导入）
test/platform.mjs   平台层自检（v0.10.0；含把 mac 分支在 Windows 上能验的都验掉）
test/live-probe.mjs 真机链路探针（会拉起一个无头 Chrome，临时档案）
```

## 平台支持（v0.10.0）

Windows 与 macOS 共用一套代码，差异全在 `lib/platform/`：

| 能力 | Windows | macOS |
| --- | --- | --- |
| 主密钥保护（cookie + 密码） | DPAPI（CurrentUser，经 PowerShell） | **登录钥匙串**（`/usr/bin/security`）；文件里只存 `keychain:<service>` 标记 |
| 浏览器可执行文件 | `Program Files` / `LOCALAPPDATA` 下的 `chrome.exe`、`msedge.exe` | `/Applications/<App>.app/Contents/MacOS/<bin>`（Chrome / Edge / Chromium / Brave，也看 `~/Applications`） |
| 进程按 `--user-data-dir` 精确匹配 | `Get-CimInstance Win32_Process` + 等值比较 | `ps -axo pid=,command=` + 等值比较（`normDir` 归一化） |
| 杀进程树 | `taskkill /PID … /T /F` | `pkill -9 -P` + `kill -9` |
| 「在文件夹中显示」 | `explorer.exe` | `open` |
| ego lite 路径 | 官方安装器的默认位置 | **按 macOS 约定猜的，未真机验证** —— 找不到就回退 Chrome 后端 |
| 无密钥后端的平台（Linux 等） | — | — | 明确不可用：密码库禁用、不存明文 |

> ⚠️ **macOS 这一支还没在真机上跑过**（开发机是 Windows）。验收清单见
> [CHANGELOG v0.10.0](CHANGELOG.md)；能脱离真机验证的部分（路径表、`ps` 解析、钥匙串命名与标记格式、
> 白名单、业务代码里没有平台硬编码）都在 `test/platform.mjs` 里。

## 自检

```powershell
node test/smoke.mjs            # 113 项：平台判据 / 持久化 / 宿主 HTTP 面 / 排期 / ego 后端 / 客户端契约 / 安全边界
node test/features-v090.mjs    # 30 项：账号类型 / 密码库 / 账密代填 / 采集配置与调度 / 新路由
node test/features-v0101.mjs   # 15 项：登录账号查重 / 店铺配置导出导入（含坏数据与重复导入）
node test/platform.mjs         # 12 项：平台适配层契约 + macOS 分支（能在 Windows 上验的部分）
node test/live-probe.mjs pdd   # 真机链路：临时档案拉一个无头 Chrome，读 cookie 再关掉 + 「慢跳转」回归
node test/live-probe.mjs all   # 六个平台都过一遍（建议一个一个跑，共用档案会串 cookie）
```

`npm test` 一次跑完前四套（零依赖、不碰真实账号、不启动浏览器）。

`smoke.mjs` 用 `DSH_SHOP_ACCOUNTS_DIR` 把数据目录指到临时目录，**不碰真实账号、不启动任何浏览器**。
`live-probe.mjs` 会真的拉起无头 Chrome（临时档案、不弹窗口、不碰店铺档案），验证
「启动 → 调试端口 → `Network.getAllCookies`（HttpOnly 的唯一正路）→ 正常关闭」这条链路。

## 已知边界

- **不代登录、不破验证码**：扫码/短信/滑块都由你在真实窗口里完成。
- **ego 的 SDK 不能新建 profile**：只能列出/使用已有的。profile 用完了要你先在 ego 里建一个「用户配置」。
- Chrome 模式：一份 profile 同一时间只能被一个 Chrome 实例占用（插件先探测端口，不会硬起第二个）。
- ego 模式：ego **不对外开 CDP 端口**，所以上架脚本不能 `connectOverCDP`，只能走 ego 自己的 SDK（`ego-browser nodejs`）。
- 不做多账号并发抢端口：端口按店铺固定分配，冲突时报错而不是静默换端口。
- 只支持上面六家平台（都是商家端）；上架/发品页等有真实账号登录后再钉准，**不猜地址**。
- **ego 的控制权是「借用」的**：插件每次操作完都会把窗口控制权交还给你（`task.handOff()`，失败会重试 3 次），
  所以 ego 里不会一直显示「agent 调试中」；而**检测根本不需要借** —— 它在同一个 profile 下另开一个临时空间读 cookie，
  读完就收，全程不碰你那个窗口（v0.8.0 起；旧版本是 takeOver 你的窗口再还，会打断你打字）。
- **ego 关着也能检测（v0.8.2 起）**：检测时插件会**在后台起一个无窗口的 ego 实例**（`--headless=new`，
  同一份 User Data、该店铺的 profile），通过 CDP 读 cookie 后立刻关掉 —— 不弹窗、不恢复上次的窗口，
  实测约 1.6~2.1 秒、读完 0 残留进程。所以"检测/定时检测"不需要你先把 ego 打开。
  但**「打开店铺」仍然会拉起 ego 主程序**（那本来就是要开窗口），拉起时 ego 会恢复它上次的窗口 —— 这是 ego 自己的行为。
- **ego 模式检测不弹检测窗口**：ego 关着时走上面的无窗口实例（完全不可见）；ego 开着时在同一个 profile 下另开一个临时空间读 cookie，
  会短暂多出一个空间标签（约 2–3 秒后自动收掉）。
  ⚠️ 唯一的小概率冲突：如果**恰好在检测的那 1~2 秒里你手动点开了 ego**，Chrome 的单实例机制可能把你的启动合并进那个隐藏实例、导致窗口没出来；
  再点一次即可。这是"共用同一份档案"的代价（ego 的 cookie 是 App-Bound 加密，复制档案解不出来，实测 0 个 cookie）。
- **ego 的 profile 不能新建**：SDK 只能列出/使用已有 profile；用完了会明确报错。
- **ego 重启后会话级 cookie 是否还在，没验证过**：Chrome 有 cookie 罐本地备份可以救「点红叉关窗」，
  ego 没有同类备份（它把登录态存在 profile 里，正常退出应当落盘）。这条留作已知边界。
- **ego 的 profile 不能新建**：SDK 只能列出/使用已有 profile；用完了会明确报错。
- **重名店铺在 ego 模式下会被挡**：店铺名就是 TaskSpace 名（`店铺-<名字>`），重名会让两家店共用一个空间、登录态串台。
- 定时检测排期跑在 DSH 宿主进程里：DSH 可以最小化，但**退出 DSH 就不跑了**。
- 无头检测（Chrome 模式）的 UA 是 `HeadlessChrome`，理论上会被站点识别（目前六家实测正常）；真要绕再单独改。

## 安全边界（v0.8.3 起，v0.8.4 加强）

这几条是故意做死的，改代码时别拆：

- **HTTP 面只给本插件界面用**：所有 `/shop-accounts/*` 路由要求自定义头 `x-dsh-shop-accounts: 1`
  （跨站要带它必先过 CORS 预检，而本服务从不回 ACAO），拒绝跨站 `Sec-Fetch-Site`，写请求必须是
  `application/json`；另外要求 `Host` 是 **IP 字面量或 localhost**（反 DNS rebinding：rebinding 之后
  浏览器发来的 Host 是攻击者域名）。所以「任意网页/局域网页面触发 reset、改配置、跑更新」这条路是关的。
  （宿主 Desktop 另外还有 renderer token 门禁，插件不依赖它。）
- **调试端口不对网页开放**：启动 Chrome/ego 时**不带** `--remote-allow-origins=*`。Chrome 只对带了
  `Origin` 头的 CDP 连接做 allowlist 校验，而 Node 的 WebSocket 不发 Origin —— 不开这个开关照样能读 cookie，
  开了就等于让任意网页在 DNS rebinding 之后读走全部登录态。实测 Chrome 156 可用。
- **递归删除只认一种形状**：`<档案根目录>/<账号 id>`（`deletableProfileDir()`）。只判"在根目录下"不够 ——
  `profileRoot` 本身可被设置改，所以还要求目录名正好是账号 id；**导入的目录永远不会被插件递归删除**。
  路径判定两边都走 `realpath`，junction / 8.3 短名不能在词法上骗过它。
- **强杀浏览器按 `--user-data-dir` 精确匹配**：不是"命令行包含这个子串"（否则 profileDir 是
  `C:\Program Files` 时会把全机浏览器杀掉）。
- **端口归属只认「自己的」**：读/写 cookie、`Browser.close`、cookie 备份之前都要确认端口属于这个店铺
  （运行期登记表 8 小时内 + pid 存活，或进程命令行里的 `--user-data-dir`）；查不到就不读不写。
  CDP WebSocket 必须是 127.0.0.1 且端口一致。
- **自更新只部署校验过的 commit**：先无条件 `git status --porcelain`（脏工作区一律拒绝），再用
  `git archive <上游 commit>` 的内容落地（不是拷工作区），且**必须**取到并匹配版本号（取不到就拒绝）；
  `git` 调用一律禁用 `ext::` 传输、覆盖 `core.fsmonitor` / `core.sshCommand` / `core.hooksPath`
  （防 `.git/config` 挂命令）。
- **cookie 落盘是加密的**：`dsh-session-cookies.json` 用 AES-256-GCM 加密，主密钥由 **Windows DPAPI
  （CurrentUser）** 保护 —— 换 Windows 账号或把文件拷到别的机器都解不开。文件里只保留该店铺平台域下的
  cookie，且只有"档案根目录内"的账号才有备份（导入目录不写）。
- **配置里的路径都要过校验**：`profileRoot` 不能是盘根/家目录/系统或程序目录；`browserPath`/`egoliteCli`/
  `egoliteApp` 必须存在且文件名像对应程序；`updateDir` 必须是绝对路径。

## 许可

[MIT](LICENSE)
