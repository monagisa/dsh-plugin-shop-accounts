import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLATFORMS, normalizeAccountType, platformOf } from '../platforms.mjs';
import { applyCollectionResult, collectionPrompt, collectionRangeText, collectionReady, dueCollections, isCollectionDue, normalizeCollection } from '../collection.mjs';
import { importRecords, planCollection, queryRecords } from '../datastore.mjs';
import { catalogMetrics, unknownMetricIds } from '../catalog.mjs';
import { domainErrorFor, isBuyerAccount, prepareJobForAccount, runCollectionDsl } from '../collect-support.mjs';
import { advanceJob } from '../collect-runner.mjs';
import { artifactStatus } from '../rpa.mjs';
import { listDsls } from '../dsls.mjs';
import { schedSlotOf, scheduleView } from '../scheduler-run.mjs';
import { egoSpaceExists, egoSpaceName } from '../ego-backend.mjs';
import { checkAccount, quickLoginState } from '../login-state.mjs';
import { checkPatch } from '../login-check.mjs';
import { closeAccount, openAccount, resetAccount } from '../account-ops.mjs';
import { getPassword, hasPassword } from '../vault.mjs';
import { autoLogin } from '../autologin.mjs';
import { backendFor } from '../ego.mjs';
import { readConfig } from '../store.mjs';
import { loadAccounts, patchAccount } from '../accounts.mjs';
import { withAccountLock } from '../locks.mjs';
import { allowedDomains, domainOptions } from '../domains.mjs';

// ── agent 工具 ──────────────────────────────────────────────────────────────

/**
 * 取 `defineTool`：它不是恒等函数（要把 DSH 自有 schema DSL 编译成 JSON Schema 并建校验器），
 * 所以必须拿到宿主那一份。顺序同 dsh-douyin-comments 踩过的坑：
 *   1) 裸说明符（插件被拷进 profile 时可用）；
 *   2) `<DSH_HOME>/profiles/node_modules` 的拦截层 —— 全新 profile 里 pnpm 给插件装的
 *      那份 `@deepseek-ai/schemastery` 可能是旧版，裸说明符会命中错的；
 *   3) dsh 安装目录自带的副本（从 process.argv[1] 往上推，换机器也成立）。
 */
export let defineToolPromise = null;
export function loadDefineTool() {
  if (defineToolPromise) return defineToolPromise;
  defineToolPromise = (async () => {
    try {
      const mod = await import('@deepseek-ai/dsh-tools');
      if (typeof mod.defineTool === 'function') return mod.defineTool;
    } catch { /* 继续试绝对路径 */ }
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const candidates = [path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')];
    if (process.argv[1]) {
      const dshRoot = path.resolve(path.dirname(process.argv[1]), '..');
      candidates.push(path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
    }
    if (process.env.DTS_NODE_GLOBAL) {
      candidates.push(path.join(process.env.DTS_NODE_GLOBAL, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
    }
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.defineTool === 'function') return mod.defineTool;
      } catch { /* 继续 */ }
    }
    return null;
  })();
  return defineToolPromise;
}

/** 按名字/id/序号挑账号 —— 上架流程里说的是"店铺C"，这里要能吃下这种模糊输入。 */
export function pickAccount(input) {
  const accounts = loadAccounts();
  const q = String(input || '').trim();
  if (!q) return null;
  const byId = accounts.find((a) => a.id === q);
  if (byId) return byId;
  const exact = accounts.find((a) => (a.name || '') === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const soft = accounts.filter((a) => (a.name || '').toLowerCase().includes(lower) || (a.note || '').toLowerCase().includes(lower));
  if (soft.length === 1) return soft[0];
  const num = q.match(/^[A-Za-z\u4e00-\u9fa5]*?([A-Z])$/i);
  if (num) {
    const idx = num[1].toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < accounts.length) return accounts[idx];
  }
  return soft[0] || null;
}

export async function registerTool(ctx) {
  const defineTool = await loadDefineTool();
  if (!defineTool) {
    ctx.__shopAccountsToolError = '找不到 @deepseek-ai/dsh-tools 的 defineTool，工具 shop_accounts 未注册（设置页不受影响）';
    return null;
  }
  const tool = defineTool({
    name: 'shop_accounts',
    description:
      '电商店铺账号管理（淘宝/拼多多/抖音等）：列出已保存的店铺登录档案、打开某个店铺的浏览器、检测登录态，' +
      '并管理「数据采集」的配置（采集域 + 开关 + 时间，真正采集交给 agent/skill 执行）。' +
      '后端优先 ego lite（每个店铺一个 ego profile + 一个 TaskSpace，登录态按 profile 隔离），' +
      '没装 ego 时回退 Chrome（每店一份用户目录 + 一个调试端口，返回 cdpUrl）。' +
      '打开后：ego 后端返回 space/profileId（窗口已经在 ego 里开好），Chrome 后端返回 cdpUrl（如 http://127.0.0.1:9222）。' +
      '账号类型分卖家/买家：买家账号只做浏览与采集，不做上架。' +
      '注意：登录默认由用户在弹出的浏览器窗口里手动完成；action=autologin 会用本机加密保存的密码代填一次（需用户显式要求）。',
    // v0.17.9：宿主新版 tools.register 要求每个工具声明 output {schema, render}
    // （缺少 output 时 defineTool 直接抛 "Cannot read properties of undefined (reading 'render')"，
    //  工具就注册不上）。这里的返回值形状随 action 变化，所以用宽松的对象 schema，
    //  render 交回 JSON 文本 —— 模型看的还是同一份结果。
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'open', 'check', 'close', 'reset', 'collections', 'collect-prompt', 'collect-plan', 'collect-import', 'collect-query', 'collect-run', 'collect-done', 'collect-job', 'collect-advance', 'collect-status', 'collect-jobs', 'autologin', 'catalog', 'rpa-dsls'],
        required: true,
        description: 'list=列出店铺及其登录状态；open=打开店铺浏览器（返回 cdpUrl）；check=检测登录态；close=关掉店铺浏览器；reset=清空该店铺本地登录档案并重新打开登录页；'
          + 'collections=列出「今天该采集」的店铺及采集域（采集交给 skill 执行）；collect-prompt=取某店铺的采集任务提示词；'
          + 'collect-plan=算这个店铺某区间缺哪些天（返回 awaitCollect 清单，采之前先调它）；'
          + 'collect-import=把采到的记录写进本地数据层（逐条校验 + 去重 + 记覆盖台账，支持空结果只记台账）；'
          + 'collect-query=查已采集的数据（不用重采）；collect-done=回写采集结果（需 status: ok/partial/failed）；'
          + 'catalog=查某个平台/某个域的「可采指标清单」（指标名 + 度量类型 + 落库需要哪些字段）；'
          + 'rpa-dsls=列出本机可用的采集 DSL 配方（含是否依赖下载）；collect-run=按配方直接跑一次采集（返回原始产物，需自行归一化后 collect-import）；'
          + 'collect-job=开一个采集作业（分批返回 tasks，逐批回执推进）；collect-advance=提交本批回执并推进；collect-status=只读查作业；collect-jobs=列作业；'
          + 'autologin=用本机加密保存的密码代填一次登录（需用户显式要求）',
      },
      account: { type: 'string', description: '店铺名（支持部分匹配）或 account id。open/check/close 时必填；也接受「店铺A/店铺B」式的字母序号' },
      mode: { type: 'string', enum: ['work', 'login'], description: 'open 时用：work=打开平台工作台（复用登录态，默认）；login=打开登录页（重新登录）' },
      platform: { type: 'string', enum: PLATFORMS.map((p) => p.id), description: 'list 时按平台过滤' },
      silentCheck: { type: 'boolean', description: 'check 时用：true=用无头浏览器静默检测（不弹窗，几秒），false=只报告上次结果' },
      status: { type: 'string', enum: ['ok', 'partial', 'failed'], description: 'collect-done 时用：这次采集的结果' },
      note: { type: 'string', description: 'collect-done / collect-import 时用：一句话说明（失败原因 / 覆盖范围）' },
      // ── v0.11.0 采集数据层 / v0.12.0 目录层 ──
      domain: { type: 'string', enum: [...COLLECTION_DOMAINS, '竞争洞察'], description: 'collect-import / collect-query / catalog 时用：采集域（经营总览/流量转化/运营推广/商品供给/服务履约；淘宝天猫另有竞争洞察）' },
      domains: { type: 'array', items: { type: 'string', enum: [...COLLECTION_DOMAINS, '竞争洞察'] }, description: 'collect-plan 时用：只算这些域的缺口（不给就按账号的采集配置）' },
      start: { type: 'string', description: 'collect-plan / collect-query 时用：开始日期 YYYY-MM-DD（plan 不给就取最近 30 个完整自然日）' },
      end: { type: 'string', description: 'collect-plan / collect-query 时用：结束日期 YYYY-MM-DD' },
      coverageStart: { type: 'string', description: 'collect-import 时用：这次已采范围的开始日期（含），与 coverageEnd 成对；空结果必填' },
      coverageEnd: { type: 'string', description: 'collect-import 时用：这次已采范围的结束日期（含）' },
      period: { type: 'string', enum: ['h', 'd', 'w', 'm', 'y'], description: 'collect-import 时用：统计周期，默认 d（天）' },
      items: { type: 'array', items: { type: 'object' }, description: 'collect-import 时用：记录数组，每条 {bizDate, metric, value} 或 {bizDate, values:{指标:数值}}，可带 productId/extra/metricId（metricId 必须是 catalog 里该平台的指标）' },
      metric: { type: 'string', description: 'collect-query 时用：只看某个指标' },
      metricId: { type: 'string', description: 'collect-query 时用：按目录里的 metric_id 过滤' },
      dsl: { type: 'string', description: 'collect-run / rpa-dsls 时用：采集配方 id（如 tb_shop_overview；rpa-dsls 可列出全部）' },
      params: { type: 'object', description: 'collect-run 时用：配方需要的业务参数（如 {productId:"123456"}）' },
      timeoutMs: { type: 'number', description: 'collect-run 时用：整条配方执行预算（默认 300000 毫秒）' },
      // ── v0.14.0 采集作业 ──
      dslIds: { type: 'array', items: { type: 'string' }, description: 'collect-job 时用：要跑的配方 id 列表（不给就取该平台全部可跑配方）' },
      includeDownload: { type: 'boolean', description: 'collect-job 时用：是否包含依赖浏览器下载的配方（默认包含）' },
      skipCovered: { type: 'boolean', description: 'collect-job 时用：已采过的配方是否跳过（默认跳过）' },
      drive: { type: 'boolean', description: 'collect-job 时用：true=插件自己跑完全部批次（默认 false，只返回首批 tasks 让调用方执行）' },
      jobId: { type: 'string', description: 'collect-advance / collect-status 时用：作业 id（collect-job 返回）' },
      revision: { type: 'number', description: 'collect-advance 时用：回包里的 revision（防止重复推进）' },
      batchId: { type: 'string', description: 'collect-advance 时用：本批 batchId' },
      results: { type: 'array', items: { type: 'object' }, description: 'collect-advance 时用：本批回执 [{taskId, ok, code, outputs, artifacts, steps, finalUrl}]' },
      limit: { type: 'number', description: 'collect-query 时用：最多返回多少行（默认 500，上限 5000）' },
    },
    execute: async (args = {}) => {
      const action = String(args.action || 'list');
      if (action === 'list') {
        const backend = backendFor(readConfig());
        const all = loadAccounts();
        // index 用**全表下标**：`account` 参数支持「店铺B」这种字母序号，而字母序号是按全表解析的，
        // 若这里给过滤后的下标，带 platform 过滤时会指到别的店铺（v0.8.1 修）。
        const list = all
          .map((a, i) => ({ account: a, fullIndex: i }))
          .filter(({ account }) => !args.platform || account.platform === args.platform)
          .map(({ account: a, fullIndex: i }) => {
            const platform = platformOf(a.platform);
            return {
              index: i,
              id: a.id,
              name: a.name,
              platform: a.platform,
              platformLabel: platform ? platform.label : a.platform,
              accountType: normalizeAccountType(a.accountType),
              hasPassword: (() => { try { return hasPassword(a.id); } catch { return false; } })(),
              collection: normalizeCollection({}, a.collection || {}),
              // v0.18.11：买家账号不配采集（列表里也不显示"已配采集"）
              collectionReady: !isBuyerAccount(a) && collectionReady(a),
              collectionDue: isBuyerAccount(a) ? false : (() => {
                try { return isCollectionDue(a, new Date(), { time: schedSlotOf(a.id) }); } catch { return false; }
              })(),
              note: a.note || '',
              backend,
              port: backend === 'egolite' ? 0 : (a.port || 0),
              cdpUrl: backend === 'egolite' ? '' : (a.port ? `http://127.0.0.1:${a.port}` : ''),
              egoProfile: String(a.egoProfile || ''),
              egoSpace: backend === 'egolite' ? egoSpaceName(a) : String(a.egoSpace || ''),
              egoSpaceId: Number(a.egoSpaceId) || 0,
              opening: backend === 'egolite' ? egoSpaceExists(egoSpaceName(a), a.egoSpaceId) : false,
              lastCheck: a.lastCheck || null,
              lastLoginAt: a.lastLoginAt || null,
            };
          });
        return { ok: true, backend, count: list.length, accounts: list, hint: list.length ? '用 action=open + account=<店铺名> 打开某个店铺的浏览器' : '还没有店铺档案，请在「设置 → 账号管理」里新增店铺并登录' };
      }

      if (action === 'collections') {
        const all = loadAccounts();
        const schedView = scheduleView();
        const timeOf = (a) => schedSlotOf(a.id, { schedule: schedView });
        const due = dueCollections(all, new Date(), { timeOf });
        const rows = all
          .filter((a) => !isBuyerAccount(a) && (collectionReady(a) || due.some((d) => d.id === a.id)))
          .map((a) => ({
            id: a.id,
            name: a.name,
            platform: a.platform,
            accountType: normalizeAccountType(a.accountType),
            collection: normalizeCollection({}, a.collection || {}),
            due: due.some((d) => d.id === a.id),
            prompt: collectionPrompt(a),
          }));
        return {
          ok: true,
          count: rows.length,
          dueCount: due.length,
          accounts: rows,
          hint: due.length
            ? `有 ${due.length} 个店铺今天该采集。顺序：collect-plan 算缺口 → 采集 → collect-import 写回（空结果也要带覆盖区间）。`
            : '今天没有到期的采集任务（或采集开关都关着）。',
        };
      }

      const account = pickAccount(args.account);
      if (!account) {
        const names = loadAccounts().map((a) => a.name);
        return { ok: false, error: '没找到店铺：' + String(args.account || '(空)'), available: names };
      }

      if (action === 'open') {
        const mode = args.mode === 'login' ? 'login' : 'work';
        const r = await withAccountLock(account.id, () => openAccount(account, mode));
        const platform = platformOf(account.platform);
        const isEgo = r.backend === 'egolite';
        return {
          ok: true, alreadyRunning: Boolean(r.reused), account: account.name, mode,
          backend: r.backend || 'chrome',
          port: r.port, cdpUrl: r.cdpUrl, profileDir: r.profileDir,
          ...(isEgo ? { space: r.space, profileId: r.profileId, spaceId: r.spaceId, url: r.url } : {}),
          platform: account.platform, homeUrl: platform ? platform.homeUrl : '',
          hint: isEgo
            ? (mode === 'login'
              ? '登录页已经在 ego 的这个 TaskSpace 里打开了，请让用户在那个窗口里完成登录，然后点「完成并保存」'
              : '这个店铺的 ego 窗口已经开好（TaskSpace：' + r.space + '，profile：' + r.profileId + '），登录态直接复用，不需要重新扫码')
            : (mode === 'login'
              ? (r.reused
                ? '登录页已经在这个店铺已打开的 Chrome 窗口里新开了一个标签页，请让用户在那个窗口里完成登录，然后点「完成并保存」'
                : '已打开登录页，请让用户在弹出的 Chrome 窗口里完成登录，然后在「设置 → 账号管理」点「完成并保存」')
              : '可直接用这个 cdpUrl 复用登录态'),
        };
      }

      if (action === 'reset') {
        const r = await withAccountLock(account.id, () => resetAccount(account));
        if (r.ok === false) return { ok: false, account: account.name, error: r.error };
        // ego 后端没有「档案」这回事：清的是该平台域名下的 cookie，空间和 profile 都留着
        const isEgo = r.backend === 'egolite';
        return isEgo
          ? {
            ok: true, account: account.name, mode: 'login', backend: 'egolite', space: r.space, profileId: r.profileId,
            cleared: r.cleared, wholeJar: Boolean(r.wholeJar),
            hint: '这个店铺在 ego 里的登录 cookie 已按平台域名清掉，登录页已经打开；请让用户在那个窗口里重新登录，然后点「完成并保存」',
          }
          : {
            ok: true, account: account.name, mode: 'login', backend: 'chrome', port: r.port, cdpUrl: r.cdpUrl, profileDir: r.profileDir,
            removedProfile: true,
            hint: '这个店铺的本地登录档案已清空并重新打开登录页，请让用户重新扫码登录，然后点「完成并保存」',
          };
      }

      if (action === 'check') {
        const check = await withAccountLock(account.id, () => checkAccount(account, { silent: args.silentCheck === true }));
        patchAccount(account.id, checkPatch(check));
        return { ok: true, account: account.name, platform: account.platform, ...check };
      }

      if (action === 'close') {
        const r = await withAccountLock(account.id, () => closeAccount(account));
        return { ok: true, account: account.name, ...r };
      }

      if (action === 'collect-prompt') {
        return {
          ok: true,
          account: account.name,
          id: account.id,
          platform: account.platform,
          accountType: normalizeAccountType(account.accountType),
          collection: normalizeCollection({}, account.collection || {}),
          collectionReady: collectionReady(account),
          schedEnabled: account.schedEnabled !== false,
          schedTime: schedSlotOf(account.id),
          due: isCollectionDue(account, new Date(), { time: schedSlotOf(account.id) }),
          prompt: collectionPrompt(account, { domainMeta: domainOptions(account.platform) }),
        };
      }

      // ── v0.11.0：本地采集数据层（plan → collect → import → query）───────────
      if (action === 'collect-plan') {
        const range = collectionRangeText();
        const cfg = normalizeCollection({}, account.collection || {}, { allow: allowedDomains(account.platform) });
        const wantedDomains = Array.isArray(args.domains) && args.domains.length ? args.domains : cfg.domains;
        const badDomain = (Array.isArray(wantedDomains) ? wantedDomains : []).map((d) => domainErrorFor(account.platform, d)).find(Boolean);
        if (badDomain) return fail(badDomain);
        const plan = planCollection({
          accountId: account.id,
          platform: account.platform,
          domains: wantedDomains,
          start: args.start || range.start,
          end: args.end || range.end,
        });
        return {
          ok: true,
          account: account.name,
          id: account.id,
          platform: account.platform,
          ...plan,
          hint: plan.status === 'NO_COLLECTION_REQUIRED'
            ? '这段区间已经采全了（覆盖台账里都有记录），不用重复采集。'
            : '按 awaitCollect 里的 missing 去采；采完用 action=collect-import 写进来（记得带 coverageStart/coverageEnd，空结果也要带）。',
        };
      }

      if (action === 'collect-import') {
        const domErr = domainErrorFor(account.platform, args.domain);
        if (domErr) return fail(domErr);
        // metricId 必须是该平台目录里真实存在的指标（目录不可用时不拦）
        const badMetrics = unknownMetricIds(account.platform, (Array.isArray(args.items) ? args.items : []).map((x) => (x && x.metricId) || '').filter(Boolean));
        if (badMetrics.length) return fail(`这些 metricId 不在「${account.platform}」的目录里：${badMetrics.slice(0, 5).join('、')}（用 action=catalog 查这个平台可用的指标）`);
        const result = importRecords({
          accountId: account.id,
          platform: account.platform,
          domain: String(args.domain || ''),
          items: args.items,
          coverageStart: args.coverageStart,
          coverageEnd: args.coverageEnd,
          period: args.period || 'd',
          by: 'agent:shop_accounts',
          note: args.note || '',
        });
        if (result.ok) {
          // 顺手把「这次采完了」记回账号表（界面上的「上次采集」还用这套字段）
          const next = applyCollectionResult(account, {
            status: result.rejected.length ? 'partial' : 'ok',
            note: String(args.note || `导入 ${result.imported} 条${result.duplicates ? `，重复跳过 ${result.duplicates} 条` : ''}`),
            by: 'agent:shop_accounts',
          });
          patchAccount(account.id, { collection: next });
        }
        return { ok: result.ok !== false, account: account.name, ...result };
      }

      if (action === 'collect-query') {
        const domErr = domainErrorFor(account.platform, args.domain);
        if (domErr) return fail(domErr);
        const result = queryRecords({
          accountId: account.id,
          domain: args.domain || '',
          metric: args.metric || '',
          metricId: args.metricId || '',
          start: args.start || '',
          end: args.end || '',
          limit: args.limit || 500,
        });
        return { ok: true, account: account.name, id: account.id, ...result };
      }

      // ── v0.12.0 目录层：可采指标清单 ─────────────────────────────────────
      if (action === 'catalog') {
        const wantPlatform = String(args.platform || account.platform || '').trim();
        const platform = platformOf(wantPlatform);
        if (!platform) return fail(`未知平台：${wantPlatform}`);
        const domains = domainOptions(platform.id);
        const domain = String(args.domain || '').trim();
        if (domain) {
          const metrics = catalogMetrics(platform.id, domain);
          const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 2000);
          return {
            ok: true,
            platform: platform.id,
            platformLabel: platform.label,
            domain,
            domains,
            metricCount: metrics.length,
            returned: Math.min(metrics.length, limit),
            truncated: metrics.length > limit,
            metrics: metrics.slice(0, limit),
          };
        }
        return {
          ok: true,
          platform: platform.id,
          platformLabel: platform.label,
          domains,
          totalMetrics: catalogMetrics(platform.id).length,
          hint: '再带 domain=<域> 就是该域的指标清单；items 里带的 metricId 必须是这里的 id。',
        };
      }

      // ── v0.13.0 采集 DSL：库存 + 直接跑一份 ───────────────────────────────
      if (action === 'rpa-dsls') {
        const { items, seedDir, externalDir } = listDsls();
        const wantPlatform = String(args.platform || '').trim();
        const list = wantPlatform ? items.filter((d) => d.platform === wantPlatform) : items;
        return {
          ok: true,
          count: list.length,
          total: items.length,
          externalDir,
          seedDir,
          dsls: list.map((d) => `${d.platform}/${d.id}${d.hasDownload ? '（需下载，本版不支持）' : ''}`).slice(0, 200),
          hint: '用 action=collect-run + dsl 参数跑一份（如 collect-run dsl=tb_shop_overview）',
        };
      }

      if (action === 'collect-run') {
        const out = await runCollectionDsl(account, {
          dslId: args.dsl || args.dslId,
          start: args.start,
          end: args.end,
          params: args.params,
          timeoutMs: args.timeoutMs,
        });
        return out;
      }

      // ── 采集作业（v0.14.0 编排：prepare / advance / status）─────────────────
      if (action === 'collect-job') {
        const out = await prepareJobForAccount(account, {
          dslIds: Array.isArray(args.dslIds) ? args.dslIds : (args.dsl ? [args.dsl] : undefined),
          start: args.start,
          end: args.end,
          params: args.params,
          includeDownload: args.includeDownload,
          skipCovered: args.skipCovered,
          drive: args.drive === true,
        });
        if (!out.success) return { ok: false, errors: out.errors };
        return { ok: true, account: account.name, ...out.data };
      }
      if (action === 'collect-advance') {
        const out = advanceJob({
          accountId: account.id,
          jobId: args.jobId,
          revision: args.revision,
          batchId: args.batchId,
          results: args.results,
        }, artifactStatus);
        if (!out.success) return { ok: false, errors: out.errors, ...(out.data || {}) };
        return { ok: true, account: account.name, ...out.data };
      }
      if (action === 'collect-status') {
        return { ok: true, ...statusJob({ accountId: account.id, jobId: args.jobId }).data };
      }
      if (action === 'collect-jobs') {
        return { ok: true, account: account.name, ...listJobs(account.id).data };
      }

      if (action === 'collect-done') {
        const status = String(args.status || '').trim();
        const next = applyCollectionResult(account, { status, note: args.note, by: 'agent:shop_accounts' });
        const patched = patchAccount(account.id, { collection: next });
        return { ok: true, account: patched.name, collection: patched.collection };
      }

      if (action === 'autologin') {
        const pw = getPassword(account.id);
        if (!pw) return { ok: false, code: 'AUTOLOGIN_NO_PASSWORD', error: '这个店铺还没有保存密码（需要在设置页里先设置）', account: account.name };
        // v0.19.8：窗口里已经是登录状态时不做代填（否则会把页面导回登录页再登一遍）
        const already = await quickLoginState(account);
        if (already) {
          return {
            ok: true, skipped: true, code: 'AUTOLOGIN_ALREADY_LOGGED_IN', loggedIn: true,
            hint: '窗口里已经是登录状态，这次没有代填', login: already, account: account.name,
          };
        }
        const r = await withAccountLock(account.id, () => autoLogin(account, {
          password: pw, backend: backendFor(readConfig()), cfg: readConfig(),
        }));
        if (r && r.loggedIn) {
          const check = await withAccountLock(account.id, () => checkAccount(account, { silent: true })).catch(() => null);
          if (check) patchAccount(account.id, checkPatch(check));
        }
        return { ok: Boolean(r && r.ok !== false), account: account.name, ...r };
      }

      return { ok: false, error: '不认识的 action：' + action };
    },
  });
  const dispose = ctx.tools.register(tool);
  return typeof dispose === 'function' ? dispose : null;
}

/**
 * v0.16.0 一次性迁移：把老数据里「采集自己那套开关/时间」并到排期上。
 *
 * 老版本有两套东西说同一件事：账号的 `schedEnabled`（排期表里的开启/暂停）和
 * 采集配置里的 `collection.enabled` / `collection.time`。升级后调度只认 `schedEnabled`
 * （时间和槽位来自全局排期），所以：
 *   · `collection.enabled === false` **且真的选过采集域**（用户当年在采集卡片里配了域又关掉）
 *     → 迁移成 `schedEnabled:false`，行为保持不变，不会因为升级突然开始自动采集；
 *     ⚠️ 只看 enabled 是不够的：新建店铺时采集配置默认就是 `{enabled:false, domains:[]}`，
 *        按 enabled 判会把**所有**店铺都标成暂停。所以必须同时有域才算"用户明确关过"。
 *   · `collection.enabled === true` → 什么都不动（`schedEnabled` 默认就是开的）；
 *   · `collection.time` 不再影响调度，**留在数据里**不删（老版本降级回去还能看到原来的值）。
 * 幂等：只有真的需要改才写文件，跑几遍都一样。
 */
