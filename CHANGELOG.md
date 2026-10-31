# 变更历史

> 每个版本都是在本机（Windows + Chrome）真机验过的；「验证」条目就是当时的实测证据，
> 数字都当真跑出来的看。自检项数指 `node test/smoke.mjs` 的条数。

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
