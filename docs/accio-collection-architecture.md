# Accio 的数据采集是怎么做的（逆向记录）

> 对象：Accio Work 的 `ecommerce-automation-toolkit` 插件 / `ecommerce-data-collect` skill。
> 证据来源（2026-11 本机实测，只读）：
> - `~/.accio/accounts/<id>/plugins/installed/ecommerce-automation-toolkit/skills/ecommerce-data-collect/`（**全明文**：SKILL.md、120 份 DSL、10 个 Python 脚本、4 篇 references）
> - `~/.accio/accounts/<id>/plugins/data/cli-tools/.../bin/ecomctl.exe`（Go 静态编译，`--help`/`schema` 可读契约）
> - `~/.accio/data/plugins/commerce-domestic/ecommerce.db`（SQLite：3675 指标 / 497 主题 / 224 数据源）
> - `D:\Accio\resources\app.asar` → `out/main/gateway-worker.js`（宿主工具 `browser_rpa_launch` 与采集提示词模板）
>
> 本文只记录**机制与设计**，不搬它的加密资产（RPA locator/convert 是上架用的，与采集无关）。

---

## 一、结论先说：它不是"写死抓取代码"，是"配方 + 编排 + 原生执行"

```
ecomctl domestic collection plan        ← 算缺口：COLLECTION_REQUIRED + await_collect[]
        ↓  (source_type=rpa 才有下游)
collect_pipeline.py prepare             ← 一次读 request：fresh plan、批量填参、任务比较、返回第一批 tool_args
        ↓
browser_rpa_launch × N（同一消息并发）    ← 宿主的原生工具，按 DSL 跑页面，返回 artifacts
        ↓
collect_pipeline.py advance             ← 收齐回执、失败统一重试一次、末批自动后置
        ↓
collect_artifacts.py → collect_importer.py → ecomctl collection import-batch
        ↓
CLI 负责解析/归一/质量校验/入库（覆盖台账 + 业务表）
```

关键点：**采集执行不在插件里，而在宿主（Electron 主进程）里**。插件的 Python 脚本从不启动浏览器，
它只产出 `tool_args`；真正点页面的是宿主工具。所以：

- 站点改版 → 改 DSL 数据（JSON），不动代码；
- 采集要登录态 → 宿主按 `platformId/storeId/storeAccountId` 选 store-auth profile，与账号管理是同一套档案；
- 失败可恢复 → job 目录 + revision + 锁，`status_call` 只读查状态，未知提交不重投。

---

## 二、DSL：一份配方的结构

以 `dsls/taobao/tb_shop_overview.json`（生意参谋店铺概览 30 天趋势）为例，删繁就简后：

```jsonc
{
  "schemaVersion": "multi-platform-rpa-execution-new.dsl-spec.v1",
  "id": "tb_shop_overview",
  "platform": "taobao",
  "conditions": { "time": { "kind": "range", "bindings": { "{dateRange}": "$condition.encoded" } } },
  "template": {
    "defaults": { "timeoutMs": 15000, "retries": 0, "stepGapMs": 200 },
    "steps": [
      { "action": "goto", "url": "https://sycm.taobao.com/portal/home.htm",
        "after": [ { "action": "waitFor", "target": [/* 关弹窗按钮 */], "state": "visible", "optional": true },
                   { "action": "click", "target": [/* 同上 */], "optional": true } ] },
      { "action": "waitTimeout", "ms": 3000 },
      { "action": "readPageUrl", "outputKey": "login_guard_entry_url" },
      { "action": "when",
        "condition": { "kind": "element", "target": [ /* 4 种登录框形态：placeholder 输入框 / iframe#alibaba-login-box / login.taobao.com iframe / #fm-login-id */ ], "state": "visible", "timeoutMs": 8000 },
        "then": [ { "action": "assertElement", "state": "hidden",
                    "id": "...:LOGIN_REQUIRED__do-not-retry__未登录或登录态失效",
                    "target": [/* 同候选 */], "onError": "fail" } ] },
      { "action": "goto", "url": "https://sycm.taobao.com/portal/coreIndex/new/trend/v3.json?dateType=day&dateRange={dateRange}" },
      { "action": "waitFor", "target": [{ "by": "css", "value": "pre" }], "state": "visible", "timeoutMs": 20000 },
      { "action": "readText", "target": [{ "by": "css", "value": "pre" }], "readMode": "textContent", "trim": true, "outputKey": "overviewResponse" },
      { "action": "readPageUrl", "outputKey": "finalUrl" }
    ]
  },
  "collection": {
    "schedule": { "mode": "trailing_window", "days": 30, "query_anchor": "end" },
    "artifacts": [ { "role": "business", "kind": "json_string", "output_key": "overviewResponse" } ]
  }
}
```

### 三个值得抄的写法

1. **进页面拿登录态，然后直接 goto 站内 JSON 接口**
   它不点报表、不下载 Excel、不解析表格 —— `goto` 首页建立会话（顺手清弹窗），
   再 `goto` 那个页面背后的 XHR 接口（`trend/v3.json?dateType=day&dateRange=...`），
   从 `pre` 里读 JSON 文本。接口比 DOM 稳得多，产物也天然是结构化数据。

2. **登录守卫用「断言必然失败」来短路**
   `when` 命中登录框 → `then` 里断言同一个元素 `state: hidden`（必然失败，`onError: fail`），
   于是整条 DSL 以那个 step id 里的 `LOGIN_REQUIRED` 结束。用失败传递错误码，不需要 if/throw 语义。
   它还特别注明：`when` 的 `frame` 必须放在 `condition` 内部（顶层 `frame` 会被忽略、跨域表单永远探不到）。

3. **时间窗口只声明、不询问**
   `schedule: { mode: trailing_window, days: 30, query_anchor: end }` + `conditions.time.bindings`，
   占位符 `{dateRange}` 由编排脚本填成 `YYYY-MM-DD|YYYY-MM-DD`（URL 里编码成 `%7C`）。
   Agent 从不被问日期；`param_spec` 只对真正需要业务参数（如 `productId`）的 DSL 暴露参数。

---

## 三、动作词表（120 份 DSL 的真实使用频次）

| 动作 | 次数 | 说明 |
|---|---|---|
| `waitTimeout` | 753 | 固定等 |
| `click` | 559 | 点击（target 是候选数组，先命中先用） |
| `waitFor` | 497 | 等元素到某状态 |
| `assertElement` | 315 | 断言元素状态（登录守卫的关键） |
| `when` | 242 | 条件分支（条件只有 `element` 一种 kind） |
| `runScript` | 204 | 页面内脚本 |
| `scrollIntoView` | 159 | 滚动到元素 |
| `press` | 139 | 按键（Enter/Escape 关弹窗） |
| `goto` | 125 | 导航 |
| `type` | 105 | 填值 |
| `readPageUrl` | 85 | 读落地 URL（登录诊断取证） |
| `readText` | 83 | 读元素文本 |
| `downloadFile` | 83 | **浏览器下载落盘** |
| `clickAndWait` | 66 | 点完等一会 |
| `queryAll` | 56 | 批量抓列表 |
| `waitForLoadState` | 32 | 等 DOM/load |
| `hover` | 26 | 悬停 |
| `if` / `while` | 24 / 24 | 条件/循环 |
| `assertText` | 20 | 断言文本 |
| `readAttribute` | 4 | 读属性 |
| `scrollToBottom` | 2 | 滚到底 |

产物声明：`json_string` 2、`raw_envelope` 27、`download_ref` 4。
调度模式：`period` 26、`snapshot` 1、`trailing_window` 2、`per_day` 2。

---

## 四、编排与并发（`references/concurrent-collection-execution.md`）

- **分组并发**：按 `platformId/storeId/storeAccountId` 定 Profile，每 3 个 Profile 一组，
  同组每个 Profile 一批最多 5 个 DSL，合并最多 15 项；`data.parallel=true` 是给 Agent 的并发指令，**不是**工具入参。
- **一次并发发起**：同一条助手消息里发 N 次独立 `browser_rpa_launch`，每次**完整照传**该项的 `tool_args`
  （含 dslPath 的中文/空格、账号三元 ID、URL、items、closeOnFinish），不摘抄、不重拼、不塞进一次调用的 items 里串行。
- **全返回再推进**：本批所有调用返回（成功失败都算）后，执行一次 `advance_call`；不逐项准备、不轮询、不手写回执。
- **重试只有一轮**：首轮明确 failed 且**没采到业务数据**的项统一重试一次；
  `partial` 只要拿到声明的业务产物（真下载文件存在 / outputs 有值）就不重试；
  **空数组/空 outputs 表示业务无数据，不是失败**。
- **恢复**：job 目录 + `revision` + 锁；`status_call` 只读；已发调用/未知导入按原 toolCallId 回收，绝不重投。
- **类型分流**：`source_type=rpa` 才由 Agent 调 `browser_rpa_launch`；
  `api` 或其它类型 → 标 `capability_unavailable` 并保留原因，**不许猜命令、不许改成 RPA**。

---

## 五、宿主工具 `browser_rpa_launch`（节选）

参数（schema 实测）：`type`、`platform`、`platformId/storeId/storeAccountId`（三者一起才能选 Profile）、
`platformName/storeName/account`（**仅诊断展示，不用来选 Profile**）、`dataPaths`（1–5 个 JSON 对象文件）、
`url`、`closeOnFinish`（默认 false，只关当前页）、`closeBrowserOnFinish`（默认 true，整个队列跑完关掉隔离浏览器）、`items`、`generation`。

说明里有几条硬规矩：
- Profile 由三元 ID 唯一确定；同店重叠调用共享 Runtime 管理的隔离浏览器，但各自独立 RPA 页会话；
- `closeOnFinish` 只关当前页，`closeBrowserOnFinish` 管整浏览器；
- 有 `browser_rpa_launch_batch`（不可变计划 `browser-rpa-batch.plan.v2`，最多 5 个并发，重复同一 plan 复用 journal，完成/不确定的执行绝不重放）；
- 平台白名单里 `ecomctl` 前缀被允许且 `bypassSandbox: true`（采集 CLI 要能自由跑）。

---

## 六、Agent 侧的提示词（宿主模板原文，`gateway-worker.js`）

Accio 生成采集任务的提示词就是这段（对 `platformId` 做 1688/国际站分支）：

```
ecommerce-data-collect

使用这个skill，采集{平台}店铺"{店名}"的以下数据：“经营总览”（采集目录：“经营总览”，domain_id=taobao-scheduler-经营总览）、…

界面名称用于解释范围，实际采集使用上面明确传入的内部 domain_id。逐个目录调用 collection plan --domain-id，
合并并去重 await_collect 后执行；不要使用 --all-domains 扩大范围，也不要把界面名称当作目录 ID。
每个目录包含全部下级目录及其已接入的数据源，具体指标以当前平台采集计划为准。
采集范围固定为执行当天本地时区的最近 30 个完整自然日（从 30 天前到昨天，含首尾，不含今天），无需再询问日期范围。
先通过 CLI 生成采集计划，仅执行计划中尚未覆盖的采集项。
```

Connector（1688 / 国际站）走另一条：

```
请使用最新 ecommerce-data-collect skill 自动完成{1688|国际站}近30天数据采集入库，总并发8。
参数、分页及数据源选择遵循skill，账号和token由Gateway自动获取，无需手动绑定。
```

我们能直接学的四点：
1. 明说「界面名只是解释，实际用内部 domain_id」；
2. 明说「逐目录 plan 再合并去重，**不要 --all-domains**」；
3. 日期范围写死成"最近 30 个完整自然日（含首尾不含今天）"，不问用户；
4. 明说「只执行 plan 里尚未覆盖的项」（配合覆盖台账）。

---

## 七、我们学了多少（v0.13.0 落地）

已实现 `lib/rpa.mjs`（编译器 + 哑执行器 + 三种 driver）与 `lib/dsls.mjs`（配方库存）：

| 能力 | 状态 |
|---|---|
| DSL 解析 / 时间窗口 / `{dateRange}` bindings / 残留占位符校验 | ✅ |
| `goto / waitTimeout / waitFor / readText / readPageUrl / click / when / assertElement` | ✅ |
| `scrollIntoView / scrollToBottom / type / hover / readAttribute / queryAll / assertText / clickAndWait / waitForLoadState / press / if / while / runScript / evaluate` | ✅ |
| 登录守卫 → `LOGIN_REQUIRED`、`optional/onError:continue` 语义、trace 逐步记录 | ✅ |
| 产物声明（`artifacts`）与"空产物=业务无数据，不重试" | ✅ |
| Chrome 后端（CDP driver）与 ego 后端（运行时哑执行器 `EGO_EXECUTOR_SOURCE`） | ✅ |
| 配方库存：自带 3 份种子 + 自动发现本机 Accio 的 120 份（`SHOP_ACCOUNTS_DSL_DIR`） | ✅ |
| `GET /rpa/dsls`、`POST /accounts/:id/collect-run`、工具 `rpa-dsls` / `collect-run`、原始产物落盘 | ✅ |
| `downloadFile`（83 处 / 50 份 DSL 依赖浏览器下载落盘） | ✅ v0.14.0：设下载目录 + 轮询落盘 + `download_ref` 产物 |
| 编排层（job 目录 / revision / 分批 / 一次重试 / 交付） | ✅ v0.14.0 `lib/collect-runner.mjs`（单店串行批；多店并发未做） |

覆盖率实测（对 120 份真实 DSL，给定日期参数后离线编译）：

- 可完整编译执行：**67 份**（v0.14.0 起含下载型）
- 需要业务参数（`productId` 等，传入后即可）：**51 份**
- ~~需要浏览器下载落盘：50 份~~ → v0.14.0 已支持
- 其它不支持动作：2 份

所以 v0.14.0 的定位是：**JSON 接口型与下载报表型都能自己跑**（淘宝/京东/拼多多概览、
商品明细导出这类）；真正的多店并发（他那种每 3 个 Profile 分组）与指标级归一化仍未做。

---

## 八、与 v0.11/v0.12 的关系

- v0.11.0 学了它的**数据契约**：`plan → collect → import → query` + 覆盖台账 + 空结果也记台账。
- v0.12.0 学了它的**目录模型**：平台 → 采集域 → 指标（3045 条骨架）。
- v0.13.0 学它的**执行层**：DSL 配方 + 引擎 + driver。三层拼起来，链路才通：
  目录告诉你"该采什么"，plan 告诉你"缺哪天"，DSL 告诉你"页面上怎么走"。
