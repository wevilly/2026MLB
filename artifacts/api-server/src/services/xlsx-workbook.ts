/**
 * A minimal, dependency-free .xlsx (Office Open XML) writer.
 *
 * The platform already ships an Excel-compatible SpreadsheetML export
 * (`buildWorkbookExport`), which modern Excel opens only after a format
 * warning. This writer produces a real .xlsx package instead, so a workbook
 * downloaded from the platform opens the way an operator expects.
 *
 * It is deliberately small: strings, numbers and booleans, one header row per
 * sheet, frozen headers, an autofilter and column widths. No formulas, no
 * merged cells, no charts. Anything richer belongs in a spreadsheet the
 * operator builds on top of this output, not in the platform.
 *
 * Every entry is written with a fixed timestamp so the same rows always
 * produce byte-identical bytes, which is what makes the export testable.
 */
import { deflateRawSync } from "node:zlib";

export type XlsxCell = string | number | boolean | null | undefined;

export type XlsxSheet = {
  name: string;
  headers: string[];
  rows: XlsxCell[][];
  /** Column widths in Excel character units, positional. Missing entries use the default. */
  columnWidths?: number[];
};

/** Excel refuses to open a file with a cell longer than this. */
const MAX_CELL_TEXT = 32_767;
const TRUNCATION_MARKER = " [truncated]";
const DEFAULT_COLUMN_WIDTH = 18;
/** DOS date for 1980-01-01, the earliest a zip entry can carry. */
const FIXED_DOS_DATE = 33;
const FIXED_DOS_TIME = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Escapes XML text and drops the control characters XML 1.0 cannot carry. */
function xmlText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttribute(value: string) {
  return xmlText(value).replace(/"/g, "&quot;");
}

/** 0 gives A, 25 gives Z, 26 gives AA. */
export function columnLetter(index: number) {
  let remaining = index + 1;
  let letters = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/**
 * Excel sheet names cannot exceed 31 characters, cannot contain : \ / ? * [ ],
 * and must be unique within the workbook. A collision is resolved rather than
 * rejected, because a dropped sheet would be a silently missing surface.
 */
function resolveSheetNames(sheets: XlsxSheet[]) {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const cleaned = sheet.name.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31);
    let candidate = cleaned || `Sheet${index + 1}`;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      const tag = ` ${suffix}`;
      candidate = `${candidate.slice(0, 31 - tag.length)}${tag}`;
      suffix += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function cellText(value: string) {
  if (value.length <= MAX_CELL_TEXT) return value;
  return `${value.slice(0, MAX_CELL_TEXT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function cellXml(reference: string, value: XlsxCell, styleIndex: number) {
  const style = styleIndex > 0 ? ` s="${styleIndex}"` : "";
  if (value === null || value === undefined || value === "") return `<c r="${reference}"${style}/>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return `<c r="${reference}"${style} t="inlineStr"><is><t>${xmlText(String(value))}</t></is></c>`;
    }
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") return `<c r="${reference}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(cellText(value))}</t></is></c>`;
}

function rowXml(rowNumber: number, cells: XlsxCell[], styleIndex: number) {
  const body = cells
    .map((cell, index) => cellXml(`${columnLetter(index)}${rowNumber}`, cell, styleIndex))
    .join("");
  return `<row r="${rowNumber}">${body}</row>`;
}

function sheetXml(sheet: XlsxSheet) {
  const columnCount = Math.max(sheet.headers.length, ...sheet.rows.map((row) => row.length), 1);
  const lastColumn = columnLetter(columnCount - 1);
  const lastRow = sheet.rows.length + 1;
  const cols = Array.from({ length: columnCount }, (_unused, index) => {
    const width = sheet.columnWidths?.[index] ?? DEFAULT_COLUMN_WIDTH;
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const body = [
    rowXml(1, sheet.headers, 1),
    ...sheet.rows.map((row, index) => rowXml(index + 2, row, 2)),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${body}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/></worksheet>`;
}

const CONTENT_TYPES_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3B57"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

type ZipEntry = { name: string; data: Buffer };

function zip(entries: ZipEntry[]) {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, end]);
}

/** Builds a real .xlsx package. One worksheet per entry, in the order given. */
export function writeXlsx(sheets: XlsxSheet[]): Buffer {
  if (sheets.length === 0) throw new Error("a workbook needs at least one sheet");
  const names = resolveSheetNames(sheets);

  const contentTypes = `${CONTENT_TYPES_HEADER}${sheets
    .map((_unused, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("")}</Types>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
    .map((name, index) => `<sheet name="${xmlAttribute(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("")}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_unused, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  const text = (value: string) => Buffer.from(value, "utf8");
  return zip([
    { name: "[Content_Types].xml", data: text(contentTypes) },
    { name: "_rels/.rels", data: text(ROOT_RELS) },
    { name: "xl/workbook.xml", data: text(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: text(workbookRels) },
    { name: "xl/styles.xml", data: text(STYLES) },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: text(sheetXml(sheet)),
    })),
  ]);
}
