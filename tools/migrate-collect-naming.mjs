#!/usr/bin/env node
/**
 * 把已经采到的数据整理成新的命名规范（v0.20.18）。
 *
 *   node tools/migrate-collect-naming.mjs            # 直接整理
 *   node tools/migrate-collect-naming.mjs --dry      # 只打印将要做的改动
 *   node tools/migrate-collect-naming.mjs <目录>      # 指定数据目录（默认取插件的数据目录）
 *
 * 做四件事：
 *   1. 作业目录 job_<旧随机 id> → job_<YYYYMMDD-HHmm>_<随机 6 位>（按 job.json 的 createdAt 换算），
 *      并把 job.json 里的 jobId 改写成新 id，接口与旧记录仍然对得上。
 *   2. 产物文件 <原始文件名> → <dslId>_<YYYYMMDD-HHmm>_<原始文件名>（dslId 从同目录的 t_XXX.json 里取）。
 *   3. 每个作业补写 artifacts/manifest.json（这次交付了哪些文件、各多少字节）。
 *   4. 按保留上限清理：有数据的留最近 20 次，只有失败/空数据的留最 3 次。
 *
 * 只改目录名与文件名，不动采集记录本身；全程走 rename，不复制、不重写大文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../lib/store.mjs';
import { readableJobId, runStamp } from '../lib/collect-runner.mjs';

const READABLE = /^job_\d{8}-\d{4}_[a-z0-9]{3,12}$/;
const KEEP_OK = 20;
const KEEP_FAILED = 3;

const dry = process.argv.includes('--dry');
const explicit = process.argv.slice(2).find((a) => a && !a.startsWith('--'));
const collectionDir = explicit && fs.existsSync(explicit) ? path.resolve(explicit) : path.join(dataDir(), 'collection');

if (!fs.existsSync(collectionDir)) {
  console.error('没有找到采集数据目录：' + collectionDir);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
}

const report = { collectionDir, dry, renamed: [], artifacts: [], manifests: [], pruned: [], skipped: [] };

/** 作业目录改名（旧随机 id → 可读 id），返回新目录与 job 对象。 */
function renameJobDir(jobDir, jobFile) {
  const job = readJson(jobFile);
  if (!job) {
    report.skipped.push({ dir: path.basename(jobDir), reason: 'job.json 读不出来' });
    return null;
  }
  const current = String(job.jobId || path.basename(jobDir));
  if (READABLE.test(current)) {
    job.jobId = current;
    return { jobDir, job };
  }
  const created = new Date(job.createdAt || Date.now());
  const tail = String(path.basename(jobDir)).split('_').pop() || '';
  const nextId = readableJobId(created, tail);
  const nextDir = path.join(path.dirname(jobDir), nextId);
  if (fs.existsSync(nextDir)) {
    report.skipped.push({ dir: path.basename(jobDir), reason: '目标目录已存在：' + nextId });
    return null;
  }
  report.renamed.push({ from: path.basename(jobDir), to: nextId });
  if (dry) return { jobDir, job, nextId };
  fs.renameSync(jobDir, nextDir);
  job.jobId = nextId;
  writeJson(path.join(nextDir, 'job.json'), job);
  return { jobDir: nextDir, job };
}

/** 把 artifacts/t_XXX 下的文件改成 <dslId>_<时间>_<原名>，并同步写回 t_XXX.json。 */
function renameArtifactFiles(jobDir, job) {
  const artRoot = path.join(jobDir, 'artifacts');
  const stamp = runStamp(new Date(job.createdAt || Date.now()));
  const dirs = listDirs(artRoot);
  let renamed = 0;
  for (const name of dirs) {
    const taskJsonFile = path.join(artRoot, name + '.json');
    const taskJson = readJson(taskJsonFile);
    const dslId = String((taskJson && taskJson.dslId) || '');
    const prefix = dslId ? dslId + '_' + stamp + '_' : '';
    for (const fileName of listFiles(path.join(artRoot, name))) {
      if (!prefix || fileName.startsWith(prefix)) continue;
      const from = path.join(artRoot, name, fileName);
      const to = path.join(artRoot, name, prefix + fileName);
      if (fs.existsSync(to)) continue;
      report.artifacts.push({ job: path.basename(jobDir), task: name, from: fileName, to: prefix + fileName });
      renamed += 1;
      if (dry) continue;
      try {
        fs.renameSync(from, to);
      } catch (err) {
        report.skipped.push({ file: from, reason: String((err && err.message) || err) });
        continue;
      }
      if (taskJson && Array.isArray(taskJson.artifacts)) {
        for (const a of taskJson.artifacts) {
          if (!a || !a.filePath) continue;
          if (path.basename(String(a.filePath)) === fileName) {
            a.filePath = to;
            a.fileName = prefix + fileName;
          }
        }
        writeJson(taskJsonFile, taskJson);
      }
    }
  }
  return renamed;
}

/** 写这次作业的 manifest.json：交付了哪些文件、各多少字节。 */
function writeManifest(jobDir, job) {
  const artRoot = path.join(jobDir, 'artifacts');
  const files = [];
  for (const name of listDirs(artRoot)) {
    const taskJson = readJson(path.join(artRoot, name + '.json'));
    const dslId = String((taskJson && taskJson.dslId) || '');
    for (const fileName of listFiles(path.join(artRoot, name))) {
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(artRoot, name, fileName)).size;
      } catch { /* ignore */ }
      files.push({ taskId: name, dslId, fileName, bytes });
    }
  }
  const manifest = {
    version: 1,
    jobId: job.jobId,
    accountId: job.accountId,
    accountName: job.accountName,
    platform: job.platform,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || '',
    window: (job.plan && job.plan.window) || null,
    naming: '<dslId>_<YYYYMMDD-HHmm>_<原始文件名>',
    files,
    tasks: (job.tasks || []).map((t) => ({ taskId: t.taskId, dslId: t.dslId, state: t.state })),
  };
  report.manifests.push({ job: path.basename(jobDir), files: files.length });
  if (dry) return manifest;
  writeJson(path.join(artRoot, 'manifest.json'), manifest);
  return manifest;
}

/** 每个账号按保留上限清理。 */
function pruneJobs(accountDir) {
  const root = path.join(accountDir, 'jobs');
  const names = listDirs(root);
  const metas = names.map((name) => ({ name, job: readJson(path.join(root, name, 'job.json')) }));
  metas.sort((a, b) => String((b.job && b.job.createdAt) || '').localeCompare(String((a.job && a.job.createdAt) || '')));
  let ok = 0;
  let failed = 0;
  for (const m of metas) {
    if (!m.job || !m.job.finished) continue;
    const hasOk = (m.job.tasks || []).some((t) => t.state === 'ok');
    if (hasOk) ok += 1;
    else failed += 1;
    const over = hasOk ? ok > KEEP_OK : failed > KEEP_FAILED;
    if (!over) continue;
    report.pruned.push({ account: path.basename(accountDir), dir: m.name });
    if (dry) continue;
    try {
      fs.rmSync(path.join(root, m.name), { recursive: true, force: true });
    } catch (err) {
      report.skipped.push({ dir: m.name, reason: String((err && err.message) || err) });
    }
  }
}

for (const accountId of listDirs(collectionDir)) {
  const accountDir = path.join(collectionDir, accountId);
  for (const name of listDirs(path.join(accountDir, 'jobs'))) {
    const jobDir = path.join(accountDir, 'jobs', name);
    const moved = renameJobDir(jobDir, path.join(jobDir, 'job.json'));
    if (!moved) continue;
    if (dry) continue;
    renameArtifactFiles(moved.jobDir, moved.job);
    writeManifest(moved.jobDir, moved.job);
  }
  pruneJobs(accountDir);
}

console.log(JSON.stringify(report, null, 2));
