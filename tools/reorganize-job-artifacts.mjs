#!/usr/bin/env node
/**
 * v0.20.66：把旧的作业目录整理成新布局。
 *
 * 新布局：
 *   job_<时间>_<后缀>_<采集项>/
 *     ├─ job.json                     作业状态机（不动）
 *     ├─ artifacts/                  只放成品：采集数据_*.xlsx + manifest.json
 *     └─ logs/                       执行日志
 *         ├─ t_001.json ...          每个任务的执行记录（原来的 artifacts/t_001.json）
 *         └─ raw/t_001/ ...          原始导出文件（整理时清掉，只留成品表）
 *
 * 用法：
 *   node tools/reorganize-job-artifacts.mjs --dry      # 只报告，不动文件
 *   node tools/reorganize-job-artifacts.mjs            # 真整理
 *   node tools/reorganize-job-artifacts.mjs --keep-raw # 保留原始导出文件（只挪 json）
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../lib/store.mjs';

const JOB_ID_RE = /^job_[^\\/:*?"<>|]{4,120}$/;

function parseArgs(argv) {
  const out = { dry: false, keepRaw: false };
  for (const a of argv) {
    if (a === '--dry' || a === '-n') out.dry = true;
    else if (a === '--keep-raw') out.keepRaw = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else total += fs.statSync(p).size;
      } catch { /* ignore */ }
    }
  }
  return total;
}

function moveInto(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const inDest = path.join(destDir, path.basename(src));
  if (fs.existsSync(inDest)) fs.rmSync(inDest, { recursive: true, force: true });
  fs.renameSync(src, inDest);
}

function rewriteManifest(jobDir, keepRaw) {
  const file = path.join(jobDir, 'artifacts', 'manifest.json');
  if (!fs.existsSync(file)) return false;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  const keep = (f) => f && (/采集数据_/.test(String(f.fileName || '')) || String(f.kind || '') === 'xlsx');
  data.files = (data.files || []).filter(keep);
  if (keepRaw) data.rawFiles = data.rawFiles || [];
  else {
    data.rawFiles = [];
    delete data.rawFilesLocal;
  }
  data.layout = { artifacts: '成品（工作簿 + manifest）', logs: '执行日志与原始导出（原始导出交付后清理）' };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return true;
}

function hasWorkbook(jobDir) {
  try {
    return fs.readdirSync(path.join(jobDir, 'artifacts')).some((n) => /^采集数据_.*\.xlsx$/.test(n));
  } catch { return false; }
}

function planJob(jobDir) {
  const artDir = path.join(jobDir, 'artifacts');
  const logDir = path.join(jobDir, 'logs');
  const moveJson = [];
  const dropRaw = [];
  const keepFiles = [];
  let entries = [];
  try { entries = fs.readdirSync(artDir, { withFileTypes: true }); } catch { return { moveJson, dropRaw, keepFiles, freed: 0, missing: true }; }
  for (const e of entries) {
    if (e.name === 'manifest.json') continue;
    const full = path.join(artDir, e.name);
    if (e.isDirectory()) dropRaw.push(full);
    else if (/^t_\d+\.json$/.test(e.name)) moveJson.push(full);
    else keepFiles.push(full);
  }
  // logs/raw 下如果有原始导出目录，也一并清掉
  let freed = 0;
  const hasBook = hasWorkbook(jobDir);
  const keepRaw = !hasBook; // 没有成品工作簿的作业：原始导出是唯一数据来源，保留
  if (!keepRaw) for (const d of dropRaw) freed += dirSize(d);
  const rawRoot = path.join(logDir, 'raw');
  if (!keepRaw && fs.existsSync(rawRoot)) freed += dirSize(rawRoot);
  return { moveJson, dropRaw, keepFiles, freed, rawRoot, keepRaw, hasBook };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node tools/reorganize-job-artifacts.mjs [--dry] [--keep-raw]');
    return;
  }
  const root = path.join(dataDir(), 'collection');
  if (!fs.existsSync(root)) {
    console.log('没有采集数据目录：' + root);
    return;
  }
  const accounts = [];
  for (const acc of fs.readdirSync(root)) {
    const jobsRoot = path.join(root, acc, 'jobs');
    if (!fs.existsSync(jobsRoot)) continue;
    for (const name of fs.readdirSync(jobsRoot)) {
      if (JOB_ID_RE.test(name)) accounts.push(path.join(jobsRoot, name));
    }
  }
  let jobs = 0, movedJson = 0, droppedDirs = 0, freed = 0, keptFiles = 0, manifestFixed = 0, keptRawJobs = 0;
  for (const jobDir of accounts) {
    const plan = planJob(jobDir);
    if (plan.missing) continue;
    const hasWork = plan.moveJson.length || plan.dropRaw.length || fs.existsSync(plan.rawRoot);
    jobs += 1;
    movedJson += plan.moveJson.length;
    droppedDirs += plan.dropRaw.length;
    freed += plan.freed || 0;
    keptFiles += plan.keepFiles.length;
    if (plan.keepRaw) keptRawJobs += 1;
    if (!args.dry) {
      const logDir = path.join(jobDir, 'logs');
      for (const f of plan.moveJson) moveInto(f, logDir);
      const effectiveKeepRaw = args.keepRaw || plan.keepRaw;
      if (!effectiveKeepRaw) {
        for (const d of plan.dropRaw) fs.rmSync(d, { recursive: true, force: true });
        if (fs.existsSync(plan.rawRoot)) fs.rmSync(plan.rawRoot, { recursive: true, force: true });
      }
      if (rewriteManifest(jobDir, effectiveKeepRaw)) manifestFixed += 1;
    }
    if (!hasWork && args.dry) { /* 已是新布局 */ }
  }
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log((args.dry ? '[dry] ' : '') + '扫描作业 ' + jobs + ' 个');
  console.log('  执行记录 json → logs/：' + movedJson + ' 个');
  console.log('  原始导出目录（清掉）：' + droppedDirs + ' 个');
  console.log('  保留的成品文件：' + keptFiles + ' 个');
  if (keptRawJobs) console.log('  保留原始导出的老作业（没有成品工作簿，删了就丢数据）：' + keptRawJobs + ' 个');
  if (!args.dry) console.log('  重写 manifest：' + manifestFixed + ' 份');
  console.log('  可释放空间：' + mb(freed));
  console.log(args.dry ? '（只是预演，没有改动任何文件；去掉 --dry 才会真整理）' : '整理完成。');
}

main().catch((err) => {
  console.error('整理失败：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
