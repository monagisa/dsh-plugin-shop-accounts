/**
 * 最小的 xlsx 写盘工具（v0.20.20）。
 *
 * 采集里有两类配方：下载型（平台自己导出的 xlsx）和指标型（把页面上的文字/JSON 解析成指标）。
 * 指标型以前只落一份 JSON，打开一看没有表格；这里用一个不依赖第三方库的小写入器，
 * 把指标渲染成单表 xlsx（纯 STORE 打包：不压缩、只用 inlineStr，Excel/WPS 都能直接打开）。
 */

import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function colName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellXml(value, ref) {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  const text = isNumber ? String(value) : String(value === undefined || value === null ? '' : value);
  const col = colName(ref.col) + (ref.row + 1);
  if (isNumber) return `<c r="${col}" t="n"><v>${text}</v></c>`;
  return `<c r="${col}" t="inlineStr"><is><t>${xmlEscape(text.slice(0, 32000))}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows
    .map((row, r) => {
      const cells = row.map((value, c) => (value === undefined || value === null || value === '' ? '' : cellXml(value, { row: r, col: c }))).join('');
      return `<row r="${r}">${cells}</row>`;
    })
    .join('');
  const widths = rows.reduce((acc, row) => acc.map((w, i) => Math.max(w, Math.min(60, String(row[i] === undefined ? '' : row[i]).length + 4))), []);
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

function buildEntries(rows, sheetName) {
  const sheet = sheetXml(rows);
  return [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xmlEscape(String(sheetName || 'Sheet1').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ];
}

function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = (text) => Buffer.from(text, 'utf8');
  for (const entry of entries) {
    const data = enc(entry.data);
    const name = enc(entry.name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const centralHead = Buffer.alloc(46);
    centralHead.writeUInt32LE(0x02014b50, 0);
    centralHead.writeUInt16LE(20, 4);
    centralHead.writeUInt16LE(20, 6);
    centralHead.writeUInt16LE(0, 8);
    centralHead.writeUInt16LE(0, 10);
    centralHead.writeUInt16LE(0, 12);
    centralHead.writeUInt16LE(0, 14);
    centralHead.writeUInt32LE(crc, 16);
    centralHead.writeUInt32LE(data.length, 20);
    centralHead.writeUInt32LE(data.length, 24);
    centralHead.writeUInt16LE(name.length, 28);
    centralHead.writeUInt16LE(0, 30);
    centralHead.writeUInt16LE(0, 32);
    centralHead.writeUInt16LE(0, 34);
    centralHead.writeUInt16LE(0, 36);
    centralHead.writeUInt32LE(0, 38);
    centralHead.writeUInt32LE(offset, 42);
    central.push(centralHead, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/** 把二维数组写成单表 xlsx；rows[0] 视为表头。返回文件路径。 */
export function writeXlsx(filePath, rows, opts = {}) {
  const safeRows = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r : [r]));
  const sheetName = String(opts.sheetName || 'Sheet1');
  const buf = zipStore(buildEntries(safeRows.length ? safeRows : [['（空）']], sheetName));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/** 把任意 JSON 拍平成 [字段, 值] 两列（最多三层，够看报表字段）。 */
export function flattenRows(value, opts = {}) {
  const maxDepth = Number(opts.maxDepth) || 3;
  const rows = [];
  const visit = (node, prefix, depth) => {
    if (rows.length >= (Number(opts.maxRows) || 2000)) return;
    if (node === null || node === undefined) return;
    if (typeof node === 'object') {
      if (depth > maxDepth) {
        try {
          rows.push([prefix || '(根)', JSON.stringify(node).slice(0, 32000)]);
        } catch { rows.push([prefix || '(根)', '[无法序列化]']); }
        return;
      }
      if (Array.isArray(node)) {
        if (!node.length) rows.push([prefix || '(根)', '[]']);
        for (let i = 0; i < node.length; i += 1) {
          if (typeof node[i] === 'object' && node[i] !== null) visit(node[i], prefix + '[' + i + ']', depth + 1);
          else rows.push([prefix + '[' + i + ']', node[i]]);
        }
        return;
      }
      for (const key of Object.keys(node)) visit(node[key], prefix ? prefix + '.' + key : key, depth + 1);
      return;
    }
    rows.push([prefix || '(根)', node]);
  };
  visit(value, '', 1);
  return rows;
}
