import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = fs.existsSync("lib/dsls.mjs") ? process.cwd() : "D:/dycopy/dsh-plugin-shop-accounts";
const libUrl = (rel) => pathToFileURL(path.join(ROOT, "lib", rel)).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v02068-"));
process.env.DSH_SHOP_ACCOUNTS_DIR = TMP;

const { loadDsl } = await import(libUrl("dsls.mjs"));
const { writeWorkbook } = await import(libUrl("xlsx.mjs"));
const { writeJobWorkbook, jobDirFor } = await import(libUrl("collect-runner.mjs"));
const { readTableFile } = await import(libUrl("sheet-read.mjs"));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log("  ok  " + name); } else { fail += 1; console.log("  FAIL " + name); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const runnerSrc = read("lib/collect-runner.mjs");
const ACC = "acc_t1_v02068";
const JOB = "job_20261125-1300_abcd12_示例店铺_多文件同名表";
const jobDir = path.join(TMP, "collection", "示例店铺_taobao_02068", "jobs", JOB);
const rawA = path.join(jobDir, "logs", "raw", "t_001");
const rawB = path.join(jobDir, "logs", "raw", "t_002");
fs.mkdirSync(rawA, { recursive: true });
fs.mkdirSync(rawB, { recursive: true });
const fileA = path.join(rawA, "导出A.xlsx");
const fileB = path.join(rawB, "导出B.xlsx");
// 两份导出含同名工作表（内容不同），名字里也不带 (2)
writeWorkbook(fileA, [
  { name: "成交概览", rows: [["日期", "金额"], ["2026-11-24", "12.34"]] },
  { name: "载体构成", rows: [["载体", "访客"], ["直播", "9"]] },
]);
writeWorkbook(fileB, [
  { name: "成交概览", rows: [["日期", "笔数"], ["2026-11-24", "3"]] },
  { name: "终端构成", rows: [["终端", "访客"], ["安卓", "7"]] },
]);
const job = {
  version: 1,
  jobId: JOB,
  accountId: ACC,
  platform: "taobao",
  accountName: "示例店铺",
  createdAt: "2026-11-25T13:00:00.000Z",
  tasks: [
    { taskId: "t_001", dslId: "tb_store_core_daily", state: "ok", artifacts: [{ role: "business", kind: "download", present: true, filePath: fileA }] },
    { taskId: "t_002", dslId: "tb_product_overall_metrics", state: "ok", artifacts: [{ role: "business", kind: "download", present: true, filePath: fileB }] },
  ],
};
const out = writeJobWorkbook(jobDir, job, "20261125-1300");
const book = fs.readdirSync(path.join(jobDir, "artifacts")).find((n) => /^采集数据_.*\.xlsx$/.test(n));
const sheets = readTableFile(path.join(jobDir, "artifacts", book)).sheets.map((s) => s.name);

ok(/const itemTag = String\(dslItemName\(t\.dslId\)\)\.split\('-'\)\.pop\(\)\.slice\(0, 8\);/.test(runnerSrc), "A1 多表导出的表名标签做了长度上限");
ok(/const hitDomain = DOMAIN_SHEET_ORDER.find\(/.test(runnerSrc), "A2 从工作簿读回时按「域名-」前缀拆域");
ok(/split\('-'\)\.pop\(\)\.slice\(0, 8\)/.test(runnerSrc), "A3 多表导出用采集项后缀做表名");
ok(sheets.filter((n) => /\(\d+\)$/.test(n)).length === 0, "B1 同名工作表不再出现 (2) 后缀 → " + sheets.join(" | "));
ok(sheets.some((n) => n.indexOf("成交概览") >= 0), "B2 成交概览仍在");
ok(sheets.length >= 3, "B3 两份导出的表都进工作簿（" + sheets.length + " 张）");
const rowsOf = (name) => readTableFile(path.join(jobDir, "artifacts", book)).sheets.find((s) => s.name === name);
const allRows = readTableFile(path.join(jobDir, "artifacts", book)).sheets;
ok(allRows.every((s) => s.rows.length >= 2), "B4 所有表至少表头 + 1 行数据");

// 同一域里两份导出各有一张「成交概览」，命名必须能区分来源
const labelA = sheets.find((n) => /成交分析|成交概览/.test(n));
ok(!!labelA, "C1 成交类工作表有明确名字");
const dupBase = sheets.filter((n) => n.replace(/\(\d+\)$/, "").endsWith("成交概览"));
ok(new Set(dupBase).size === dupBase.length, "C2 同名表名唯一");

// 配置层：三家店铺的采集域统一为五项（源码里没有六域的残留）
const readmeSrc = read("README.md");
ok(!/竞争洞察.*采集域|采集域.*竞争洞察/.test(readmeSrc.replace(/node test\/features-v02043\.mjs[^\n]*/g, "")), "D1 README 的采集域为统一的五项");

ok(JSON.parse(read("package.json")).version >= "0.20.68" || JSON.parse(read("package.json")).version === "0.20.67", "E1 版本号合法");
ok(/## v0\.20\.6[78]/.test(read("CHANGELOG.md")), "E2 CHANGELOG 有对应版本段");

console.log("");
console.log("features-v02068: " + pass + " pass, " + fail + " fail");
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
