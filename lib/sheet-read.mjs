/**
 * 读表格文件（v0.20.60）。
 *
 * 采集产物有两种：指标型（我们把页面文字解析成指标）和下载型（平台自己导出的表格）。
 * 「同店同天多域归集」要把下载型产物也并进同一份工作簿，所以需要把平台的 xlsx / csv 读回收成
 * 二维数组。这里不引入第三方库：
 *   - xlsx：直接解析 zip 中央目录 + inflateRawSync，再按 workbook.xml / rels 找到 sheet；
 *   - csv/tsv：用 TextDecoder（UTF-8 先试，失败再按 GBK，兼容生意参谋/阿里妈妈导出的 GBK 文件）。
 * 读不了的文件（老式 .xls 的 OLE2 二进制）返回 null，由调用方在「采集情况」里说明，不抛错。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(buf, entry) {
  const localOff = entry.localOff;
  if (!localOff || localOff + 30 > buf.length) return null;
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(raw); } catch { return null; }
  }
  return null;
}

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#([0-9]+);/g, (_m, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch { return ''; }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function textOfRuns(xml) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += decodeXml(m[1]);
  return out;
}

/** A1 / AA12 → { col, row }（0 基）。 */
function cellRef(ref) {
  const m = /^([A-Z]+)([0-9]+)$/.exec(String(ref || '').toUpperCase());
  if (!m) return null;
  let col = 0;
  for (let i = 0; i < m[1].length; i += 1) col = col * 26 + (m[1].charCodeAt(i) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

function parseSheetXml(xml, shared) {
  const rows = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowXml = rm[1];
    const cells = [];
    const cellRe = /<c(?:\s([^>]*))?(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rowXml))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = cellRef((/r="([A-Za-z]+[0-9]+)"/.exec(attrs) || [])[1]);
      const type = ((/t="([^"]+)"/.exec(attrs) || [])[1] || '').toLowerCase();
      let value = '';
      if (type === 'inlineStr') {
        value = textOfRuns(inner);
      } else if (type === 's') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const idx = vm ? Number(decodeXml(vm[1])) : NaN;
        value = Number.isFinite(idx) && shared[idx] !== undefined ? shared[idx] : '';
      } else if (type === 'str') {
        value = textOfRuns(inner) || (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '';
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = vm ? decodeXml(vm[1]) : textOfRuns(inner);
      }
      const col = ref ? ref.col : cells.length;
      cells[col] = value;
    }
    rows.push(cells);
  }
  return rows.map((cells) => {
    let last = -1;
    for (let i = 0; i < cells.length; i += 1) if (cells[i] !== undefined && cells[i] !== '') last = i;
    return cells.slice(0, last + 1).map((v) => (v === undefined ? '' : v));
  });
}

/** 读 xlsx（返回 [{ name, rows }]，rows 是二维数组）。 */
export function readXlsxSheets(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = readZipEntries(buf);
  if (!entries || !entries.length) return null;
  const byName = new Map(entries.map((e) => [e.name, e]));
  const shared = [];
  const sst = byName.get('xl/sharedStrings.xml');
  if (sst) {
    const data = entryData(buf, sst);
    if (data) {
      const xml = data.toString('utf8');
      const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
      let sm;
      while ((sm = siRe.exec(xml))) shared.push(textOfRuns(sm[1]));
    }
  }
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  const relTargets = new Map();
  if (relsEntry) {
    const data = entryData(buf, relsEntry);
    if (data) {
      const xml = data.toString('utf8');
      const relRe = /<(?:[A-Za-z0-9_]+:)?Relationship\s([^>]*?)\/>/g;
      let rm;
      while ((rm = relRe.exec(xml))) {
        const id = (/Id=("([^"]+)"|'([^']+)')/.exec(rm[1]) || []).slice(2).find(Boolean);
        const target = (/Target=("([^"]+)"|'([^']+)')/.exec(rm[1]) || []).slice(2).find(Boolean);
        if (id && target) {
          const clean = String(target).replace(/^\.\//, '').replace(/^\/xl\//, '').replace(/^\//, '');
          relTargets.set(id, clean);
        }
      }
    }
  }
  const wbEntry = byName.get('xl/workbook.xml');
  const out = [];
  const sheetNames = [];
  if (wbEntry) {
    const data = entryData(buf, wbEntry);
    const xml = data ? data.toString('utf8') : '';
    const sheetRe = /<(?:[A-Za-z0-9_]+:)?sheet\s([^>]*)>/g;
    let m;
    while ((m = sheetRe.exec(xml))) {
      const attrs = m[1];
      const name = decodeXml((/name=("([^"]*)"|'([^']*)')/.exec(attrs) || []).slice(2).find(Boolean) || '');
      if (name) sheetNames.push(name);
      const rid = (/[A-Za-z0-9_]+:id=("([^"]+)"|'([^']+)')/.exec(attrs) || []).slice(2).find(Boolean) || '';
      const target = relTargets.get(rid) || '';
      const file = target.startsWith('xl/') ? target : 'xl/' + target;
      const entry = byName.get(file) || byName.get(target);
      if (!entry) continue;
      const sdata = entryData(buf, entry);
      if (!sdata) continue;
      out.push({ name: name || path.basename(file, '.xml'), rows: parseSheetXml(sdata.toString('utf8'), shared) });
    }
  }
  if (!out.length) {
    // 兜底：按 sheet1.xml、sheet2.xml 的顺序读
    const worksheets = entries
      .filter((e) => /^xl\/worksheets\/sheet[0-9]+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    worksheets.forEach((entry, i) => {
      const sdata = entryData(buf, entry);
      if (!sdata) return;
      out.push({ name: sheetNames[i] || path.basename(entry.name, '.xml'), rows: parseSheetXml(sdata.toString('utf8'), shared) });
    });
  }
  return out.length ? out : null;
}

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch { /* 不是 UTF-8，继续试 GBK */ }
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch { /* 没有 ICU 或不是 GBK */ }
  return new TextDecoder('utf-8').decode(buf);
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 读 csv/tsv（自动判分隔符与编码）。 */
export function readDelimited(filePath) {
  const buf = fs.readFileSync(filePath);
  const text = decodeText(buf);
  const sample = text.slice(0, 2000);
  const tabs = (sample.match(/\t/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  const delimiter = tabs > commas ? '\t' : ',';
  const rows = parseDelimited(text, delimiter).filter((r) => r.some((v) => v !== ''));
  return rows.length ? [{ name: path.basename(filePath).replace(/\.(csv|tsv|txt)$/i, ''), rows }] : null;
}

/**
 * 读任意采集产物表格。
 * 返回 { sheets: [{ name, rows }], kind } ；读不了返回 { sheets: [], kind, reason }。
 */
export function readTableFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  let buf = null;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { sheets: [], kind: ext.replace('.', ''), reason: '读不到文件' };
  }
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const sheets = readXlsxSheets(filePath);
    return sheets ? { sheets, kind: 'xlsx' } : { sheets: [], kind: 'xlsx', reason: 'xlsx 解析失败' };
  }
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    // 老式 .xls（OLE2 二进制容器），本模块不做 BIFF 解析
    return { sheets: [], kind: 'xls', reason: '老式 .xls 暂不支持合并，请用导出的 xlsx/csv' };
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt' || ext === '') {
    const sheets = readDelimited(filePath);
    return sheets ? { sheets, kind: 'csv' } : { sheets: [], kind: 'csv', reason: '文件是空的' };
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    const sheets = readXlsxSheets(filePath);
    return sheets ? { sheets, kind: 'xlsx' } : { sheets: [], kind: 'xlsx', reason: 'xlsx 解析失败' };
  }
  return { sheets: [], kind: ext.replace('.', '') || 'unknown', reason: '不支持的格式' };
}

/** 一行一行的纯文本（给兜底展示用，最多 maxRows 行）。 */
export function readTextPreview(filePath, maxRows) {
  try {
    const buf = fs.readFileSync(filePath);
    const text = decodeText(buf);
    return text.split(/\r?\n/).slice(0, Number(maxRows) || 20);
  } catch {
    return [];
  }
}
