// Test-only: builds small ZIP / Office packages so the preview readers run against real bytes.
import * as NodeZlib from "node:zlib";

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(content);
    const data = method === 8 ? new Uint8Array(NodeZlib.deflateRawSync(raw)) : raw;
    const crc = crc32(raw);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export interface TestSheet {
  readonly name: string;
  readonly xml: string;
  readonly state?: "hidden";
}

/** A minimal .xlsx: the given sheets (worksheet XML bodies), shared strings and styles. */
export function buildXlsx(input: {
  readonly sheets: ReadonlyArray<TestSheet>;
  readonly sharedStrings?: ReadonlyArray<string>;
  readonly stylesXml?: string;
}): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook ${NS}><sheets>${input.sheets
      .map(
        (sheet, index) =>
          `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${index + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${input.sheets
      .map(
        (_sheet, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
    "xl/sharedStrings.xml": `<sst ${NS}>${(input.sharedStrings ?? []).map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
    "xl/styles.xml":
      input.stylesXml ??
      `<styleSheet ${NS}><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/></cellXfs></styleSheet>`,
  };
  input.sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet ${NS}>${sheet.xml}</worksheet>`;
  });
  return buildZip(files);
}
