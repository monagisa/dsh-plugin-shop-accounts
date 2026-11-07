<div align="center">

# dsh-plugin-shop-accounts

**把六家电商后台的登录态集中管起来：登录一次、长期复用、定时检测、掉线自动代填。**

为 DSH Desktop 提供的账号管理插件。一个店铺对应一份独立登录档案，上架脚本与采集脚本直接复用同一份登录态，无需重复登录。

[![version](https://img.shields.io/github/package-json/v/monagisa/dsh-plugin-shop-accounts?style=flat-square)](https://github.com/monagisa/dsh-plugin-shop-accounts)
[![license](https://img.shields.io/github/license/monagisa/dsh-plugin-shop-accounts?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0078D6?style=flat-square)]()

[功能特性](#功能特性) · [支持平台](#支持的平台) · [安装](#安装) · [快速开始](#快速开始) · [数据存放](#数据存放位置) · [安全机制](#安全机制) · [更新日志](CHANGELOG.md)

</div>

---

## 为什么需要它

电商后台的登录态是自动化流程里最容易失效的一环：

- 同一台机器要同时管理多家店铺，不同平台的 cookie 互相覆盖，浏览器窗口相互抢占；
- 淘宝系的 `cookie2` / `_tb_token_` 属于会话级 cookie，关闭窗口即丢弃，下次打开又是登录页；
- 会话过期后需要人工扫码或收验证码，上架、采集、报表任务全部卡在登录这一步；
- 上架与采集脚本各自维护登录态，每接一个新平台就要重新登录一次。

本插件的职责是**只维护登录态**：一个店铺一份独立档案，登录一次后由插件负责检测、续期与自动代填；脚本侧只需读取档案信息（ego 的 profile，或 Chrome 的调试端口）即可复用。插件不上架、不改价、不提交订单。

---

## 功能特性

### 登录态管理

| 能力 | 说明 |
| --- | --- |
| 一店一档案 | 每个店铺独立档案，cookie 互不共享。ego 后端为一店一个 profile 与一个 TaskSpace；Chrome 后端为一店一个 `user-data-dir` 与一个固定调试端口 |
| 真实窗口登录 | 启动有头浏览器，扫码、密码、滑块均在真实窗口中由使用者完成；插件后台轮询登录态，判定成功后点击「完成」将登录态写入档案 |
| 静默检测 | 不干扰窗口的情况下探测登录态并回写。Chrome 后端使用无头实例（约 2.6–3.1 秒/店）；ego 后端在同一 profile 下另开临时空间只读 cookie 后立即关闭 |
| 掉线自动代填 | 保存过密码且登录方式为「账号密码代填」时，打开店铺或定时检测发现登录页即自动填表并提交，失败原因分类回显（账号密码错误会暂停该店铺的自动重试） |
| 登录方式可选 | 建号时选择「账号密码代填」或「扫码 / 手动登录」；后者不保存密码，打开窗口后手动登录一次，登录态留在本机档案 |
| 保活续期 | 判定为已登录后让页面多停留数秒再复查，站点访问本身即会续期凭证；实测每次访问工作台会将身份 cookie 的到期时间重置为访问时刻加 100 天 |
| 会话 cookie 备份 | 读到已登录即把整份 cookie（含会话级）加密备份到档案目录，下次启动时经 CDP 补回档案中缺失的项 |
| 登录态判定 | 以「站点是否重定向至登录页」为第一依据，身份 cookie 为第二依据，URL 为最后弱判据；判定结果与依据均在界面中区分显示 |

### 浏览器后端

| 后端 | 适用场景 | 档案形态 |
| --- | --- | --- |
| **ego lite**（推荐） | 已安装 ego lite 时自动优先使用；面向「人工与 Agent 共用窗口」设计，登录态与窗口由 ego 管理 | 一店一个「用户配置」与一个 TaskSpace；同一份用户配置可由不同平台的店铺共用，同一平台同一身份的第二家店必须分开；默认配置留给使用者自己 |
| **Chrome** | 未安装 ego lite 时的回退方案，或店铺数量超过 ego 用户配置数量时使用 | 一店一份 `user-data-dir` 与一个 CDP 调试端口，档案可自动创建、数量不限 |
| 自动（默认） | 安装 ego lite 时走 ego，否则回退 Chrome | — |

后端可在设置页指定为「自动 / ego lite / Chrome」，切换后立即生效。

### 定时任务

按排期对全部店铺依次执行，默认执行定时采集，也可配置为仅检测登录态；失败原因写回店铺记录并在列表中提示。

- 分组排期：每组店铺共用同一时间点，组间隔可调；每组店铺数留空表示自动（内存 ≤16GB 为 1，>16GB 为 2）。
- 错过不补跑：仅在到点后 2 分钟内执行，休眠或隔天启动时跳过；同一天同一时间点只执行一次。
- 跳过待登录与手动操作中的店铺：等待登录中的店铺不参与；同一店铺的手动操作与定时任务共用一把锁，冲突时任务让路。
- 后台静默：宿主每 20 秒检查一次排期，不弹窗、不打断正在进行的窗口操作。

### 数据采集

| 能力 | 说明 |
| --- | --- |
| 采集域与指标目录 | 内置「平台 → 采集域 → 指标」目录（3045 条指标），建号时勾选采集域，插件按日期区间规划任务 |
| 声明式采集配方 | 采集动作由配方（DSL）描述并编译为操作序列，内置配方覆盖经营总览、流量、交易、收支等常用报表；也可通过 `SHOP_ACCOUNTS_DSL_DIR` 指向外部配方库 |
| 数据层 | 采集结果按店铺落盘为 JSONL，带覆盖台账、导入记录与缺口规划；支持查询、导入、导出 CSV |
| 后处理能力 | 页面数字按字形还原（应对字体反爬）、页面文字按指标映射、下载型配方产物归集 |
| 仅卖家账号 | 采集读的是商家后台报表页面，买家账号不参与采集（详见下文「账号身份」） |

内置配方：

| 平台 | 配方 |
| --- | --- |
| 淘宝 / 天猫 | `tb_shop_overview`、`tmall_shop_overview` |
| 京东 | `jd_shop_overview`、`jd_traffic_overview` |
| 抖音（抖店） | `douyin_shop_transaction`、`douyin_shop_income_expense` |
| 拼多多 | `pdd_shop_overview` |

### 账号身份

| 平台 | 卖家（商家后台） | 买家（C 端） |
| --- | --- | --- |
| 拼多多 | 支持 | 不提供买家入口 |
| 淘宝 / 天猫 | 支持 | 支持（账号密码登录，可保存密码与代填） |
| 京东 | 支持 | 支持（账号密码登录） |
| 1688 | 支持 | 支持（账号密码登录） |
| 抖音（抖店） | 支持 | 支持，但只有扫码与手机验证码登录，不保存密码 |

买家账号只用于建档与浏览，**买家账号不做数据采集**：采集读的是商家后台报表页面，C 端没有这些页面，采集接口对买家账号直接拒绝，定时任务对买家只做登录检测。

### 跨平台

Windows 与 macOS 共用同一套代码，平台差异集中在 `lib/platform/`（主密钥保护、浏览器可执行文件探测、按 `--user-data-dir` 匹配进程、终止进程树、在文件管理器中显示、ego 路径）。密钥后端在 Windows 使用 DPAPI，在 macOS 使用登录钥匙串；缺少密钥后端的平台会禁用密码库并给出明确提示，不保存明文。

### 界面

设置页内的独立面板，包含店铺列表、店铺详情与浏览器设置三部分；列表页支持搜索、按平台筛选、详情页、单店暂停与拖拽调整排期顺序。

---

## 支持的平台

| 平台 | 登录页（新增店铺时打开） | 「打开」进入的工作台 | 登录态判定的身份 cookie |
| --- | --- | --- | --- |
| 拼多多 | `mms.pinduoduo.com/login` | 商家后台 / 商品列表 | 至少命中 2 个：`PASS_ID` / `SUB_PASS_ID` / `mms_b84d1838`，且必须包含 `PASS_ID` 或 `SUB_PASS_ID` |
| 淘宝 | `loginmyseller.taobao.com`（千牛） | `qn.taobao.com/home.htm` | `unb` / `sgcookie`（必须命中其一） |
| 天猫 | `loginmyseller.taobao.com`（千牛） | `myseller.taobao.com/home.htm` | 同淘宝（同一套账号体系） |
| 抖音（抖店） | `fxg.jinritemai.com/login/common` | `fxg.jinritemai.com/ffa/mshop/homepage/index` | `passport_assist_user` / `sessionid` / `sessionid_ss` / `passport_uid` |
| 京东 | 京麦 `passport.shop.jd.com/login/index.action` | `jm.jd.com/index/index.html` | `pt_key` / `pt_pin` |
| 1688 | `login.1688.com/member/signin.htm` | `work.1688.com/home/page/index.htm` | `_nk_` / `__cn_logon__=true` |

新增平台只需在 `lib/platforms.mjs` 中补充一条记录，再执行 `node test/live-probe.mjs <新 id>`，确认空档案登录页不会被误判为已登录。

账号身份按平台真实能力划分：上表为卖家入口；买家入口为淘宝 / 天猫 / 京东 / 1688 / 抖音（抖音只有扫码与手机验证码），拼多多不提供买家身份。

---

## 安装

**前置条件**：DSH Desktop；本机安装 ego lite（推荐）或 Chrome（未安装 Chrome 时回退 Edge）。

### 从源码目录安装

```powershell
dsh plugin --profile <profile 名> add file:<本目录绝对路径>
```

### 手动安装

1. 将整个目录复制到 `%DSH_HOME%\profiles\<profile 名>\node_modules\dsh-plugin-shop-accounts\`；
2. 修改 `%DSH_HOME%\profiles\<profile 名>\package.json` 两处：
   - `dsh.profile.bundles` 数组中加入 `"dsh-plugin-shop-accounts"`；
   - `dependencies` 中加入 `"dsh-plugin-shop-accounts": "file:<本目录绝对路径>"`；
3. 重启 DSH Desktop。

`%DSH_HOME%` 默认为 `~/.dsh`。插件在宿主启动时挂载：修改宿主端代码（`lib/index.js` 等）必须重启；仅修改客户端代码（`lib/client.js`）刷新页面即可生效。两种修改都需要先将文件同步至 profile 的 `node_modules` 副本。

安装完成后，「设置」中出现**账号管理**。

---

## 快速开始

1. **设置 → 账号管理 → 新增店铺**：先选平台与账号身份，再填店铺名（ego 模式为用户名）与登录账号；登录方式选择「账号密码代填」或「扫码 / 手动登录」。
2. 点击**创建并去登录**，弹出真实浏览器窗口（ego 模式下为该店铺自身的 TaskSpace）。
3. 在窗口中登录至卖家后台（各平台入口见[支持平台](#支持的平台)）；插件会自动勾选登录页上的同意协议 / 隐私条款。
4. 返回 DSH，行内状态变为「已登录」后点击该行的**完成并保存**。ego 模式仅保存状态，TaskSpace 保持打开（独立窗口，不影响正常使用浏览器）；Chrome 模式则关闭窗口。
5. 此后该店铺持续显示登录态，行内提供供脚本复用的两项信息：ego 模式为 profile 与空间名，Chrome 模式为调试端口与档案路径。
6. 可选：点击**调整排期**开启定时任务，由插件每天自动检测或采集。

ego 模式下插件自动为店铺分配未被占用的「用户配置」（默认配置永远留给使用者自己）：同一平台同一身份的店铺必须分开配置，不同平台的店铺、以及同一平台的买家与卖家可以共用一份配置。ego 的 SDK 只能列出与使用已有配置，不能新建，配置用尽时需先在 ego 中新建一个「用户配置」。

---

## 界面说明

### 列表页

```text
[浏览器设置] [刷新] [+ 新增店铺]
┌ 每天 10:00 起 · 每组 1 个店铺，组间隔 30 分钟            [调整排期] ┐
│ 适用于全部店铺，含已暂停任务；错过时间不补跑。                          │
└────────────────────────────────────────────────────────────────────┘
[全部 3] [拼多多 2] [淘宝 1] …
[搜索 店铺名、备注、平台或端口]
店铺名 | 平台 | 定时任务 | 登录状态 | 调试端口 | 操作
某某旗舰店  淘宝   开启·10:30   已登录    :9224    [检测] [管理]
```

- **登录状态**：`已登录` / `登录已失效`（曾登录，当前掉线）/ `未登录`（从未登录）/ `未检测` / `运行中·待检测` / `等待登录`，下一行显示检测时间。
- **定时任务**：行内胶囊显示 `开启·HH:MM` 或 `暂停·HH:MM`，点击可切换该店铺是否执行。
- **操作**：`检测`（静默复核）、`管理`（进入详情页），以及按状态出现的 `去登录` / `完成并保存`。

窗口已打开的店铺点击「去登录 / 重新登录」时，插件在已有浏览器中打开一个登录页标签页，不会启动第二个 Chrome 实例（同一档案再次启动只会把 URL 转给已有窗口）。

### 店铺详情页

平台与店铺名（只读）、账号、账号类型、登录状态、端口、上次登录、凭证到期、保活停留；底部为删除账号、重新登录 / 去登录，以及检测登录态、打开工作台、重扫、复制档案路径、编辑店铺。卖家账号的详情页另有「数据采集」卡片（采集域与定时执行设置）。

### 浏览器设置

- **浏览器后端**：自动 / ego lite / Chrome，保存后立即生效；下方显示当前实际生效的后端、探测到的 CLI 路径与 ego 用户配置列表。
- **ego-browser CLI**：留空表示自动探测，探测不到时手动填写。
- **Chrome 可执行文件**：留空自动查找 Chrome，未找到时使用 Edge。
- **启动 ego**（仅在 ego 未运行时出现）：仅启动 ego 主程序，不操作任何 TaskSpace。
- **刷新 ego**：重新读取 ego 的用户配置与 TaskSpace 列表。
- **路径与高级选项**（默认收起）：路径、Chrome 回退（起始端口、打开时同时打开商品列表页、关闭时先让浏览器自行退出）、ego 与数据目录信息。
- **版本与更新**：检测源码仓库与 GitHub 上游的新提交，执行快进合并并将 `lib/`、`package.json`、`README.md`、`test/` 覆盖至安装副本；仅在检测到新版本时可用，覆盖后需重启 DSH Desktop。

插件不会为读取状态而启动 ego：所有 CLI 调用前先检测 ego 主进程状态，未运行时如实返回 `running:false`，仅在点击「打开店铺」或「启动 ego」时才启动。

---

## 定时任务与保活

排期字段：

| 字段 | 说明 |
| --- | --- |
| 每日起始时间 | 每日开始执行的时间 |
| 组间隔（分钟） | 组与组之间的间隔 |
| 每组店铺数 | 每组执行几个店铺；留空表示自动（内存 ≤16GB 为 1，>16GB 为 2） |
| 保活停留（秒） | 判定为已登录后多停留数秒再复查，默认 8，0 表示检测完立即关闭 |
| 开启定时任务 | 总开关（关闭时横幅置灰，不执行任何任务） |
| 排期预览 | 显示每个店铺的时间点，可拖动调整顺序 |

规则：

- **全部店铺排队**：每「每组店铺数」个店铺为一组，同组共用同一时间点，下一组时间为上一组加「组间隔」分钟。
- **单店开关仅控制是否执行**，不影响其占用的时间点：暂停一个店铺不会使后续店铺提前。
- **错过不补执行**：仅在到点后 2 分钟内执行；机器休眠或隔天启动时跳过。
- **同一天同一时间点仅执行一次**：记录于 `config.schedule.lastSlots`，重启 DSH 后不会重复。
- **跳过两类店铺**：等待登录的店铺、Chrome 后端中浏览器已打开的店铺；ego 后端不因「空间已打开」跳过，检测在同一 profile 下另开临时空间读取 cookie 后立即关闭，全程不接管使用者窗口。
- 宿主每 20 秒检查一次排期；同一店铺的手动操作与定时任务共用一把锁，冲突时任务让路并记录原因。

保活（凭证续期）：判定已登录后让页面多停留「保活停留」秒再复查，期间页面自身的心跳与请求会正常发出，站点将该次访问视为活跃。

两条边界说明：

- **到期时间不等于会话可用**：已掉线的店铺 cookie 常仍显示较长有效期，但服务端会话已失效；登录态判定始终以「站点是否重定向至登录页」为准。
- 保活仅提升会话活跃度，不保证永不掉线；掉线时如实返回「登录已失效，请重新登录」。

关闭窗口后的登录态保持：淘宝卖家依赖的 `cookie2` / `_tb_token_` 属于会话级 cookie，Chrome 默认关闭窗口即丢弃。插件固定携带 `--restore-last-session` 启动参数，使 Chrome 将会话级 cookie 写入磁盘并在下次启动时读取；同时把「自行打开一个干净标签页」作为判定依据，避免把恢复出的旧登录页当作当前状态。保存登录态时会按平台身份 cookie 逐个核对，缺失时重读并导回工作台触发一次，超时仍不完整则不关闭窗口并返回失败原因。

cookie 罐本地备份：`--restore-last-session` 无法覆盖使用者直接点击窗口关闭按钮的情况，因此只要读到「已登录」，插件即把整份 cookie 保存到档案目录的 `dsh-session-cookies.json`（AES-256-GCM 加密，主密钥由系统密钥后端保护）；下次启动浏览器时先通过 CDP 将档案中缺失的 cookie 补回，仅补缺失项，不覆盖档案中的新值。

---

## 登录态判定

1. **登录页最可靠**：站点将请求重定向至登录页即表示站点不认可该会话，即使 cookie 罐中仍保留身份 cookie（服务端过期不会清除浏览器 cookie）也判定为未登录。提示文案按「是否曾经登录」区分：曾登录为「登录已失效，请重新登录」，从未登录为「未登录，请前往登录页登录」。
2. **身份 cookie**：域名匹配、名称命中该平台身份 cookie，且值不是占位符。匿名 cookie（`cna`、`_m_h5_tk`、`sdtoken` 等）所有访客均有，不计为凭证；淘宝与天猫要求命中 `unb` 或 `sgcookie`；1688 的 `__cn_logon__` 要求取值 `true`。
3. **URL 弱判据**：仅在通过 CDP 读取 cookie 失败时使用，并如实标记为 `evidence: 'url'`，界面中与「确定」区分显示。

静默检测的导航稳定判定：浏览器未打开时，检测会使用无头 Chrome 打开同一份档案探测一次。`settlePage()` 仅以「导航真正结束」为判定条件（`document.readyState === 'complete'` 且 URL 连续 1.5 秒不变；资源持续未结束的站点 URL 稳定 4 秒亦认可；总上限 12 秒），避免把「启动参数里立即出现的后台 URL」当作登录成功。`test/live-probe.mjs` 用本地页面复现该时序（先渲染工作台，400ms 后由 JS 跳转登录页），将该回归固定为测试用例。

---

## 与上架和采集流程对接

上架 / 采集脚本复用某个账号时，按后端区分取用信息：

**ego 模式（推荐）**

- 该店铺的 **profileId**：行内与详情页显示的 `Profile N`，接口字段为 `egoProfile`；`shop_accounts` 工具的 list 输出中同样包含 `egoProfile` 与 `egoSpace`。
- 脚本使用同一 profile 打开自身的 TaskSpace，登录态即有效（cookie 存储在 profile 级，空间只承载窗口）；空间名一致时可在 ego 中看到同一窗口，不传亦可。
- ego 不对外暴露 CDP 端口，脚本需使用 ego 自身的 SDK（`ego-browser nodejs`），不能使用 `connectOverCDP`。

**Chrome 模式**

- **调试端口**：行内「调试端口」列显示的值（脚本侧对应各平台的环境变量）；
- **浏览器档案**：行内「复制路径」复制的目录（脚本侧对应 `-Profile <档案目录>`）。

行内显示「CDP 可用」表示该店铺的浏览器正处于打开状态：Chrome 模式下脚本应直接连接该端口，不得再启动新的 Chrome（同一份档案被两个实例同时使用会报错）。插件与脚本都可用的对外接口是 `shop_accounts` 工具，以及 `/shop-accounts/*` 的本地 HTTP 路由。

---

## 数据存放位置

| 内容 | 位置 |
| --- | --- |
| 店铺清单与配置 | `%DSH_HOME%\shop-accounts\accounts.json`、`config.json` |
| 运行期登记（各浏览器使用的端口） | `%DSH_HOME%\shop-accounts\runtime.json` |
| 登录态（Chrome 模式） | 每店一份 `user-data-dir`：`%DSH_HOME%\shop-accounts\profiles\<账号 id>\` |
| 登录态（ego 模式） | 位于 ego 自身的 `User Data` 中，按 `accounts.json` 记录的 `egoProfile` 对应；插件不复制、不移动 |
| 会话 cookie 备份（加密） | `<数据目录>/profiles/<账号 id>/dsh-session-cookies.json`：AES-256-GCM，主密钥由系统密钥后端保护（Windows DPAPI / macOS 钥匙串） |
| 密码库 | `<数据目录>/account-secrets.enc`：同一把主密钥 + AES-256-GCM；密钥后端不可用时整库禁用，不保存明文 |
| 采集数据 | `<数据目录>/collection/<账号 id>/`：`coverage.json` 覆盖台账、`records.jsonl` 记录、`imports.json` 导入记录、`jobs/` 作业 |
| 调试端口 | Chrome 模式从 `portBase`（默认 9222）起自动寻找空闲端口，一店一端口；ego 模式无端口 |

整个数据目录可通过环境变量 `DSH_SHOP_ACCOUNTS_DIR` 迁移。

---

## 安全机制

以下约束属于设计上的硬性要求，修改代码时不得移除。

- **HTTP 接口仅供本插件界面使用**：所有 `/shop-accounts/*` 路由要求自定义头 `x-dsh-shop-accounts: 1`；拒绝跨站 `Sec-Fetch-Site`；写请求必须是 `application/json`；要求 `Host` 为 IP 字面量或 `localhost`（防御 DNS rebinding）。因此任意网页或局域网页面触发 reset、修改配置、执行更新的路径不可用。
- **调试端口不对网页开放**：启动 Chrome / ego 时不携带 `--remote-allow-origins=*`。Chrome 仅对携带 `Origin` 头的 CDP 连接执行 allowlist 校验，而 Node 的 WebSocket 不发送 Origin；开启该参数等同允许任意网页读取全部登录态。
- **递归删除仅识别一种路径形态**：`<档案根目录>/<账号 id>`。仅判断「位于根目录之下」不足够，还要求目录名恰为账号 id；通过导入创建的目录永远不会被插件递归删除；路径判定两侧均使用 `realpath`，junction 与 8.3 短名无法在词法层面绕过。
- **强制终止浏览器按 `--user-data-dir` 精确匹配**：不做「命令行包含该子串」的匹配，避免误杀全机浏览器。
- **端口归属仅认可自身端口**：读取与写入 cookie、执行 `Browser.close`、创建 cookie 备份之前均须确认端口属于该店铺（运行期登记表 8 小时内且进程存活，或进程命令行的 `--user-data-dir`）；无法确认则不读不写。CDP WebSocket 必须为 127.0.0.1 且端口一致。
- **自更新仅部署经校验的 commit**：先无条件执行 `git status --porcelain`（工作区存在改动一律拒绝），再以 `git archive <上游 commit>` 的内容落地，且必须取得并匹配版本号；`git` 调用禁用 `ext::` 传输并覆盖 `core.fsmonitor` / `core.sshCommand` / `core.hooksPath`。
- **敏感文件落盘加密**：cookie 备份与密码库均使用 AES-256-GCM，主密钥由系统密钥后端保护，更换系统账号或将文件复制至另一台机器均无法解密；文件中仅保留该店铺平台域下的 cookie，且仅档案根目录内的账号有备份。
- **配置中的路径均须通过校验**：`profileRoot` 不得为盘根、家目录、系统或程序目录；`browserPath` / `egoliteCli` / `egoliteApp` 必须存在且文件名符合对应程序的命名规则；`updateDir` 必须为绝对路径。

---

## 已知限制

- **不代为完成登录、不绕过验证码**：扫码、短信与滑块均由使用者在真实窗口中完成。
- **ego 的用户配置不能由代码新建**：SDK 只能列出与使用已有配置，用尽时返回明确错误，需先在 ego 中手工新建。
- **Chrome 模式一份档案同一时间只能被一个实例占用**：插件先探测端口，不会强制启动第二个实例；端口按店铺固定分配，冲突时报错而非静默更换。
- **ego 模式不提供 CDP 端口**：脚本需使用 ego 自身的 SDK。
- **ego 的窗口控制权为借用**：插件每次操作完成后都会将控制权交还使用者（`task.handOff()`，失败重试 3 次）；归使用者控制的空间不被接管，必要时以备用窗口名新开。
- **ego 关闭时也可执行检测**：检测会在后台启动无窗口的 ego 实例读取 cookie 后立即关闭；「打开店铺」操作本身会启动 ego 主程序，ego 会恢复上次的窗口，这是 ego 自身行为。
- **重名店铺在 ego 模式下会被拒绝**：店铺名即 TaskSpace 名（`店铺-<名字>`），重名会导致登录态相互混淆。
- **定时任务运行于 DSH 宿主进程**：DSH 可最小化，但退出 DSH 后不再执行。
- **无头检测的 UA 为 `HeadlessChrome`**：理论上可能被站点识别，当前六家平台实测正常。
- **macOS 分支未在真机运行**：开发机为 Windows；可脱离真机验证的部分（路径表、`ps` 解析、钥匙串命名与标记格式、白名单、业务代码中无平台硬编码）已由 `test/platform.mjs` 覆盖。

---

## 自检

```powershell
node test/smoke.mjs            # 113 项：平台判据 / 持久化 / 宿主 HTTP 面 / 排期 / ego 后端 / 客户端契约 / 安全边界
node test/features-v090.mjs    # 31 项：账号类型 / 密码库 / 账密代填 / 采集配置与调度 / 新路由
node test/features-v0101.mjs   # 15 项：登录账号查重 / 店铺配置导出导入（含坏数据与重复导入）
node test/features-v0110.mjs   # 24 项：采集数据层（台账缺口 / 导入校验与去重 / 空结果台账 / 查询）
node test/features-v0120.mjs   # 23 项：指标目录层（平台域名与指标数 / 跨平台校验 / metricId / /catalog）
node test/features-v0130.mjs   # 27 项：采集 DSL（编译 / 占位符 / 真实配方 / 登录守卫 / 产物 / HTTP 边界）
node test/features-v0140.mjs   # 18 项：下载落盘 + 采集作业编排（分批 / 重试 / 覆盖 / 交付）
node test/features-v0150.mjs   # 22 项：定时采集（mode 分流 / 待登录跳过 / 回写 / 登录过期自动代填）
node test/features-v0152.mjs   # 12 项：账号密码错的识别与暂停（提示分类 / 状态 / 超时保护）
node test/features-v0160.mjs   # 19 项：采集开关与时间统一到排期（迁移幂等 / tick 只认采集域）
node test/features-v0161.mjs   # 35 项：文案精简与占位符脱敏 / 小眼睛图标 / 下拉框样式 / 按钮尺寸稳定
node test/features-v0165.mjs   # 20 项：登录 iframe 内的账密代填（frame 候选顺序 / 真机壳页面）
node test/features-v0166.mjs   # 20 项：账号身份能力（拼多多不提供买家、抖音买家只走扫码 / 验证码）
node test/features-v0167.mjs   # 13 项：采集引擎四处修复（条件守卫 / 缺后处理能力 / 单日锚点 / 产物归集）
node test/features-v0168.mjs   # 25 项：后处理能力按需执行 / 页面数字字形还原 / 页面文字转指标
node test/features-v0169.mjs   # 20 项：补齐天猫 / 抖音 / 京东配方、登录过期按页面识别
node test/features-v0170.mjs   # 18 项：登录方式可选（账号密码代填 / 扫码或手动登录）
node test/features-v0171.mjs   # 9 项：抖店代填先切「邮箱登录」页签（真机对照实验）
node test/features-v0172.mjs   # 13 项：各平台「登录账号」提示 / 店铺 URL 接口
node test/features-v0173.mjs   # 8 项：代填时自动勾选「同意用户协议 / 隐私条款」
node test/features-v0174.mjs   # 6 项：六平台登录页实测 / 天猫买家入口改走淘宝登录页
node test/features-v0175.mjs   # 7 项：点「登录」按四条路径回退（按钮 / 文字 / 表单提交 / 回车）
node test/features-v0176.mjs   # 8 项：非标准选择器（`:visible` / `:text-is` / xpath `$`）与真实鼠标点击
node test/features-v0177.mjs   # 9 项：定时采集包含下载型配方（含缺陷复现）
node test/features-v0178.mjs   # 11 项：浏览器设置去掉说明性文案，只留可改的选项
node test/features-v0179.mjs   # 12 项：工具 output 声明 + 客户端报错落盘（设置页空白问题可定位）
node test/features-v0181.mjs   # 12 项：抖音买家入口是抖音精选（www.douyin.com/jingxuan）
node test/features-v0182.mjs   # 12 项：ego 控制权硬停适配（不接管用户空间 / 备用窗口名）
node test/features-v0183.mjs   # 12 项：打开与检测按「平台 × 身份」取参数
node test/features-v0184.mjs   # 18 项：默认配置留给用户、登录态判据不再误判
node test/features-v0185.mjs   # 9 项：ego 空间没有活页时新建一页（不再留下 https://x/ 空窗口）
node test/features-v0186.mjs   # 12 项：ego 用户配置按平台共用（同平台同身份才分开）
node test/features-v0187.mjs   # 19 项：表单按平台+身份给提示（买家叫用户名 / 用户账户，卖家叫店铺名 / 登录账号）
node test/features-v0188.mjs   # 11 项：买家账号不做数据采集（不显示采集卡片、接口拒绝、定时只做检测）
node test/features-v0192.mjs   # 9 项：窗口在别处关掉后状态跟上（可见时每 10 秒对一次，不再一直显示「关闭浏览器」）
node test/features-v0198.mjs   # 10 项：窗口里已经登录时不再自动代填
node test/features-v0197.mjs   # 7 项：浏览器设置面板的 hook 顺序（先跑 hook，再提前返回）
node test/platform.mjs         # 12 项：平台适配层契约 + macOS 分支（可在 Windows 上验证的部分）
node test/live-probe.mjs pdd   # 真机链路：临时档案启动无头 Chrome，读取 cookie 后关闭 + 「慢跳转」回归
node test/live-probe.mjs all   # 六个平台依次验证（建议逐个执行，共用档案会串 cookie）
```

`npm test` 一次执行上述前 38 套（零依赖、不触碰真实账号、不启动浏览器）。

`smoke.mjs` 通过 `DSH_SHOP_ACCOUNTS_DIR` 将数据目录指向临时目录，不触碰真实账号、不启动任何浏览器。`live-probe.mjs` 会真实启动无头 Chrome（临时档案、不弹窗口、不触碰店铺档案），验证「启动 → 调试端口 → `Network.getAllCookies`（读取 HttpOnly cookie 的唯一可靠途径）→ 正常关闭」这条链路。

发布与校验脚本在仓库的 `tools/` 目录：`npm run readme` 重建上面的自检清单，`npm run check` 做语法检查，`npm run suites` 一次跑完全部套件，`npm run doctor` 检查 README 锚点 / 口语化表达 / 脱敏。用法见 [tools/README.md](tools/README.md)。

- 自检：**681 项**（`npm test` 一次执行，不启动浏览器、不触碰真实账号；明细见[自检](#自检)）

---

## 目录结构

```text
lib/platforms.mjs   六个平台的登录页 / 主页 / 工作页、身份 cookie、域判据、登录态判定（含卖家与买家变体）
lib/platform/       平台适配层：win32 / darwin / unsupported + 统一入口
                    —— 密钥后端、浏览器路径、进程匹配、打开目录、ego 路径均在此层
lib/cdp.mjs         极简 CDP 客户端（裸 WebSocket，无第三方依赖）
lib/chrome.mjs      浏览器查找、端口选择、启动 / 关闭 / 探测
lib/ego.mjs         ego lite 后端（探测 CLI、在 ego 运行时中执行脚本、TaskSpace 与 profile、读 cookie）
lib/ego-lifecycle.mjs  ego 空间与「用户配置」：分配、探活、打开 / 检测 / 关闭 / 重置 / 收尾
lib/frames.mjs      跨 frame 求值（登录页 iframe 内的代填与读取）
lib/secret.mjs      cookie 备份加密（系统密钥后端保护主密钥 + AES-256-GCM）
lib/vault.mjs       店铺账号密码库（密钥后端不可用时整库禁用）
lib/autologin.mjs   账密代填（按平台选择器 + cookie 判据复核；验证码交回使用者）
lib/identity/       登录态判定与检测结论回写（login-state / login-check）
lib/collection.mjs  数据采集的配置与调度
lib/datastore.mjs   采集数据层：覆盖台账 / 记录 JSONL / plan·import·query
lib/catalog.mjs     指标目录层：平台 → 采集域 → 指标
lib/catalog/catalog.json  目录种子数据（3045 条指标）
lib/rpa.mjs         采集 DSL 引擎：编译为操作序列 + 执行器 + Chrome / ego driver
lib/rpa/dsls/       内置采集配方（淘宝 / 天猫 / 拼多多 / 京东 / 抖音）
lib/dsls.mjs        配方库发现与读取
lib/collect-runner.mjs  采集作业编排：prepare / advance / status、分批、一次重试、作业落盘
lib/collect-support.mjs 采集支撑：能力门控、作业准备、诊断产物归集
lib/scheduler-run.mjs  定时任务执行：到点巡检、单店采集、采集开关迁移
lib/account-ops.mjs 账号操作：端口分配、打开 / 关闭 / 重置
lib/accounts.mjs    账号表读写与店铺配置导入导出
lib/store.mjs       accounts.json / config.json / runtime.json 的原子读写与降级
lib/schedule.mjs    排期算法（纯函数：分组、时间点、到点、下次、记账）
lib/server/state.mjs   /state 组装（平台能力、账号行、排期视图）
lib/server/routes.mjs  /shop-accounts/* 全部路由
lib/server/tools.mjs   agent 工具 shop_accounts 的注册与动作实现
lib/index.js        插件入口：挂载路由与定时心跳、注册工具（不含业务逻辑）
lib/client.js       客户端 bundle：设置页「账号管理」整页 UI
cordis.patch.yml    插件挂载点
test/               自检脚本（smoke + 各版本 features + platform + live-probe）
tools/              发布与校验脚本（重建自检清单 / 语法检查 / 套件汇总 / 升版辅助）
```

---

## 更新日志

当前版本 **0.20.0**。逐版变更、修复原因与验证记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 许可

[MIT](LICENSE)
