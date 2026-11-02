/**
 * dsls.mjs —— 采集 DSL 的本地库存（v0.13.0）。
 *
 * DSL 是采集配方（声明式页面步骤），来源与格式见 rpa.mjs 顶部说明。
 * 库存来自两处：
 *   1. 插件自带种子 `lib/rpa/dsls/<platform>/*.json`（3 份，够跑通链路）；
 *   2. 环境变量 `SHOP_ACCOUNTS_DSL_DIR` 指向的目录（可选）：指向任意外部配方库，
 *      这样第三方配方不用复制进本仓库也能直接用。
 *
 * 只做「发现 + 读文件」，不做任何网络请求；配方本身仍是数据，改配方不用改代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(HERE, 'rpa', 'dsls');

function walkJson(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJson(p, out);
    else if (e.name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

/** 额外 DSL 根目录：由环境变量 `SHOP_ACCOUNTS_DSL_DIR` 指定（不存在就当没有）。 */
export function externalDslRoot() {
  const env = String(process.env.SHOP_ACCOUNTS_DSL_DIR || '').trim();
  if (env && fs.existsSync(env)) return env;
  return '';
}

function readMeta(file, origin) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const steps = (raw && raw.template && raw.template.steps) || [];
    let hasDownload = false;
    const walk = (list) => {
      for (const s of Array.isArray(list) ? list : []) {
        if (String((s && s.action) || '').toLowerCase() === 'downloadfile') hasDownload = true;
        walk(s && s.then);
        walk(s && s.after);
      }
    };
    walk(steps);
    const sched = (raw && raw.collection && raw.collection.schedule) || {};
    return {
      id: String(raw.id || ''),
      platform: String(raw.platform || ''),
      description: String(raw.description || (raw.template && raw.template.description) || ''),
      days: Number(sched.days) || 30,
      scheduleMode: String(sched.mode || ''),
      artifacts: ((raw.collection && raw.collection.artifacts) || []).map((a) => String(a.output_key || '')),
      hasDownload,
      origin,
      file,
    };
  } catch (err) {
    return { id: path.basename(file, '.json'), platform: path.basename(path.dirname(file)), description: '', error: String((err && err.message) || err), origin, file };
  }
}

/**
 * 列可用的 DSL（种子 + 外部目录，同 id 时种子优先）。
 * @returns {{items: Array, seedDir: string, externalDir: string}}
 */
export function listDsls() {
  const byId = new Map();
  for (const file of walkJson(SEED_DIR)) {
    const meta = readMeta(file, 'seed');
    if (meta.id && !byId.has(meta.id)) byId.set(meta.id, meta);
  }
  const external = externalDslRoot();
  if (external) {
    for (const file of walkJson(external)) {
      const meta = readMeta(file, 'external');
      if (meta.id && !byId.has(meta.id)) byId.set(meta.id, meta);
    }
  }
  const items = [...byId.values()].sort((a, b) => (a.platform + a.id).localeCompare(b.platform + b.id));
  return { items, seedDir: SEED_DIR, externalDir: external };
}

/** 按 id 读一份 DSL 原文；找不到返回 null。 */
export function loadDsl(id) {
  const want = String(id || '').trim();
  if (!want) return null;
  const roots = [SEED_DIR, externalDslRoot()].filter(Boolean);
  for (const root of roots) {
    for (const file of walkJson(root)) {
      const meta = readMeta(file, 'seed');
      if (meta.id === want) {
        try { return { meta, raw: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return null; }
      }
    }
  }
  return null;
}
