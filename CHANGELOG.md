# 变更历史

> 每个版本都是在本机（Windows + Chrome）真机验过的；「验证」条目就是当时的实测证据，
> 数字都当真跑出来的看。自检项数：`node test/smoke.mjs`（主自检）、`node test/features-v090.mjs`（v0.9 功能）、
> `node test/features-v0101.mjs`（v0.10.1 查重与配置迁移）、`node test/features-v0110.mjs`（v0.11 采集数据层）、
> `node test/features-v0120.mjs`（v0.12 目录层）、`node test/features-v0130.mjs`（v0.13 采集 DSL）、`node test/features-v0140.mjs`（v0.14 下载与作业编排）、`node test/features-v0150.mjs`（v0.15 定时采集）、`node test/platform.mjs`（v0.10 平台层）。

## v0.15.0

用户：「那个定时任务现在该改为定时采集了，你去 rea 他原来的就发现，那个是定时采集来的」。

**逆向确认（铁证）**：他机器上 `~/.accio/accounts/<id>/automations/jobs.json` 有 8 个自动化任务，其中 **7 个就是定时采集**：

```json
{ "name": "吸音隔热教授 · pdd 经营数据采集",
  "schedule": { "kind": "cron", "expr": "0 10 * * *" },
  "payload": { "kind": "agent", "message": "ecommerce-data-collect\n\n使用这个skill，采集拼多多店铺“吸音隔热教授”的以下数据：“经营总览”（采集目录：“经营总览”，domain_id=pdd-scheduler-经营总览）…" },
  "sessionTarget": "isolated", "target": { "type": "agent_sticky", "agentId": "MID-…" } }
```

他每个店一条 cron、彼此错峰（10:00 / 10:30 / 11:00 …），到点往该店绑定的 agent 会话里投递一条采集指令。
**所以「定时任务」= 定时采集**，不是"定时检测登录态"。这一版把我们这边的语义改过来：

- **`schedule.mode`**（新增，默认 `collect`）：到点做什么 —— `collect` 跑采集，`check` 只是老的静默检测。老配置没有该字段 → 自动按 `collect` 走（等于升级即切换），想留老行为的在设置页切回。
- **`tickSchedule` 分流**：`mode=collect` 且这个店配了采集 → 调 `runScheduledCollection`（内部走 v0.14.0 的作业编排：prepare → 自己跑 → advance）；
  没配采集的店铺、或该平台还没有可跑配方 → 退回静默检测（不会因为开关是采集就什么都不做）。
- **`runScheduledCollection`**：挑该平台可跑配方 → `prepareJobForAccount({drive:true, skipCovered:true})` → 回写 `collection.lastRun*`（by=schedule）；
  登录失效（`LOGIN_REQUIRED`）会把店铺标成「待登录」，**不在这里偷偷代填密码**；没有可跑配方返回 `NO_DSL_FOR_PLATFORM`，不假装采过。
- **采集时不再因为"浏览器开着"跳过**（那正是我们要用的登录态）；检测模式仍不打断用户。
- **设置页**：新增「到点做什么」选择器（定时采集 / 只检测登录态），文案与表头按 mode 显示；`PUT /schedule` 与 `/schedule/preview` 真正接住 `mode`（之前只在 normalizeSchedule 里有，路由会丢掉）。

验证：新增 `node test/features-v0150.mjs` **18 项**（mode 默认/切换、collect 分流、check 模式不采集、待登录跳过、
采集回写、无配方退化、`lastSchedError` 记账、界面与注释接线）；八套旧自检照旧，合计 **280 项全绿**。
**没做**：像他那样「每店一条独立 cron + 各自绑 agent 会话」的多会话模型（我们是一条主排期按组错峰，语义等价、实现更简单）。

## v0.14.0

用户：「那你能按照他的来写吗」→ 把 v0.13.0 里没学完的两块补齐：**下载落盘** 和 **Python 式编排层**。

- **`downloadFile` 支持（v0.13.0 的最大缺口）**：编译成 `download` op →
  driver 设 `Page.setDownloadBehavior` 把浏览器下载目录指到我们定的路径 → 点下载按钮 →
  轮询目录等文件落地（忽略 `.crdownload/.tmp/.part`）→ 产物按 `download_ref` 登记（present/bytes/filePath）。
  Chrome 与 ego 两个后端都实现了（ego 运行时里用动态 `import('node:fs')` 轮询）。
  **覆盖率从 17/120 涨到 67/120**（剩下 51 份缺业务参数、2 份其它动作）。
- **新模块 `lib/collect-runner.mjs`：采集作业编排**，照 `collect_pipeline.py` 的契约一一对应：
  - `prepareJob`：算窗口 / 挑配方 / 查覆盖台账 → 生成 job 目录与首批 tasks（**每批最多 5 项**，对齐他"一个 Profile 每批 5 个 DSL"）；
    平台不匹配、缺业务参数、已采过分别进 `failedToPrepare` / `skipped` 并点名原因；
  - `advanceJob`：记本批回执 → **失败只重试一次**（且只重试"没采到业务数据"的；`UNSUPPORTED_ACTION`/`NO_DRIVER` 不重试）→
    下一批或交付；**空产物算 empty（业务无数据，不重试）**；**回执没到的项保留 pending，不猜不重发**；`revision` 不对直接拒绝（防重复推进）；
  - `statusJob`/`listJobs`：只读快照，绝不重发；
  - `driveBatch` + `drive:true`：插件自己把整批跑完（不想让调用方逐项执行时用）。
- **作业落盘**：`<数据目录>/collection/<账号>/jobs/<jobId>/`（`job.json` 状态机 + `artifacts/<taskId>.json` 回执与产物）；
  DSL 级覆盖台账 `dsl-coverage.json`（同窗口采过就不再重采）。
- **新路由 / 工具**：`POST /accounts/:id/collect-job`（prepare，可选 `drive:true` 自跑）、
  `POST /accounts/:id/collect-job/:jobId/advance`、`GET /accounts/:id/collect-job/:jobId`、`GET /accounts/:id/collect-jobs`；
  工具新增 `collect-job` / `collect-advance` / `collect-status` / `collect-jobs`。
- `collect-run` 不再对下载型配方报 501（现在真的会去下载）。

验证：新增 `node test/features-v0140.mjs` **18 项**（下载目录/落盘/产物统计、真实下载配方编译、
分批、覆盖跳过、一次重试、空数据不重试、无回执留 pending、revision 校验、status 只读、HTTP 四路由）；
老七套照旧，合计 **262 项全绿**。
**没做**：他那种「每 3 个 Profile 分组 + 组内并发」的多店并发（我们一店一个浏览器，现在是单店串行批）；
指标级归一化（仍交 collect-import）。

## v0.13.0

用户：「你看看他是怎么采集的，学他的」。

先说结论：**Accio 的采集不是写死的抓取代码，而是「配方 + 编排 + 宿主原生执行」**。证据（本机只读实测）：
它的 `ecommerce-data-collect` skill 目录是**全明文**的 —— `SKILL.md`、**120 份 DSL（JSON 步骤集）**、
10 个 Python 编排脚本、4 篇 references；宿主侧是原生工具 `browser_rpa_launch`（含 `_batch`），
CLI `ecomctl` 只负责 plan 与入库。完整逆向记录见 [docs/accio-collection-architecture.md](docs/accio-collection-architecture.md)。

这一版把**执行层**学过来：

- **新模块 `lib/rpa.mjs`**：DSL 编译器 + 哑执行器 + 三种 driver。
  - 编译层（唯一真源）：`trailingWindow`（最近 30 个完整自然日，30 天前~昨天，不含今天）、
    `conditions.time.bindings` 占位符（`{dateRange}` → `YYYY-MM-DD%7CYYYY-MM-DD`）、
    残留占位符直接报 `INVALID_DSL`（绝不把 `{dateRange}` 发给站点）、`runId` 自动生成；
  - 动作覆盖：`goto / waitTimeout / waitFor / readText / readPageUrl / click / when / assertElement`，
    外加 `scrollIntoView / scrollToBottom / type / hover / readAttribute / queryAll / assertText / clickAndWait / waitForLoadState / press / if / while / runScript`；
  - 登录守卫照抄它的技巧：`when` 命中登录框 → `then` 断言同一元素 `hidden`（必然失败，`onError:fail`）→ 得到 `LOGIN_REQUIRED`；
  - 产物声明 `collection.artifacts`：`present/bytes` 判定；**空产物 = 业务无数据（不重试）**，和它的语义一致；
  - driver：`makeCdpDriver`（Chrome 调试端口）、ego 后端用 `EGO_EXECUTOR_SOURCE`（同一份 ops 在 ego 运行时里哑执行，
    一次任务空间进出）、`makeMockDriver`（测试全离线）。
- **新模块 `lib/dsls.mjs`**：配方库存。自带 3 份种子（淘宝/京东/拼多多概览），并自动发现本机 Accio 的 120 份
  （`SHOP_ACCOUNTS_DSL_DIR` 可指别处），标出每份是否需要下载。
- **新路由 / 工具**：`GET /rpa/dsls`（列配方）、`POST /accounts/:id/collect-run`（跑一份，返回原始产物 + 逐步 trace + finalUrl）、
  工具 `action=rpa-dsls` / `action=collect-run`。原始产物落盘到 `<数据目录>/collection/<账号>/raw/<dslId>/`（失败也存，便于查配方）。
- **边界如实**：`downloadFile`（83 处、50 份 DSL 依赖浏览器下载落盘）**本版不支持**，直接 501 `DSL_NEEDS_DOWNLOAD`，
  不假装采到；浏览器没开返回 409（不偷偷拉起浏览器）。归一化仍交 collect-import，不猜指标映射。

覆盖率实测（120 份真实 DSL，给日期参数后离线编译）：**17 份可直接跑**、**51 份需业务参数**（传 `productId` 即可）、
**50 份依赖下载**（当前最大缺口）、2 份其它动作不支持。

验证：新增 `node test/features-v0130.mjs` **27 项**（编译层/时间窗口/占位符/真实配方编译/登录守卫→LOGIN_REQUIRED/
空产物判定/超时与可选步骤/trace/库存/HTTP 400·404·409·501/ego 执行器接线）；六套旧自检照旧，合计 **244 项全绿**。
**没做**：`downloadFile` 接管、Python 式编排层（job 目录/revision/并发分组/一次重试）。

## v0.12.0

用户：「你能拿到他的 3675 条指标、497 节点经营树、224 个数据源、采集覆盖记录（coverage）吗，要不我们也按照这个来」。
先把 Accio 的目录库整表导出核对（`~/.accio/data/plugins/commerce-domestic/ecommerce.db`，导出脚本复制 db+wal 到临时目录读，
**原库未改动**）：`topics` 497 行、`metrics` 3675 行、`sources` 224 行、`domestic_collection_coverage` **0 行**、
`source_schema_record` 0 行、`domestic_internal_data` / `domestic_external_data` 都是 **0 行**。
指标按平台：taobao 933、tmall 920、doudian 854、1688 346、alibaba 284、jd 185、pdd 153；
数据源按类型：rpa 154 / mcp 67 / manual 3；经营树引用指标 7244 次、注册表里缺失 0（自洽）。

**能不能照搬**：覆盖记录是**运行态**，他那边一行都没跑过，抄不到，只能自己长（v0.11.0 的 coverage 台账就是干这个的）；
指标/树/数据源则是**静态知识**，可以取，但里面混着 Accio 自己的实现细节（`value_path` 取值路径、`aggregation` 聚合口径、
`dsl_id`、RPA 加密资产），这些搬过来我们既跑不通也不需要。所以这一版只取**骨架**：

- **新目录 `lib/catalog/catalog.json`（593 KB，3045 条指标）**：按「本插件平台 → 定时采集域 → 指标」组织，
  每条指标只留 `name / domain / measure(度量类型) / time(时间粒度) / fields(落库必需字段) / src(来源 id) / scope`。
  Accio 的 `value_path`、`auxiliary_path`、聚合口径、DSL id、加密资产**一律不收录**（自带断言：文件里出现这些字样就测试失败）。
- **平台映射**：doudian → `douyin`、1688 → `ali1688`、alibaba（国际站）跳过；taobao/tmall/douyin/jd/pdd 五个平台共 3045 条。
- **新模块 `lib/catalog.mjs`**：懒加载 + 缓存；`catalogDomains(平台)` / `catalogDomainIds` / `catalogMetrics(平台,域)` /
  `catalogMetric(平台,id)` / `unknownMetricIds` / `metricCount` / `catalogInfo`；目录缺失或损坏时**整体降级**回 v0.11.0 的 5 域行为。
- **域清单按平台真实下发**：淘宝/天猫 **6 个域**（多「竞争洞察」，78 项指标），抖店/京东/拼多多 5 个域；
  1688 在 Accio 里没有 scheduler 子树（走 mcp/API），退回默认 5 域且不拦指标校验。
- **按平台校验**（三处：改配置 / plan / import / query）：拼多多选「竞争洞察」会被 400 挡回，淘宝可以。
- **记录带 `metricId`**：`collect-import` 的 items 可带目录里的 `metric_id`，落库后可按 `metricId` 过滤查询；
  `metricId` 参与去重哈希（同一天同值但不同指标，是两条记录）；跨平台/目录外的 `metricId` → 400 并点名。
- **HTTP `GET /catalog`**：不带参数给全平台概览（每平台域清单 + 指标数）；`?platform=&domain=` 给某域指标清单
  （默认 limit 200、`all=1` 全给，淘宝运营推广 540 条）。
- **工具**：`shop_accounts` 新增 `action=catalog`；`domain`/`domains` 枚举放开「竞争洞察」；新增 `metricId` 查询参数。
- **界面**：采集域按钮改由 `/state` 的 `a.collectionDomains` 驱动，直接显示「域（解释 · N 项指标）」，
  并加一行「本地指标目录：淘宝 共 933 项可采指标 / 6 个采集域」。
- **采集提示词**：域后面带上「约 N 项指标」，并明确「要采哪些指标以本地目录层为准，落库带 metricId」。

验证：`node test/features-v0120.mjs` **23 项**（目录规模与纯净度、平台域名与指标数、跨平台不认、三处校验、
metricId 落库/去重/过滤、`/catalog` 与 `/state`、工具与界面文案）；主自检等五套照旧，合计 **217 项全绿**。
**没做**：按指标做聚合/同比环比（要先有指标口径实现，暂由 agent 自己算）；把目录指标接到真实采集器（现在只是「目标清单」，采集能力另建）。

## v0.11.0

用户问：「这个定时采集，原来的 accio 是怎么做的，不可能是单纯的提示词吧」→ 我把 Accio 装在盘上的东西挖了一遍，
结论是它有一条**带契约的采集管线**：本地 CLI `ecomctl`（`@accio-ai/ecommerce-cli` 0.4.5，Go 静态编译）
操作 SQLite 数据仓库（`~/.accio/data/plugins/commerce-domestic/ecommerce.db`：3675 条指标注册表、497 节点经营树、
224 个数据源、覆盖台账、内部/外部两张数据表），RPA 采集器配加密的 locator 模板（`locator_template.json.enc`，
AES-256-GCM），流程是 `collection plan` → 跑采集（rpa/api）→ `collection import` → 记账 → `metric/topic query`。
用户回：「A」（选「学它的契约，自己做轻量版」）。

这一版只做**数据层**，采集执行仍然交给 skill/agent（插件不自己抓页面）：

- **新模块 `lib/datastore.mjs`**（零依赖，JSONL + 覆盖台账，不引入 `node:sqlite`——宿主 Node/Electron 不保证带它）：
  - `<数据目录>/collection/<账号id>/coverage.json`：覆盖台账，每个域若干 `{start,end}`，相邻/重叠自动合并；
  - `<数据目录>/collection/<账号id>/records.jsonl`：业务记录，一行一条 JSON（追加写，坏一行不连坐）；
  - `<数据目录>/collection/<账号id>/imports.json`：最近 100 次导入的批次日志。
- **plan**：`planCollection()` 按「账号 + 域 + 区间」算缺口，返回 `COLLECTION_REQUIRED` /
  `NO_COLLECTION_REQUIRED` 与 `awaitCollect:[{domain,label,domainId,missing,missingDays}]`，
  其中 `domainId` 与 Accio 同形（`<platform>-scheduler-<域>`，抖店 → `doudian`）。窗口上限 366 天。
- **import**：`importRecords()` 逐条校验（日期、指标名非空且不含控制字符、数值有限、`metric` 与 `values` 互斥、
  `extra` ≤2KB）→ `content_hash` 去重 → 追加落盘 → 记台账。**合法空结果必须带覆盖区间**（只记台账不写记录），
  否则「没采」和「确实没数据」分不清、台账永远推不动 —— 这是 Accio 的关键语义。
  一次最多 5000 条；账号 id 会进路径，必须过 `validAccountId`。
- **query**：`queryRecords()` 按域/指标/日期查（多指标记录按 `values` 里的键匹配），返回指标概要与截断标记。
- **接口**：`POST /accounts/:id/collect-plan`、`POST /accounts/:id/collect-import`、
  `GET /accounts/:id/collect-records`；工具 `shop_accounts` 新增 `collect-plan` / `collect-import` / `collect-query`。
- **界面**：详情页「数据采集」卡片下方显示本地数据概览（窗口、总记录数、每个域「已采全 N 天 / 缺 M 天」）。
- **顺手**：删账号时连带删掉它的采集数据目录（否则重建同 id 的账号会凭空有历史数据）；
  `/state` 每个账号新增 `collectionCoverage`；采集提示词改成三步（plan → 采集 → import）并强调空结果也要导入。

验证：新增 `node test/features-v0110.mjs` **24 项**全过（日期/区间、缺口、plan、导入校验与去重、空结果台账、
query、HTTP 面、删账号清数据、工具/界面/文档）；
`smoke` 113 / `features-v090` 30 / `features-v0101` 15 / `platform` 12 未受影响。

> 没做（有意留到下一步）：`query` 的跨域聚合与同比环比、指标注册表（我们还没有「指标 → 采集来源」的映射，
> 现在是记录级自由指标名）、把 `plan` 接进宿主排期自动跑（现在仍由 agent 按提示词驱动）。

## v0.10.1

用户看完与 Accio「账号管理」的逐项对比后回：「1 4做一下」—— 即对比表里标「我们较弱 / 缺」里性价比最高的两条：

1. **登录账号查重**（对齐 Accio `assertUnique(entries, platform, name, account)` 的双唯一性校验之一）：
   - `POST /accounts`：同平台 + 同登录账号 → 400 `ACCOUNT_LOGIN_NAME_DUPLICATE`，错误里点名撞的是哪家店；
   - `PUT /accounts/:id`：改成别人的登录账号同样挡（排除自己），改成空串仍是历史行为；
   - 比较口径：`NFC` 归一 + `trim` + **折叠大小写**（Accio 用精确比较，这里多折一次 —— 手机号/邮箱大小写
     不同是同一个账号，正是最容易重复建号的情形）；**只挡同平台**，跨平台同名（比如同一个邮箱在淘宝和京东都有账号）是正常的。
2. **店铺配置导出 / 导入**（换机器用，尤其 Windows → mac）：
   - `GET /export` 出一个 JSON：`{format:'dsh-shop-accounts/stores', version:1, count, accounts:[…]}`，
     每项含平台 / 账号类型 / 店名 / 店铺 URL / 登录账号 / 备注 / ego profile / 采集设置；
   - **只搬配置不搬秘密**：密码、登录态（浏览器档案与 cookie 罐）、档案路径、端口、内部 id 一律不进包 ——
     密码本来就和本机密钥绑定（DPAPI/钥匙串），搬过去也解不开；文件里还写了一行 `note` 说明这件事。
   - `POST /import` 逐条校验、能建就建、建不了就跳过并给原因（不因一条坏数据废掉整包）：
     平台不认识 / 缺登录账号 / 同平台同账号已存在 → 跳过；`javascript:` 之类的 URL 被丢弃（导入文件是外部输入，
     不能进 Chrome 命令行）；文件里夹带的 `profileDir`、`port` 被忽略（档案目录按新 id 本机重新派生）；
     一次最多 500 条；导两次不会翻倍。
   - 界面：设置页「路径与高级选项」里新增「店铺配置迁移」组，两个按钮（导出下载 JSON / 选文件导入），
     导入完成提示里直说「密码要重新设置 —— 导出文件里不含密码」。

验证：`node test/features-v0101.mjs` **11 项**全过（Windows 本机）；另有 `smoke` 113 / `features-v090` 30 / `platform` 12 未受影响。

## v0.10.0

用户问：「那 mac 系统呢，能适配吗？」→ 又问「你说要兼容 mac 还是单独做一个 mac 版本的，哪个好」，
我推荐**单代码库 + 平台适配层**（理由：平台相关代码只有 5 个文件三四百行，分叉要维护两套测试/两套版本；
功能差异用能力位表达即可）。用户回「开始」。

这一版把散在 `secret.mjs` / `chrome.mjs` / `ego.mjs` / `index.js` 里的 Windows 相关代码抽进 `lib/platform/`：

- **新目录 `lib/platform/`**，统一契约（`id` / `label` / `secretBackend` / `capabilities` /
  `secretProtect(dataDir,text)` / `secretUnprotect(dataDir,blob)` / `browserCandidates()` /
  `killByProfileDir()` / `ownerOfPort()` / `revealDir()` / `egoCliCandidates()` / `systemDirs()` …）：
  - `win32.mjs`：原 DPAPI PowerShell 脚本、Program Files 探测、`Get-CimInstance Win32_Process` 精确匹配、
    `taskkill /T /F`、`explorer.exe` —— **实现逐字搬过去，行为不变**（143 项自检就是回归网）。
  - `darwin.mjs`：**Keychain**（`/usr/bin/security add-generic-password` / `find-generic-password`）当密钥后端，
    `/Applications/<App>.app/Contents/MacOS/<bin>` 当浏览器路径，`ps -axo pid=,command=` 解析进程，
    `pkill -9 -P` 杀进程树，`open` 打开目录；路径一律用 `path.posix`（语义更准，且能在 Windows 上跑自检）。
  - `unsupported.mjs`：其它平台明确「不可用」而不是崩：`secretBackend=null` → 密码库整体禁用（不存明文）。
  - `index.mjs`：按 `process.platform` 选实现，支持 `DSH_SA_PLATFORM=darwin` 覆盖（自检用）。
- **密码库里 Keychain 的存法**：`<数据目录>/session-cookie.key` 里只存标记 `keychain:<service>`，
  service = `dsh-shop-accounts-<目录名可读片段>-<sha256(绝对路径) 前16位>`。好处：多个 DSH 档案/多份插件
  互不覆盖主密钥；密钥本身在系统钥匙串里，文件被拷走也解不开（与 DPAPI 的信任边界同构）。
- **行为变化（mac 上才算变化）**：`dpapiAvailable()` 这个名字保留（自检与历史调用依赖），
  语义从「非 win32 一律 false」改成「**本平台有可用密钥后端**」；`vault.mjs` 里那句
  `if (process.platform !== 'win32') return false;` 删掉了 —— 否则 mac 上密码库永远不可用。
- **界面文案按平台说话**：`/state` 新增 `osPlatform:{id,label,secretBackend,capabilities}`；
  详情页在 mac 上显示「密码只保存在本机（macOS 钥匙串 + AES-256-GCM）」，找不到浏览器时提示当前平台而不是写死 `chrome.exe`。
- 顺带修：`package.json` 的 description 之前是**双重编码的乱码**（`DSH 鎻掍欢…`），已写回正常中文；
  自检入口统一成 `npm test`（smoke + features + platform）。

验证：`node test/smoke.mjs` **113 项**、`node test/features-v090.mjs` **30 项**、
`node test/platform.mjs` **12 项**全过（Windows 本机）。

**⚠️ macOS 这一支没有真机验证过**（开发机只有 Windows）。按代码形状把能纯函数验的都验了：
候选路径表、`ps` 命令行里抠 `--user-data-dir`、目录归一化、Keychain service 命名与标记格式、
白名单挡前缀骗法、以及「业务代码里不再出现 powershell/explorer/taskkill/Program Files 硬编码」。
真机验收清单（拿到 mac 请照这个跑一遍）：

1. `npm test` 三套全过（`platform.mjs` 在 mac 上会自动按 darwin 跑，`win32` 那几条断言仍是纯函数、不受影响）。
2. 新建店铺 → 填账号密码 → 看钥匙串访问里出现 `dsh-shop-accounts-…` 条目；`account-secrets.enc` 里应看不到密码。
3. **首次读写钥匙串可能弹一次授权**（system 会问「是否允许访问」）—— 允许即可；这是 Keychain ACL 的正常行为。
   如果用户点了「拒绝」，插件应报「本机密码库不可用」，而不是崩。
4. 打开店铺：Chrome 从 `/Applications` 找到并起来，`--user-data-dir` 正确隔离；
   关不掉时按 profile 精确匹配杀进程（**不该**杀掉用户自己开的其它 Chrome）。
5. 「在文件夹中显示」应打开 Finder。
6. ego lite 的 mac 版路径是**猜的**（`/Applications/ego lite.app`、`~/Library/Application Support/…`）：
   没装或路径不同时应回退到 Chrome 后端，而不是报错卡死。

## v0.9.2

用户指出我 v0.9.1 的做法没对齐 Accio：「人家不用点自动登录的，人家账号密码是必填的」。
回头查逆向证据（报告 3.4 / 4.6 节），用户是对的：

- Accio 密码库 `create()`：`normalizeText(account,"account",256)` 非空必填、`normalizePassword` 1..4096 必填；
  店铺名只在 `isMerchantBackendAccount` 时必填。唯一性按 `platform+name`、`platform+account` 双查。
- Accio 没有「自动登录」按钮：profile 模式是 `store-auth:password-start` + `password-progress`，
  密码登录是**登录流程的一步**（`autoLoginSupported` 只是能力门控），RPA 侧用 `findSecret` 直接取账密填表。

这一版照这个模型改：

- **账号与密码改为必填**：新建弹窗标「登录账号（必填）」「登录密码（必填）」，前端先拦一次；
  服务端 `POST /accounts` 也硬校验，缺账号回 `ACCOUNT_LOGIN_NAME_REQUIRED`、缺密码回 `ACCOUNT_PASSWORD_REQUIRED`。
  密码库不可用或密码不合规时整单 400 —— 不会再建出「没有账密」的半成品记录。
- **打开店铺即账密登录**：`POST /accounts/:id/open` 在「已存账号+密码」时自动代填并提交，
  返回 `autofill:{attempted,ok,code,hint,loggedIn}`；界面 toast 直接说「已用保存的账号密码自动登录成功」
  或代填失败的下一步提示。要扫码/手工登录时传 `autofill:false`（留着这条路径：C 端买家账号常常只能扫码）。
- **`POST /accounts/:id/autologin` 不再要求 `confirm:true`**（显式 `confirm:false` 仍被尊重，回 `AUTOLOGIN_DECLINED`）；
  详情页按钮改叫「重新登录（代填）」，语义变成「掉线后补一次登录」，不再是主流程。
- 文案统一：卡片标题「密码与自动登录」→「密码与账密登录」；登录页提示改成「已保存的账号密码会自动代填；
  要走扫码/短信就在弹出的窗口里手动完成」。

验证：`node test/smoke.mjs` 113 项、`node test/features-v090.mjs` **30 项**全过。
新增用例覆盖：缺账号 / 缺密码建号必须 400、`autofill` 默认开且可关、autologin 不再强制 confirm。

## v0.9.1

用户问：「怎么不用填密码店铺名那些？」—— 原来的「新增店铺」弹窗只有平台/店铺名/账号类型，
密码得建完再进详情页设置，店铺名留空时还会自动起名（而且自动起的名字后面多带一个 `;`）。
这一版把这两件事都改回直觉：

- 新增店铺弹窗多了 **「登录账号（可选）」** 和 **「登录密码（可选）」** 两个字段，密码带显示/隐藏开关。
  一次就能把「哪家店、用什么账号密码登录」填完，不用来回跳页面。
- `POST /accounts` 支持可选的 `password`：服务端在校验通过后直接落进本机加密库（`account-secrets.enc`），
  响应只回 `passwordSaved` 布尔，**任何地方都不回显明文**。密码库不可用或密码不合规时**整单 400**，
  不会出现「号建好了、密码丢了」的半成品状态；落库失败则店铺照建，只回报 `passwordError` 让用户进详情页重试。
- 修掉自动起名的多余分号：以前留空店铺名会得到 `拼多多 店铺 3;`，现在是 `拼多多 店铺 3`。
- 编辑弹窗里的「登录账号」现在真的会保存（以前弹窗没带上这个字段，改了会被静默丢弃）；
  密码字段只在新建时出现，编辑时仍走详情页的「密码与自动登录」区块。

验证：`node test/smoke.mjs` 113 项、`node test/features-v090.mjs` **28 项**（新增一条「新建时直接带账号+密码」）全过；
新用例同时断言 `accounts.json` 与 `/state` 响应里都不含明文密码。

## v0.9.0

用户说：「对照我逆向出来的 Accio Work 账号管理，补上我缺的：存密码和自动登录、卖买家账号、数据采集。」

三块都按 Accio 的模型做，但**边界比它更保守**：密码只在用户显式点「自动登录」时代填一次，
采集只维护配置与调度、真正的抓取交给 agent/skill（平台改版只改 skill）。

### 1. 账号类型：卖家 / 买家（对齐 Accio 的 `accountType`）

- 账号表里的 `accountType` 从自由文本（默认「商家账号」）改成枚举 **`seller` / `buyer`**；
  老数据（`商家账号` / 空 / 其它）自动归一成 `seller`，不丢号。
- 买家有**独立的登录入口与判据**（`platforms.mjs` 的 `BUYER_VARIANTS`）：
  淘宝/天猫 → `login.taobao.com`、京东 → `passport.jd.com/new/login.aspx`、1688 买家页；
  拼多多/抖音 C 端入口没真机验过，标 `experimental`（界面会提示）。
- 新增能力位 `capabilities`：`upload`（上架）只给卖家；`storeUrl` 只给卖家且拼多多不支持
  （照抄 Accio 的 `supportsStoreUrl(platform, accountType)` 口径）。
- `/state`、列表、工具输出都带 `accountType` / `accountTypeLabel` / `capabilities`；
  新增/编辑弹窗与详情页都能选类型。

### 2. 密码库 + 自动登录（对齐 Accio 的 `password-vault` + `passwordLogin`）

- 新 `lib/vault.mjs`：`<数据目录>/account-secrets.enc`，**复用 secret.mjs 的 DPAPI 主密钥 + AES-256-GCM**
  （与 cookie 罐同一套信封）。**DPAPI 不可用时整库禁用，绝不退化成明文存密码**。
- 密码**不进 `accounts.json`、不进 `/state`、不进日志**；账号表只有 `hasPassword` / `passwordUpdatedAt`。
- `PUT/DELETE /accounts/:id/password`、`POST /accounts/:id/autologin`（必须 `confirm:true`）；
  `DELETE /accounts/:id` 会顺手清掉该账号的密码。
- 新 `lib/autologin.mjs`：按平台给选择器候选（阿里 havana / 京东 / 拼多多 / 抖店），
  页面里用原生 setter + `input/change` 事件写值（React 受控输入直接改 `.value` 会被丢），
  先尝试点「账号密码登录」页签、填完提交、再**用 cookie 判据验一次登录态**——
  验不过就如实回 `AUTOLOGIN_NEEDS_USER`（验证码/短信交回用户），绝不假装成功。
- ego 后端也支持：`ego.mjs` 新增 `autofill` op（走 ego 运行时 `page.cdp('Runtime.evaluate')`），
  填完把控制权交还用户。安全说明：ego CLI 不继承环境变量，密码只能内联进临时运行脚本
  （`%TEMP%` 下 mkdtemp 私有目录，执行完立即整目录删除），不是零痕迹，介意就用「打开窗口手动登录」。

### 3. 数据采集：配置 + 调度，采集交给 skill（对齐 Accio 的 `STORE_COLLECTION_DOMAINS`）

- 采集域固定 5 个、界面名照抄 Accio：**经营总览（成交与客户）/ 流量转化（访客与转化）/
  运营推广（广告与营销）/ 商品供给（商品与动销）/ 服务履约（售后与服务）**；「竞争洞察」不开放。
- 校验同口径：开启必须至少选一个域、域必须来自白名单、时间必须 `HH:mm`。
- `domain_id` 与 Accio 同构：`<platform>-scheduler-<域>`，抖店用 `doudian`。
- `collectionPrompt()` 生成交给 agent 的任务说明：店铺/平台/账号类型 + 各域 domain_id +
  **固定最近 30 个完整自然日（不含今天）** + 「不要用 `--all-domains` 扩大范围」。
  买家账号自动剔除三个经营域并说明原因。
- 新路由：`PUT /accounts/:id/collection`、`GET /accounts/:id/collect-prompt`、
  `POST /accounts/:id/collect-done`（回写 `ok/partial/failed` + 备注）。
- 工具 `shop_accounts` 增 `collections` / `collect-prompt` / `collect-done` / `autologin` 四个 action；
  `/state` 带 `dueCollections`（今日到期店铺）。

### 验证

- `node test/smoke.mjs` → **113 项全过**（原有 112 项 + 账号类型断言更新）
- `node test/features-v090.mjs` → **27 项全过**（新增：类型变体/判据、密码库密文落盘、
  采集校验/提示词/到期、新路由、autologin 缺密码/缺账号的错误码）
- 唯一改动到的旧断言：详情页存 `accountType:'商家账号'` 现在读回 `seller`（预期行为变更）。


## v0.8.5

用户说「路径与高级选项有点乱，再美化一下」。**只动设置页这一块的排版，逻辑与接口一行没改。**

诊断（离线渲染 + CDP 量几何，见下）出来是五个叠加的小毛病：

- **① 框中框**：折叠块自己带底色 + 圆角 + 边框，而它就躺在「浏览器设置」卡片里 —— 展开后像两块
  面板叠着。现在**去掉底色/圆角/边框**，只用一条上发丝线与「浏览器后端」分开，展开后是卡片内的一整段。
- **② 标签列挤、路径看不全**：标签列 104px、标签垂直居中，值列只剩 252px。现在 88px + **顶对齐**
  （`align-items:start`，标签 `padding-top:6px`），值列 304px；长路径的输入框补 `title`，悬停可看全。
- **③ 行高忽高忽低**：「Chrome / Edge」下面原本另起一行「探测到：C:\…」，把这一行撑成 64px，上下都是
  28px —— 整块节奏就乱了。现在探测到的路径只放 placeholder + `title`，**不再单独占行**；只有「没探测到」
  这种真的需要用户动手时，才在值列下面多一行提示。
- **④ 勾选项不在这套网格里**：「打开时额外开一个…」「关闭前先让…」原来是整行 label 文字，左边缘跟上面的
  输入框对不齐。现在也走「左标签右内容」：`打开时` / `关闭时` 两行，勾选框落在值列里。「信息」组的只读值
  同样入网格（`ego profile` / `数据目录`），长路径 `overflow-wrap:anywhere` 折行。
- **⑤ 分组小标题**：`text-transform:uppercase` 会把「Chrome 回退」渲染成「CHROME 回退」；10px 也弱。
  现在 11px、600、`letter-spacing:.06em`，右侧拉一条发丝线到底，三组（路径 / Chrome 回退 / 信息）才有层级。
- 另外：`起始端口` 的说明缩成「留空 = 9222 起顺延」并与输入框同一行；折叠标题 11.5px → 12px，展开时转正文色。

**验证**：`node test/smoke.mjs` 113 项全过（只碰 client.js 的样式/结构；两处断言随新 DOM 更新 —— ego profile
从「一行文本」改成 Field 行，意图不变：仍然只在 ego 模式下出现）。几何实测（无头 Chrome + CDP，430px 宽卡片）：
值列 252→304px、展开高度 459→426px、标签与值列左边缘各自统一、无横向越界（`outside: []`）、无纵向裁剪。
截图：`C:\Users\mo\cluade\shop-accounts-diag\ui-adv-before.png` / `ui-adv-after.png`。

## v0.8.4

用户说「继续修」。这一版是**对 v0.8.3 加固本身的第二轮审查**（专挑"修得不彻底 / 修出问题"的地方），
外加把上一版明确留的两项（cookie 明文落盘、ego 临时脚本）补掉。

- **① 严重：信任锚能被同一个 API 改写**。删除判定原来只看"目录在 `profileRoot` 之下"，而 `profileRoot`
  本身可以由 `PUT /config` 改 —— 把它改成 `C:\Users\mo` 再删同级目录就绕过了。
  现在：`profileRoot` 写入要校验（绝对路径、不能是盘根/用户主目录/系统或程序目录）；删除要求
  **「在档案根目录下 + 目录名正好等于账号 id」**（`deletableProfileDir()`），导入的目录一律不删。
- **② 严重：导入目录会让全机浏览器被杀**。`killChromeForProfile()` 原来用"命令行包含这个子串"匹配，
  `profileDir` 设成 `C:\Program Files` 时每只 Chrome/Edge 都命中 → 打开失败就强杀全部浏览器。
  现在改成**解析 `--user-data-dir=` 再精确比较**；导入目录另外挡掉系统/用户/程序目录本身。
- **③ 高：'unknown' 被偷偷提升成 'mine'**。端口归属查不到时，`openAccount` 复用分支会写一条
  runtime 登记，之后这条陌生端口就永久被当成自己的。现在只有 `ownership === 'mine'` 才写登记表。
- **④ 高：runtime.json 无穷期**。崩溃后过期条目仍算 mine。现在条目要求 8 小时内、`pid > 0` 时还要
  进程真的活着（`process.kill(pid, 0)`）。
- **⑤ 中：关闭/删账号/快照/存 cookie 没接归属三态**。CDP `Browser.close` 现在只在 `mine` 时发；
  `snapshotAccount`/`rememberLiveCookies` 读 cookie 前也先过归属；删账号的强杀按精确 `--user-data-dir`。
- **⑥ 中：会话 cookie 明文落盘**（上一版遗留）。新增 `lib/secret.mjs`：一条随机主密钥用 **Windows DPAPI
  （CurrentUser）** 保护，cookie 罐用 **AES-256-GCM** 加密落盘（`{v:2, enc:'aes-gcm-dpapi'}`）。
  DPAPI 只在"生成密钥/本进程首次解包"时调一次 PowerShell（实测 1.2s，之后走进程内缓存）；
  解不开（换 Windows 账号/换机器）就重新生成密钥，旧备份读不出但不会崩；DPAPI 不可用时
  **显式降级**成 `enc:'plain'`，功能不受影响。旧格式明文文件仍能读。
- **⑦ 中：导入目录会被写 cookie 备份**。`saveSessionCookies/loadSessionCookies` 现在只对"档案根目录内"
  的账号生效 —— 导入目录可能在 `C:\Users\Public` 这种位置，把带值 cookie 写进去等于扩大泄露面。
- **⑧ 中：自更新版本校验可跳过**。commit 删掉 `package.json`（或没有 `version`）时原逻辑会"跳过校验照拷"。
  现在取不到版本、或版本不一致，一律中止且不落任何文件。
- **⑨ 低：`.git/config` 的 `core.hooksPath` 仍会执行**。`runGit` 再加 `-c core.hooksPath=`（空值），
  连同已有的 `protocol.ext.allow=never`、`core.fsmonitor=`、`core.sshCommand=ssh`。
- **⑩ 低：凭据打码不全**。补上 `Authorization: Bearer xxx`、query 里的 `token/api_key/secret/password/sig`、
  `https://<token>@host`（无冒号 userinfo），并且 git 的 stdout 也打码。
- **⑪ 低：路径判定没解 junction**。Windows 上 `profiles\j` 若是指向 `C:\Windows` 的 junction，
  词法上"在根目录下"、物理上在根外。`isInsideProfileRoot()` 现在两边都走 `fs.realpathSync.native`。
- **⑫ 低：坏账号 id 只是"承诺"**。`validAccountId()` 之前没人调用；现在 `findAccount()` 先校验形状，
  坏 id 一律当"账号不存在"，不参与路径拼接。
- **⑬ 低：ego 部分失败被当成功**。`reset` 只清掉一部分 cookie 时现在带 `partial:true`，且**不抹掉**
  上一次的检测结论（否则界面说"未登录"、档案里其实还有 cookie）。
- **⑭ 新增：Host 头反 DNS rebinding**。HTTP 路由要求 `Host` 是 IP 字面量或 `localhost`
  —— rebinding 之后浏览器发的 Host 是攻击者域名，直接 403；局域网用 IP 访问仍然放行。
- **⑮ 客户端真 bug**：`api()` 对"没 body 的 POST"（`/ego/start`）不带 `Content-Type`，被新门禁 415 拒了。
  现在非 GET 一律带 `application/json` + `{}` 体。
- **⑯ 配置里的 exe 路径要校验**：必须存在、且文件名像浏览器（chrome/msedge/brave/chromium…）或 ego 程序。
  （"用户自己指定路径"仍是功能，但不再能指向任意 exe 让 `spawn` 去跑。）

- **⑰ DPAPI 密钥的并发与覆盖**（复审发现）。密钥文件用**独占创建**（`wx`）+ 写后回读：两个 DSH 进程同时首启时，
  后一个读回前一个写的密钥，不会各生成一把互相覆盖；**已有的密钥文件解不开时绝不覆盖**（一次 AV 锁 / 换 Windows
  账号不应烧掉全部历史备份）——本进程退明文，文件原样留着，下次重启再试；读取失败还会重试 3 次（AV 扫描常短暂占用）。
- **⑱ 登记表 `pid:0` 条目不可信**（复审发现）。`reused`/无头探测写的是 `pid:0`，原来在 8 小时内直接算 `mine`；
  浏览器退出、端口被别人接手后，真 cookie 会被 `setCookies` 塞过去。现在只有 **pid>0 且进程活着** 才认登记表，
  `pid:0` 一律回退到进程命令行核实（查不到就是 unknown，不读不写）。
- **⑲ 更新源必须是"本插件的仓库"**（复审发现）。`updateDir` 之前只 `resolve`，`applyUpdate()` 会把任意仓库的
  `lib/` 覆盖进安装目录（只要版本号更大）= 任意代码执行。现在写入配置和 `checkUpdate` 都校验：存在、是 git 仓库、
  仓库根 `package.json` 的 `name === dsh-plugin-shop-accounts`、不在系统/程序目录里。
- **⑳ Host 白名单修正**（复审发现）。之前只认"IP 字面量或 localhost"，用 `my-pc:43120`、`localhost.`、`127.1`、
  `[fe80::1%eth0]` 打开界面会整个插件面 403。现在接受：IP 字面量（含简写/IPv6 zone）、`localhost`（含尾点）、
  本机主机名（含 `.local`/`.lan`）；**缺 Host 直接 403**（HTTP/1.1 必有 Host，缺了只可能是裸客户端）。
- **㉑ 可执行文件名用白名单**：`chrome.exe`/`msedge.exe`/`brave.exe`/… 与 `ego*.exe`，挡住 `chrome-evil.exe`、
  `not-ego.exe` 这种前缀/子串骗法。
- **㉒ cookie 罐格式校验**：只认 `v ∈ {1,2}`；加密格式必须**真解密**（不能把 `{enc:'aes-gcm-dpapi', cookies:[…]}`
  当明文收）；`savedAt` 放回信封里（之前 `restoreSessionCookies` 想读它，加密后读不到）；导入目录里 v0.8.3 留下的
  明文备份顺手清掉。
- **㉓ 坏 JSON 请求体返回 400**（修一个自己引入的回归：`done` 标记在解析前置位，导致 `bail()` 直接返回、
  请求永远没有响应 —— 二轮加固引入，本轮修）。请求体类错误统一带 status（400/413），不再一律 500。
- **㉔ 杀进程比较前归一化路径**：PowerShell 里先用 `[IO.Path]::GetFullPath` 处理两边，尾随点/`\.\` 写法也能匹配上。

**自检**：`node test/smoke.mjs` **99 → 113 项全过**（新增 14 项：Host 门禁三态/主机名/缺 Host、配置路径校验、
"根目录下但名字不是 id"删不掉、junction 按真实路径判、导入目录挡系统目录、坏 id 当不存在、上游无 version 拒绝更新、
DPAPI 加密往返+篡改检测+旧格式兼容+**密钥解不开不被覆盖**、落盘无明文、egoSpace 控制字符、凭据打码、
**真实 HTTP 服务链路**（真 Node 解析：Host/自定义头/Content-Type/非对象体/前缀边界/跨站））。

## v0.8.3

用户说「我的店铺账号管理插件，review 一下，最新版兼容了 ego，看看现在有没有漏洞」「全改了」。

这一版是**安全审查后的集中修复**。先给结论：命令执行面本来就是干净的（全程 `spawn`/`execFile`/`spawnSync`
数组传参、无 `shell:true`、PowerShell 用环境变量传参），问题集中在**信任边界**上 —— 两处调试端口开关、
一处无边界递归删除、一处无鉴权 HTTP 面、以及自更新拷工作区。逐条：

- **① 严重：CDP 调试端口对任意 Origin 开放**（`chrome.mjs:86`、`ego.mjs:219` 的 `--remote-allow-origins=*`）。
  症状：店铺窗口登录后长期开着（9222 起），ego 后台检测还会用**真实 ego User Data** 起无头实例（9300 起）；
  恶意网页 DNS rebinding 到 127.0.0.1 后能连上调试端口 → `Network.getAllCookies` 读走全部登录 cookie
  （含 HttpOnly 的 `unb`/`cookie2`/`PASS_ID`）、`Runtime.evaluate` 在已登录店铺里执行 JS ⇒ 账号接管。
  原因：注释里写的「undici 的 WebSocket 会带 Origin，Chrome 111 起默认拒绝」是**错的** ——
  实测 Node v22.23.1 的 undici **不发 Origin 头**（`ORIGIN=undefined`），Chrome 只对带了 Origin 的连接做校验。
  现在：两处开关**直接删掉**。真机验证：Chrome 156.0.8078.74 起 `--remote-debugging-port`、
  不加该开关，插件自己的 `cdp.getAllCookies()` 正常读到 cookie（新档案 0 个，符合预期），关窗后端口回收。
- **② 高：递归删除没有边界校验**。`removeProfileDir()` 是 `fs.rmSync(recursive:true, force:true)`，
  而 `account.profileDir` 可以由「导入已有档案」的接口任意指定（绝对路径、甚至 UNC），`reset` 分支没有任何
  路径校验（`DELETE` 里那个 `endsWith(id)` 也不是路径分量比较）。现在：`store.mjs` 新增
  `isInsideProfileRoot()`（`path.relative` 判越界），`reset` / 删账号 / `reveal` 三处都必须在档案根目录内，
  否则拒绝并说明原因；`removeProfileDir()` 再兜一层（拒绝盘根/家目录/层级过浅）；导入的 `profileDir`
  必须是**已存在的绝对路径目录**。
- **③ 高：自更新拷的是源码工作区**。`applyUpdate()` 的脏检查被 `if (info.behind > 0)` 短路 —— 源码目录
  已和远端同步但工作区被改过时，点「更新到最新」就把未提交内容部署进插件目录（重启即执行）。
  现在：脏检查**无条件**执行；用 `git archive <rev-parse --verify upstream>` 导出**已校验 commit** 的内容落地，
  校验 commit 里的 `package.json` 版本必须等于远端版本；`git` 一律加
  `-c protocol.ext.allow=never -c core.fsmonitor= -c core.sshCommand=ssh` 加固（防 `.git/config` 里挂命令）；
  `updateDir` 必须是绝对路径；git 报错里的 URL 凭据打码后再回界面。
- **④ 中：HTTP 面零鉴权/零 CSRF 校验**。宿主 Desktop 有 renderer token 门禁（`mode: advanced` /
  `openBrowser: false` 时普通浏览器 403），但插件自己不该裸奔：现在所有路由要求自定义头
  `x-dsh-shop-accounts: 1`（跨站要带它必先过 CORS 预检，而本服务不回 ACAO）+ 拒绝跨站
  `Sec-Fetch-Site` + 写请求必须是 `application/json`（挡跨站 `text/plain` 简单请求）。
  客户端所有请求都带这个头；`GET /update` 的副作用面因此也只对插件界面开放。
- **⑤ 中：端口/WS 归属 fail-open**。`ourBrowserOnPort()` 查不到归属时 `return true`，`browserUp()` 一行 JSON
  就能骗过，`Network.setCookies` 会把整罐 cookie 发给端口上的任何人。现在：归属三态
  `mine/other/unknown`，读写 cookie 只认 `mine`；`cdpCall` 必须校验 ws 地址是 127.0.0.1/::1 且端口一致；
  `exactPort()` 拒绝非整数端口（`9222@evil.com` 这种会解析成外部 host）；刚起的浏览器用
  `verifyFreshLaunch()` 核对进程命令行（查不到才接受，兼容 WMI 受限的机器）。
- **⑥ 中：`account.url` 拼进 Chrome 命令行 = 开关注入**。`--proxy-server=http://attacker:8080` 能让店铺
  全部流量走中间人。现在：`safeNavUrl()` 只收 http(s)、拒绝 `-` 开头；接口写入时就归一化/拒绝。
- **⑦ 中：会话 cookie 明文整罐落盘**。现在只存**本平台域下**的 cookie（`domainMatches`），并尝试
  `chmod 600`（Windows 上基本是 no-op，失败不影响功能）。
- **⑧ 中：ego reset 失败会退回整仓清空**，把共用同一 profile 的另一家店也登出（与「不连坐」的设计相反）。
  现在：有目标却一个都没清掉时**不整仓清空**，如实报错让用户手动退出登录。
- **⑨ 中：同名店铺在 ego 下串台**。Chrome 模式可以建两个同名店，切到 ego 后 `spaceNameFor()` 相同 →
  同一个 TaskSpace/窗口、登录态直接串。现在：每个 ego 动作前 `assertEgoSpaceUnique()` 再挡一次；
  改名时也挡。`egoCheckAccount()` 还会校验记着的 `egoProfile` 是否仍在列表里（不在就清掉，避免 Chrome
  用 `--profile-directory` 自动新建同名 profile 污染列表）。
- **⑩ 中：登录判据偏弱**。拼多多原来命中 1 个 cookie 就算登录（未登录页也可能种下 `mms_b84d1838`）→
  现在要求命中 ≥2 个且至少命中 `PASS_ID`/`SUB_PASS_ID` 之一；URL 兜底判据从 `includes()` 改成
  `urlHostInDomains()`（`new URL().hostname` + 后缀边界），`pinduoduo.com.evil.com` 不再算「在平台内」。
- **⑪ 低危收尾**：`--remote-debugging-port="9222"` 带引号时归属查询能匹配上了（先剥引号再匹配）；
  杀进程改成 `OrdinalIgnoreCase` 且拒绝空/过短 needle（不再可能"一键关掉所有 Chrome"）；
  `waitForCdp` 超时会 kill 掉刚 spawn 的 detached Chrome（不留僵尸锁档案）；ego 临时脚本改成
  `fs.mkdtempSync` 私有目录、跑完递归删除；`reveal` 只能开档案根目录内的目录；
  `POST /accounts` 的 port 限制在 1..65535。
- **⑫ 客户端**：`load()` 加请求序号守卫（登录轮询/排期轮询/手动动作并发时，旧响应不再覆盖新状态）；
  「同时删除档案」改成**删除账号**的准确文案 + `window.confirm` 二次确认（以前勾了就在保存后直接删号）；
  `toggleSched` 发目标值而不是对可能过期的 `schedEnabled` 取反；`fmtTime` 对 Invalid Date 返回原串；
  新增账号时校验后端返回里真的带 `account`。

**自检**：`node test/smoke.mjs` **99 项全过**（新增 13 项安全回归：源码不许再传 remote-allow-origins /
URL 白名单 / CDP 端口与 ws 校验 / 档案目录边界 / 导入目录校验 / ego profile 形状 / 三条 HTTP 门禁 /
reset 与删号都不越界删 / 自更新按 commit 落地且脏工作区不生效 / 凭据打码 / pdd 与 URL 兜底判据 /
客户端带自定义头）。

**真机验证**：Chrome 156.0.8078.74 + 插件自己的 `chrome.mjs`/`cdp.mjs` 跑无头实例 →
`waitForCdp=true`、`getAllCookies=ok`、`closeBrowser=true`、端口回收；`launchBrowser` 拒绝
`--proxy-server=` 开关注入；`getAllCookies('9222@evil.com')` 被拒绝。

**已知的小概率冲突**：没有变化（仍是「检测那 1~2 秒里刚好手动点开 ego」这一条，再点一次即可）。

## v0.8.2

用户问（原话）：「检测不是后台检测吗，你还要我打开才能检测啊」——对，之前 ego 模式下检测要求 ego 开着，这是个设计缺陷。

- **根因**：v0.8.0 为了「不要为了读状态把整个浏览器拉起来（会恢复上次几十个标签 / 3GB）」，让检测在 ego 没跑时直接跳过。
  但检测本来就该是后台动作，不该让用户为了它手动开浏览器。
- **为什么不能像 Chrome 那样复制档案**：ego 的 cookie 是 Chromium 127+ 的 **App-Bound 加密（v20）**，
  实测把 `Profile 3`（含 `Local State`）完整复制到临时目录再起实例 → 读到 **0 个 cookie**（密钥和原 user-data-dir 绑定）。
  所以必须用**真实档案**，但可以用无窗口模式。
- **现在的做法**：新增 `egoOfflineCookies()`（`lib/ego.mjs`）——ego 关着时，用同一份 User Data、
  `--headless=new --remote-debugging-port=<空闲端口> --profile-directory=<该店铺的 profile>` 起一个**无窗口**实例，
  通过 CDP `Network.getAllCookies` 读 cookie，过滤该平台域名后**立刻关掉**（先 CDP `Browser.close`，再按 PID 树补一刀，最后确认端口消失）。
  弹窗、恢复上次窗口这两件事都不会发生。
- **并发/冲突**：同一个 User Data 同时只能有一个实例（SingletonLock），所以后台检测用 `offlineChain` 串行化；
  ego 正开着时**不走**这条路（会撞锁），改用原来的「同 profile 临时空间」探测（能顺带拿到当前页 URL，判登录页更准）。
  新增可选配置 `egoliteUserData`（留空自动探测 `%LOCALAPPDATA%\Citro Labs\ego lite\User Data`）。
- **定时检测**：不再因为「ego 没在运行」跳过（那条跳过逻辑和文案一起删了），到点照常检测、结果照常写回。
- **真机验证**（2026-10-31，ego 完全关闭，`tasklist` 显示 0 个 ego 进程）：
  - 淘宝店铺「韩品兰坊」/ Profile 2：`ok=true`，读 85 个 taobao cookie（共 2655），判定**已登录**，证据 `cookie2 / _tb_token_ / sgcookie / unb`，耗时 **2086ms → 1697ms**（优化后）。
  - 拼多多店铺「吸引隔热教授」/ Profile 3：`ok=true`，读 15 个 pdd cookie（共 16），判定**已登录**，证据 `PASS_ID / mms_b84d1838`，耗时 **1627ms**。
  - 两次读完立刻测进程：**0 个 ego 进程残留、0 个窗口**；`Profile 1/2/3` 的 `exit_type` 仍为 `Normal`（干净退出）。
- **界面文案**：设置页在「ego 没在运行」的提示里补了一句「检测不受影响：会在后台起一个无窗口实例读登录态，不弹窗」。
- 自检：`node test/smoke.mjs` **86 项全过**（新增「ego 关着也能后台检测」的回归断言：headless、指定 profile、端口回收、PID 树强杀、串行化、撞锁保护）。

**已知小概率冲突**：如果恰好在检测的那 1~2 秒里手动点开 ego，Chrome 的单实例机制可能把启动合并进隐藏实例（窗口没出来），再点一次即可。

## v0.8.1

用户问「现在还有什么bug吗，review一下」。我做了两路只读审查（宿主 `lib/index.js`+`lib/ego.mjs`，客户端 `lib/client.js`+`lib/cdp.mjs`+`lib/chrome.mjs`），
把挑出来的真实问题在这一版全修了；自检从 74 项加到 **86 项**（新增 11 条回归断言，外加 1 条 ego 没在运行时的确定性用例）。

- **① ego「关闭 / 交还控制权」会凭空建出一个窗口**。
  症状：点「关闭」反而多出一个 ego 窗口，界面却写着"已关闭"；更糟的是这个窗口落在**默认 profile** 上，下次「打开」会认领它 → 店铺串到别人的登录态。
  原因：关闭流程先 `acquire()` 拿句柄才判断"空间在不在"，而 `acquire()` 对不存在的空间是**新建**；新建完才发现该走 `alreadyClosed` 分支。
  现在：close / handoff 在拿句柄**之前**就判"空间不在 → 直接 alreadyClosed"，一个窗口都不会多。
- **② 检测「没测成」被当成「登录已失效」**。
  症状：ego 没开 / CLI 超时 / 无头浏览器起不来，界面上好好的「已登录」直接变红色「登录已失效」，逼着重新扫码。
  原因：失败结果 `{ok:false, loggedIn:false}` 被无条件写进 `lastCheck`，而界面只看 `lastCheck.loggedIn`，不看 `ok`。
  现在：统一收敛到 `checkPatch()` —— **失败不覆盖上次结论**，只记 `lastCheckError`；界面在还没有任何结论时显示灰色「检测失败」并带原因。
- **③ ego 没在运行时，「打开 / 重置」到不了拉起白名单**。
  症状：CHANGELOG 写着"只有 open/reset 允许顺带拉起 ego"，实际这两个动作直接报"ego lite 没在运行"。你上次说"默认打开就好"，但那条路其实是断的。
  原因：`openAccount` → `egoRunInfo` → `ensureEgoProfile` 里先抛了"没在运行"，根本走不到 `LAUNCH_ALLOWED`。
  现在：新增 `ensureEgoApp()`，open/reset 传 `{ launch: true }`：先拉起 ego（最多等 12 秒），再建空间；只读动作（检测/列状态/关闭）依旧绝不拉起浏览器。
- **④ 排期「预检跳过」也会消耗掉当天的那个时间点**。
  症状：排期 09:00，ego 关着 → 跳过；09:05 打开 ego → 这天再也不检测了。
  原因：`markRan()` 写在所有预检之前，跳过也算"跑过"。
  现在：先抢店铺锁、确认真要执行了才记账；抢不到锁 / ego 没开 / 浏览器开着 / 等登录这些预检跳过都不消耗时间点（真正的执行失败仍算跑过，避免每 20 秒重试把浏览器起爆）。
- **⑤ 请求体读一半客户端断开 → 账号锁永久泄漏**。
  症状：关设置面板/刷新页面时正发起某个动作，那家店之后所有操作都"点了没反应"，只能重启宿主。
  原因：路由先取锁再读 body，而 `readJsonBody` 只监听 `end`/`error`，客户端中断只有 `aborted`/`close` → Promise 永不 settle → `finally` 不执行。
  现在：补 `aborted`/`close` 兜底 reject，锁一定会释放。
- **⑥ 设置页「浏览器设置」面板被父级轮询反复卸载重建**。
  症状：打开的 `<details>` 自己收起（待登录的店铺每 2.5 秒收一次）、正在输入的路径被服务器值回填、按钮忙态被清（「更新到最新」还能被连点两次）。
  原因：`ConfigPanel` 定义在 `ShopAccountsSection` 函数体里，每次重渲染组件身份都变。
  现在：提到同一层作用域，配置/回调全部走 props；折叠状态和输入不再被打断。
- **⑦ Chrome 后端「运行中检测」挑错标签页**。
  症状：明明已登录，点「检测」判成"登录已失效"，Chrome 后端「完成并保存」也拒绝保存。
  原因：`getAllCookies` 拿 `/json/list` 里**第一个 https 标签**的 URL 当判定依据，而 `--restore-last-session` 恢复出来的旧登录页排在前面时，"登录页优先"的判据直接判死。
  现在：新增 `pickSiteUrl()`，优先「本平台域名 + 不像登录页」的标签页，运行中的检测和 `waitForIdentityCookies` 都改用它。
- **⑧ 改名会清掉用户手填的 egoSpace**：比较条件写成了 `egoSpace === spaceNameFor(account)`，而 `spaceNameFor` 在 egoSpace 非空时返回它自己 → 恒为真。现在拿派生名 `'店铺-' + 名字` 比较，手填的空间名保留。
- **⑨ 删账号时留 ego 孤儿窗口**：ego 后端删除账号现在先 `egoCloseAccount` 收掉空间（收不掉也不影响删记录）。
- **⑩ agent 工具 `list` 的 index 在带 platform 过滤时指错店铺**：`index` 改为全表下标（字母序号「店铺B」是按全表解析的）。
- **⑪ `/state` 串行探端口太慢**：Chrome 模式下店铺一多，串行 `browserUp` 会比前端 2.5 秒轮询还慢导致请求堆积。现在先并发探一遍端口。
- **⑫ 详情页端口为 0 时渲染出字面量 `0`**：`a.port && …` 在 0 时求值为 0，React 当文本渲染。改成三元。
- **⑬ 排期弹窗把「自动每组店铺数」回填成手填值**：打开一次再保存就把 auto 静默改成固定值。现在读 `groupSizeMode`，auto 时留空。
- **⑭ 编辑弹窗关闭后不刷新列表**：改名/改备注/勾选删档案后界面留着旧数据（服务端可能已删），点进去一律 404。现在关弹窗时 `load(true)`。
- **⑮ 导入一份已登录的档案，还是被送去登录页**：创建后无条件按 `mode:'login'` 打开并把 `pendingLogin` 又置回 true。现在服务端探测到已登录就按 `mode:'work'` 复用。
- **⑯ 检测用的临时空间残留会让那家店永久检测失败**：probe 超时/崩溃没有 `finish`，同名临时空间留在 ego 里，之后每次同名 `taskSpace` 可能报 NAME_IN_USE。现在 probe 开始前先把"自己上次残留的、ownership=agent 的同名空间"收掉。

验证：`node --check` 全绿；`node test/smoke.mjs` **86 项全过**（exit 0）。这一版没有新增设置项、没有新增 UI。

## v0.8.0

用户问「还有什么缺陷吗，在新的浏览器」，随后说「全修了」。这一版把 ego 后端的缺陷一次修完；
每条都写清**症状 → 原因 → 现在怎么做**。

- **① 点过「完成」的店铺被定时检测永久跳过**（最要命的一条）。
  症状：ego 模式下某家店点过「完成并保存」后，列表里的登录状态再也不更新。
  原因：v0.7.1 起「完成」故意不收掉空间（免得关掉你正在看的窗口），而定时检测的判断是「空间开着就跳过」——
  于是「完成」成了这家店的检测死刑。现在检测不再碰你那个空间：**同一个 profile 另开一个临时空间**读 cookie，
  读完 `finish({keep:[]})` 收掉（实测同 profile 的两个空间 cookie 罐是同一份，读到的结果完全等价）。
  实测：`probeOk=true`、读到 24 个 cookie、临时空间已收掉、用户的两个空间 id 前后不变。
- **② ego 关着时，任何一次「读状态」都会把整个浏览器拉起来**。
  症状：关掉 ego 后打开设置页/列表，ego 自己弹出来，恢复几十个标签、占 3 GB。
  原因：CLI 只要 app 没开就会顺带启动它（实测 5.7 s / 30 进程 / 3.0 GB），而插件每隔 30 秒刷新一次状态。
  现在所有 CLI 调用前先探测主进程（`tasklist`，实测 207 ms，5 秒缓存）：没在跑就直接返回 `ego_not_running`，
  只有 `open`（打开店铺）和 `reset`（重扫）在白名单里允许顺带拉起。界面在 ego 没跑时显示
  「ego lite 这会儿没在运行 —— 读不到 profile 列表」，并给一个 **「启动 ego」** 按钮（`POST /ego/start`，
  只 `spawn` 主程序，不建任何空间，实测 1.2 秒起来）。
- **③ 没有运行时降级**：以前只看 CLI 文件在不在。现在 `/state`、`/config`、`/ego` 都带 `running` 字段，
  ego 没跑时如实报 false；`ensureEgoProfile` 也会明确报「ego lite 没在运行，先在 ego 里打开它，或点启动 ego」。
- **④ 显式指定的 ego profile 被删了就永久打不开**：`ensureEgoProfile` 里 `if (explicit) return explicit;`
  不核对 profile 是否还存在。现在先拉一次真实 profile 列表核对，不在了就记 `ego-profile-gone`、清空重分配。
- **⑤ 账号重名**（ego 模式下等于串号）：店铺名就是 TaskSpace 名（`店铺-<名字>`），重名 → 两家店共用一个空间、
  登录态互相覆盖。现在 `POST /accounts` 与改名都在 ego 模式下查重并 400；
  改名时如果之前显式指定过空间名，会清掉 `egoSpace` 让空间按新名字重找。
- **⑥ 定时检测与手动操作并发互抢**：两个 ego CLI 同时对同一空间 `takeOver` / `finish`。
  现在每个账号一把锁（`acquireAccountLock` / `withAccountLock`）：路由层用 try/finally 确保放锁，
  定时检测用 `wait:false` 抢不到就跳过（记「这个店铺正在手动操作」）；agent 工具路径同样走锁。
- **⑦ 重置登录态会连坐清掉别的店铺**：`egoResetAccount` 原来走 `Network.clearBrowserCookies` 整仓清空，
  而两家 cookie 域不重叠的店可以共用一个 profile。现在按平台域名逐个 `Network.deleteCookies`
  并报 `cleared` 计数；一个都没删掉时才回退整仓清空，并带 `wholeJar:true` 让界面知道代价。
- **⑧ handOff 失败只记一笔、空间卡在「agent 调试中」**：现在失败重试 3 次（间隔 300 ms），成功后清掉 `handOffError`。
- **⑪ 空间只能按名字认**：ego 里用户自建空间的 `name` 是空串、`id` 是 `0`。现在 `findEntry` 先按名字、
  再按 `Number(spaceId) > 0 && s.id` 兜底（`id=0` 不参与匹配）；`/state` 与 agent 工具都带上 `egoSpaceId`。
- **⑩ 上架插件（dsh-plugin-pdd-product-listing）也交还控制权**：它的 `ego_adapter.cjs` 原来开完空间不提控制权，
  列表跑完 ego 一直显示「agent 调试中」。现在连接时若空间已交还（`agentDelegatedToUser`）先用
  `takeOverTaskSpace(id)` 收回，跑完在 `session.close()` 里 `handOff()` 重试 3 次。
  它仍然**保留空间和页面**让你接着检查/提交，只是把控制权还给你。
- 验证：`node test/smoke.mjs` **74 项全过**（新增 11 项：不拉起浏览器 / `/ego/start` 与「启动 ego」按钮 /
  同店串行锁 / 定时检测不再因空间开着跳过 / 重名拦截（含路由级 400 实测）/ profile 消失重分配 / 按域名删 cookie / 按 id 认空间 / 手动 handoff 补救路由 / 账号锁真并发互斥）。
  真机验证（ego lite 正在运行）：`egoAppRunning=true`(207 ms)、`egoList` 185 ms 且每条都带 `id/profileId/ownership`、
  `egoProbe` 用临时空间读到 24 个 cookie 且 2.5 s 内收掉、用户空间数量前后都是 2。
  `dsh-plugin-pdd-product-listing` 侧 `node --check` 干净、`test_pdd_flow.js` 13 通过 / 0 失败。

## v0.7.6

- **Chrome 模式下不再到处显示 ego lite 的信息**（用户问：现在很多 ego lite 的字样，用谷歌也会显示吗）。
  之前只有右上角胶囊是按后端变的，但折叠块里的 `ego-browser` 路径、`ego profile：…` 列表、
  「刷新 ego」按钮，不管用哪个后端都会画出来。现在统一挂在 `egoOn = backend === 'egolite'` 上：
  - Chrome 模式：不显示 ego-browser 字段、不列 profile（profile 名也算隐私）、没有「刷新 ego」按钮；
    只在后端下拉框下面留一句「已装 ego lite（N 个 profile）：切到「ego lite」才会用到它」，
    没装 ego 时是「没检测到 ego lite：只用 Chrome」。
  - 胶囊只留结论：`ego lite · N 个 profile` / `Chrome`，完整原因（例如「已装 ego，但设成了 Chrome」）放 title。
  - 后端下拉框的 `ego lite` 项在没装 ego 时**禁用**并标「（未安装）」，免得选了之后打开店铺才报错。
  - 顶部署名文案也按后端变：ego 模式说「用 ego lite」，Chrome 模式说「用 Chrome（没在用 ego lite）」。
- **清掉代码/文档里的个人路径**（用户要求 review 个人信息）：`CHANGELOG.md` 三处、
  `test/smoke.mjs` 一处写着 `C:\Users\<用户名>\…` 与本地诊断脚本名，`lib/client.js` / `lib/index.js`
  的「更新源目录」示例写的是本机目录名 `D:\dycopy\…`，`lib/cdp.mjs` 注释里有本机 Node 安装路径。
  全部换成 `D:\plugins\dsh-plugin-shop-accounts`、`<数据目录>`、`<本地诊断脚本>` 之类的占位符。
  顺带确认：代码里没有 cookie 值、手机号、邮箱、真实店铺名（`店铺A/B/C` 是模板写法），
  `package.json` 没有 author/repository 字段。
- 验证：`node test/smoke.mjs` **63 项全过**。新增一项**真渲染**测试（桩 React + 迷你 hook 运行时，
  会跑 effect、状态变了重渲）分别以 `backend=chrome` / `egolite` 渲染设置页，断言：
  Chrome 模式下渲染文案里没有 `ego-browser`、没有 `ego profile：`、没有「刷新 ego」，胶囊是 `Chrome`；
  ego 模式下三者都在，胶囊带 profile 数。另用 ego 打开本地预览页做左右对照截图。

## v0.7.5

- **修「折叠块里输入框根本没有间隔」**（用户反馈：路径/高级选项的输入框贴在一起，一点美感都没有）。
  之前间距只写在 CSS 类的 `gap` 上，样式表没跟上（热重载/缓存/旧版本 bundle）时整片输入框就挤成一坨；
  现在折叠块内部排版**全部走内联样式**，样式表失效也不会塌。
- 排版按三段重做，不再是「一长串同样间距的字段」：
  - 折叠块内距 `14px 16px`、块内行距 `16px`、组内字段行距 `12px`；
  - 分 `路径` / `Chrome 回退` / `信息` 三组，组标题小号大写字距，**组与组之间加一条发丝分隔线**；
  - 字段改成「标签左 104px + 输入框右」的两列网格（原来 150px 太宽），路径类输入框用等宽字体 11.5px；
  - 「探测到：Chrome 路径」从独立一行挪到 Chrome 输入框**正下方**（跟它说明的那个字段对齐）；
  - 右上角生效状态改成胶囊 `chip`；折叠箭头 `▸` 展开时旋转 90°，hover 变主色。
- 验证：真机渲染测量（ego 打开本地预览页，`getBoundingClientRect` 实测）——
  相邻输入框净距 **12.0px**、组间距 12px、无重叠、标签无裁剪、无横向溢出、输入框未溢出卡片，
  9 项布局断言全过（`output/taste/verify.json`）；`node test/smoke.mjs` 62 项全过
  （新增断言：折叠块行距 ≥14px、组内行距 ≥12px、必须有 `groupDividerStyle` 分隔线）。

## v0.7.4

- **设置页「浏览器设置」收成两行**（用户反馈：太冗余、不简洁）。默认只留最常用的两项：
  **`浏览器后端` 下拉 + 一行生效状态**（如 `生效：ego lite · 3 个 profile`）；
  `ego-browser` / `Chrome / Edge` 路径、`档案根目录`、`起始调试端口`、两个勾选项、
  ego profile 列表、数据目录，全部收进可折叠的 **「路径与高级选项」**（`<details>`，默认收起）。
- 顺手删掉的重复信息：Chrome 路径提示不再同时出现在字段和提示两处；「刷新 ego」的 toast
  从「ego 可用：3 个 profile · C:\…\ego-browser.exe」收成「ego 可用（3 个 profile）」；
  数据目录那条从常驻改成折叠块里一行。
- 验证：`node test/smoke.mjs` 62 项全过（新增断言：必须有折叠块，且「浏览器后端」在折叠块外、
  路径/端口等字段必须在折叠块内）。

## v0.7.3

- **修「点完完成，ego 还是显示 agent 调试中」**。根因在 ego 的 TaskSpace `ownership`：
  agent 建/接管的空间是 `agent`（ego 界面就显示「agent 调试中」），只有 `task.handOff()` 之后才变成
  `agentDelegatedToUser`（用户控制、界面正常）。我们之前只会「建空间 / 收空间」，**从来没交还过控制权**，
  所以空间一直挂在 agent 名下 —— 关窗口只是碰巧把它清理掉了，不是修好。
- 现在每个动作都按「先收回 → 干活 → 最后交还」走：
  - `open`（去登录/打开工作台）：导航完 → `handOff()`，窗口归你，你扫码不会看到「调试中」；
  - `probe`（检测）：若空间已交还，先 `takeOverTaskSpace(id)` 收回（ego 对交还后的空间会**硬停**浏览器命令，
    不收回来读不到 cookie），读完 cookie **再交还**；
  - `reset`（重扫）：清 cookie + 回登录页 → 交还；
  - `close`（关闭）：收回控制 → `finish({keep:[]})` 收掉空间（登录态仍在 profile 里）。
  新增 `egoHandOff()` + 运行时 `handoff` op，可单独把某个空间的控制权交还（用于清理早先被占住的空间）。
- 副作用（已在 README 写明）：检测/完成的那一两秒 ego 会短暂显示 agent 接管，做完立刻还给你。
- 验证：真机 ego 全链路（node 侧调用，非模拟）——
  `open` → `created:true, handedOff:true`、ownership=`agentDelegatedToUser`；
  `probe` → `tookOver:true, handedOff:true, cookies:15, closed:false`（空间保留）；再 `probe` 仍正常；
  `close` → `closed:true`、空间消失。`node test/smoke.mjs` **62 项**全过（新增 1 项：顺序必须是「读 cookie 之后才交还，
  且交还后不许再操作页面」）。

## v0.7.2

- **设置页「浏览器后端」文案收紧**（用户反馈：选项太长、不简洁）。三个选项从
  「自动（装了 ego lite 就用 ego，没有就用 Chrome）」这种长句，改成 **`自动` / `ego lite` / `Chrome`**；
  解释挪到下拉框的悬停提示（title）里，下面那行状态也压短成「生效：ego lite · 3 个 profile」。
  顺带把 `ego-browser CLI（留空 = 自动探测）` 收成 `ego-browser（留空 = 自动探测）`、profile 列表前缀收成 `profile：`。
- 验证：`node test/smoke.mjs` 61 项全过（在原有后端契约测试里加了断言：三个选项必须是短文案、说明必须在 title 里）。

## v0.7.1

- **ego 模式「完成并保存」不再关掉 TaskSpace**：点完「完成并保存」，那个空间会一直留着。
  用户提得对 —— ego 的空间是**独立窗口**，留着不影响正常用浏览器；而「关掉再重开」只是让登录态多走一次
  「落盘 → 读回」，纯属多余（那套 `关闭 → 复核` 是 Chrome 时代为了确认**会话级 cookie 真写进档案**才加的，
  ego 的 cookie 在 profile 里，不存在这个问题）。现在想收掉窗口请**显式点「关闭」**。
- finish 的返回值多了 `keptSpace: true` / `closed: false`，界面提示按后端分开说（「空间留着没关」vs「窗口已关闭」），
  `debug.log` 的 `finish` 条目也记 `keptSpace`。
- 顺带说明一个副作用（已写进 README）：空间开着时**定时检测会跳过这家店**（不打扰你手里的活）；
  想马上刷新状态点行内 `检测` —— 它只读 cookie，不会关窗口。
- 验证：`node test/smoke.mjs` **61 项**全过（新增 1 项：ego 的「完成」里不许再调用 `egoCloseAccount`）；
  真机 ego 实测：对一个**已经开着**的空间做 probe → `created:false, closed:false`、空间仍在（读到 15 个 cookie、
  页面没被跳走），显式 close 之后空间才消失。

## v0.7.0

- **浏览器后端改成可插拔，优先 ego lite**：新增 `lib/ego.mjs`，一个店铺 = **ego 里一个 profile + 一个 TaskSpace**
  （profile 是登录隔离单位，空间只是窗口），登录态就存在 ego 自己的 `User Data` 里，和你在 ego 里手点的完全同一份。
  没装 ego 时行为跟以前一模一样（Chrome/CDP，每店一份 `user-data-dir`）。
- 设置页新增 **浏览器后端**：`自动`（默认，探到 ego 就用 ego）/ `只用 ego lite` / `只用 Chrome`；切完立即生效，
  卡片上直接显示「当前实际用哪个」、探测到的 CLI、以及 ego 里的 profile 列表。新增 **刷新 ego** 按钮。
- `config.json` 多三项：`browser`（auto/egolite/chrome）、`egoliteCli`、`egoliteApp`；账号多两项：`egoProfile`、`egoSpace`。
- 新建账号时**自动分配一个没被占用的 profile**（优先非默认那个）；profile 用完了会明确报「先在 ego 里新建用户配置」——
  ego 的 SDK 只给列出/使用已有 profile，不能新建，这一点不糊弄。
- 登录态检测在店铺自己的空间里读 cookie（按平台域过滤、值截断），读完即收；**Chrome 后端不再去碰 ego 进程**，
  只有真的用 ego（或你手动点刷新）才读它的列表。
- 接口扩展：`GET /shop-accounts/ego`（profile/空间/CLI 探测结果）、`PUT /shop-accounts/config` 返回实际后端、
  `/state` 带 `backend` 与 `ego` 快照。
- 上架脚本怎么接：ego 模式传该店的 **profileId**（接口字段 `egoProfile`），空间名可传可不传；
  cookie 是 profile 级的，**只要 profile 对，空间名不同登录态也通**。Chrome 模式还是「端口 + 档案目录」。
- 验证：`node test/smoke.mjs` **60 项**全过（新增 ego 后端 7 项 + 客户端契约 1 项）；真机端到端（假宿主 + 真 ego）跑通
  建档 → 开空间 → 检测 → 关空间 → 切后端 → 删档，`egoList` 复查无残留空间；本机 ego profile 实测 3 个。

## v0.6.10

- **cookie 罐本地备份 + 启动补回**：解决「点窗口红叉关掉 → 再检测就未登录」（千牛）。
  真机 debug.log 证据（2026-10-19 08:24→08:25 UTC）：关窗前浏览器里有 86 个 cookie、`unb` 在；
  用户点红叉后重开，档案里只剩 42 个、`unb` 消失 → 站点直接按回登录页。
- 做法：读到「已登录」时把整罐 cookie 存到 `<档案目录>/dsh-session-cookies.json`（只在本机，含会话级 cookie 值）；
  每次启动浏览器（静默/定时/点「打开」）先走 CDP `Network.setCookies` 把**档案里缺的那些**补回去，再打开页面；
  **只补缺的**，不覆盖档案里已有的同名 cookie（档案里的更新）。
- `lib/cdp.mjs` 新增 `setCookies(port, cookies)`；`lib/index.js` 新增 `saveSessionCookies` / `restoreSessionCookies` /
  `rememberLiveCookies`，接入静默检测、手动检测、finish 关窗前、open 起窗后；`debug.log` 多记 `restore` 事件。
- 验证：`shop-accounts-diag/cookie-backup.mjs` 8 项全过（存罐子 → 会话级 cookie 被过期 → 补回 → 页面认；
  档案里的新值不会被旧备份覆盖）；smoke 52 项。

## v0.6.9

- **加真机诊断日志**：`<数据目录>/debug.log`（默认 `<数据目录>\debug.log`）按时间顺序记下
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
  这次在用户登录的窗口上挂 CDP 监听（`<本地诊断脚本>`），
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
- 验证：`node test/smoke.mjs` 50 项；`<本地诊断脚本>`
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
