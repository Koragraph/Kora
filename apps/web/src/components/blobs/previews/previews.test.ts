import { describe, expect, it } from "vite-plus/test";

import { parseDelimited, delimiterFor } from "./delimited";
import { PREVIEW_LIMITS, PreviewError } from "./limits";
import { readDocxMeta, readPdfMeta, readPptxMeta } from "./officeMeta";
import { createPreviewHandler } from "./previewHandler";
import { tableFooter, tableModelFromSheet } from "./SheetTable";
import { buildXlsx, buildZip } from "./testZip";
import {
  applyNumberFormat,
  columnLabel,
  excelSerialToText,
  openWorkbook,
  parseCellRef,
} from "./xlsx";
import { openZip, readZipText } from "./zip";

const enc = (text: string) => new TextEncoder().encode(text);
const rowsXml = (count: number, cols = 3) =>
  Array.from({ length: count }, (_, i) => {
    const r = i + 1;
    const cells = Array.from(
      { length: cols },
      (_c, c) => `<c r="${columnLabel(c)}${r}"><v>${r * 10 + c}</v></c>`,
    ).join("");
    return `<row r="${r}">${cells}</row>`;
  }).join("");

describe("delimited text", () => {
  it("parses quoted fields, embedded commas, quotes and newlines", () => {
    const table = parseDelimited('name,note\n"Smith, J","said ""hi"""\n"two\nlines",x\n', ",");
    expect(table.header).toEqual(["name", "note"]);
    expect(table.rows).toEqual([
      ["Smith, J", 'said "hi"'],
      ["two\nlines", "x"],
    ]);
    expect(table.totalRows).toBe(2);
  });

  it("handles a BOM, CRLF and a missing trailing newline", () => {
    const table = parseDelimited("﻿a,b\r\n1,2\r\n3,4", ",");
    expect(table.header).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("caps rows and columns and says so", () => {
    const text = ["h1,h2,h3,h4", ...Array.from({ length: 50 }, (_, i) => `${i},b,c,d`)].join("\n");
    const table = parseDelimited(text, ",", { rows: 10, cols: 2 });
    expect(table.rows).toHaveLength(10);
    expect(table.header).toEqual(["h1", "h2"]);
    expect(table.totalRows).toBe(50);
    expect(table.moreRows).toBe(true);
    expect(table.moreCols).toBe(true);
    expect(tableFooter({ ...table, moreRows: table.moreRows }, table.rows.length)).toContain(
      "Showing the first 10 of 50 rows",
    );
  });

  it("drops the ragged last row of text cut at the read cap, and marks totals as a lower bound", () => {
    const table = parseDelimited("a,b\n1,2\n3,4\n5,", ",", { textTruncated: true });
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(table.textTruncated).toBe(true);
    expect(tableFooter({ ...table }, 2)).toContain("longer than the preview reads");
  });

  it("guesses tab and semicolon delimiters", () => {
    expect(delimiterFor("x.tsv", "a,b")).toBe("\t");
    expect(delimiterFor("x.csv", "a\tb\tc\n")).toBe("\t");
    expect(delimiterFor("x.csv", "a;b;c\n")).toBe(";");
    expect(delimiterFor("x.csv", "a,b,c\n")).toBe(",");
  });

  it("returns an empty table for empty input", () => {
    expect(parseDelimited("", ",").rows).toEqual([]);
  });
});

describe("zip reader", () => {
  it("reads stored and deflated entries", async () => {
    for (const method of [0, 8] as const) {
      const archive = openZip(buildZip({ "a.txt": "hello", "dir/b.xml": "<x>é</x>" }, method));
      expect(await readZipText(archive, "a.txt")).toBe("hello");
      expect(await readZipText(archive, "dir/b.xml")).toBe("<x>é</x>");
      expect(await readZipText(archive, "missing")).toBeNull();
    }
  });

  it("rejects bytes that are not a zip", () => {
    expect(() => openZip(enc("definitely not a zip file at all, nope"))).toThrow(PreviewError);
  });

  it("enforces the size cap while inflating", async () => {
    const archive = openZip(buildZip({ "big.xml": "x".repeat(10_000) }));
    await expect(readZipText(archive, "big.xml", { maxBytes: 1000 })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("stops early when the reader has what it needs", async () => {
    const archive = openZip(buildZip({ "s.xml": "<r/>".repeat(50_000) }));
    const text = await readZipText(archive, "s.xml", { until: (soFar) => soFar.length > 100 });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(200_000);
  });
});

describe("xlsx reader", () => {
  const sheetOne = `<dimension ref="A1:D3"/><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>Done</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1234.5</v></c><c r="C2" s="1"><v>46000</v></c><c r="D2" t="b"><v>1</v></c></row>
    <row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>0.30000000000000004</v></c><c r="C3" s="2"><v>0.256</v></c><c r="D3" t="str"><v>formula text</v></c></row>
  </sheetData>`;
  const strings = ["Region", "Revenue", "Closed on", "North &amp; East", "South"];

  it("reads sheet names, hides hidden sheets, and renders cells", async () => {
    const book = await openWorkbook(
      buildXlsx({
        sheets: [
          { name: "Summary", xml: sheetOne },
          { name: "Secret", xml: "<sheetData/>", state: "hidden" },
          {
            name: "Q2",
            xml: `<dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>only</t></is></c></row></sheetData>`,
          },
        ],
        sharedStrings: strings,
      }),
    );
    expect(book.sheets.map((s) => s.name)).toEqual(["Summary", "Q2"]);
    const sheet = await book.readSheet(0);
    expect(sheet.rows[0]).toEqual(["Region", "Revenue", "Closed on", "Done"]);
    expect(sheet.rows[1]).toEqual(["North & East", "1234.5", "2025-12-09", "TRUE"]);
    expect(sheet.rows[2]).toEqual(["South", "0.3", "26%", "formula text"]);
    expect(sheet.totalRows).toBe(3);
    expect(sheet.moreRows).toBe(false);
    expect(sheet.moreCols).toBe(false);
    expect((await book.readSheet(1)).rows).toEqual([["only"]]);
  });

  it("reads only the top rows of a big sheet and reports there is more", async () => {
    const book = await openWorkbook(
      buildXlsx({
        sheets: [
          { name: "Big", xml: `<dimension ref="A1:C5000"/><sheetData>${rowsXml(600)}</sheetData>` },
        ],
      }),
    );
    const sheet = await book.readSheet(0, { rows: 200 });
    expect(sheet.rows).toHaveLength(PREVIEW_LIMITS.sheetRows);
    expect(sheet.moreRows).toBe(true);
    expect(sheet.totalRows).toBe(5000);
    expect(sheet.rows[199]?.[0]).toBe("2000");
    const model = tableModelFromSheet(sheet);
    expect(tableFooter(model, model.rows.length)).toContain("Showing the first 199 of 4,999 rows");
  });

  it("caps columns and reports it", async () => {
    const book = await openWorkbook(
      buildXlsx({
        sheets: [
          {
            name: "Wide",
            xml: `<dimension ref="A1:AZ2"/><sheetData>${rowsXml(2, 52)}</sheetData>`,
          },
        ],
      }),
    );
    const sheet = await book.readSheet(0, { cols: 10 });
    expect(sheet.rows[0]).toHaveLength(10);
    expect(sheet.moreCols).toBe(true);
  });

  it("is honest about a sparse sheet: row numbers are the sheet's own", async () => {
    const book = await openWorkbook(
      buildXlsx({
        sheets: [
          {
            name: "Sparse",
            xml: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="40"><c r="C40" t="inlineStr"><is><t>far</t></is></c></row></sheetData>`,
          },
        ],
      }),
    );
    const sheet = await book.readSheet(0);
    expect(sheet.rowNumbers).toEqual([1, 40]);
    expect(sheet.rows[1]).toEqual(["", "", "far"]);
  });

  it("rejects a non-workbook package and an unknown sheet", async () => {
    await expect(openWorkbook(buildZip({ "hello.txt": "hi" }))).rejects.toMatchObject({
      code: "corrupt",
    });
    const book = await openWorkbook(buildXlsx({ sheets: [{ name: "A", xml: "<sheetData/>" }] }));
    await expect(book.readSheet(5)).rejects.toMatchObject({ code: "not_found" });
  });

  it("converts cell refs, column labels and date serials", () => {
    expect(parseCellRef("AB12")).toEqual({ col: 27, row: 12 });
    expect(parseCellRef("nope")).toBeNull();
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(27)).toBe("AB");
    expect(excelSerialToText(45292, false)).toBe("2024-01-01");
    expect(excelSerialToText(45292.5, false)).toBe("2024-01-01 12:00");
  });
});

describe("preview handler", () => {
  it("opens a workbook once and reads sheets by key", async () => {
    const handle = createPreviewHandler();
    const bytes = buildXlsx({
      sheets: [
        { name: "A", xml: `<sheetData>${rowsXml(3)}</sheetData>` },
        { name: "B", xml: `<sheetData>${rowsXml(1)}</sheetData>` },
      ],
    });
    const opened = await handle({
      op: "open-sheet",
      key: "k",
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    expect(opened).toEqual({ ok: true, sheetNames: ["A", "B"] });
    const read = await handle({ op: "read-sheet", key: "k", index: 1 });
    expect(read.ok && "sheet" in read && read.sheet.name).toBe("B");
    await handle({ op: "close", key: "k" });
    const closed = await handle({ op: "read-sheet", key: "k", index: 0 });
    expect(closed).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses files over the preview limit with a clear code", async () => {
    const handle = createPreviewHandler();
    const huge = new ArrayBuffer(PREVIEW_LIMITS.maxOfficeBytes + 1);
    expect(await handle({ op: "open-sheet", key: "k", bytes: huge })).toMatchObject({
      ok: false,
      code: "too_large",
    });
    expect(await handle({ op: "office-meta", family: "pdf", bytes: huge })).toMatchObject({
      ok: false,
      code: "too_large",
    });
  });

  it("turns a damaged workbook into an error result instead of throwing", async () => {
    const handle = createPreviewHandler();
    const junk = enc("PK this is not really a workbook, it only pretends to be one")
      .buffer as ArrayBuffer;
    expect(await handle({ op: "open-sheet", key: "k", bytes: junk })).toMatchObject({
      ok: false,
      code: "corrupt",
    });
  });
});

describe("document, deck and pdf metadata", () => {
  it("reads a docx title, page count and opening lines", async () => {
    const meta = await readDocxMeta(
      buildZip({
        "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p><w:p><w:r><w:t>Goals for Q4 &amp; beyond</w:t></w:r></w:p></w:body></w:document>`,
        "docProps/core.xml": `<cp:coreProperties><dc:title>Q4 Plan</dc:title></cp:coreProperties>`,
        "docProps/app.xml": `<Properties><Pages>7</Pages></Properties>`,
      }),
    );
    expect(meta).toMatchObject({ family: "document", title: "Q4 Plan", count: 7 });
    expect(meta.excerpt).toContain("Quarterly plan");
    expect(meta.excerpt).toContain("Q4 & beyond");
  });

  it("does not repeat the title as the first line of the excerpt", async () => {
    const meta = await readDocxMeta(
      buildZip({
        "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Q4  Plan</w:t></w:r></w:p><w:p><w:r><w:t>Goals for Q4</w:t></w:r></w:p></w:body></w:document>`,
        "docProps/core.xml": `<cp:coreProperties><dc:title>q4 plan</dc:title></cp:coreProperties>`,
      }),
    );
    expect(meta.title).toBe("q4 plan");
    expect(meta.excerpt).toBe("Goals for Q4");
  });

  it("counts a deck's slides and takes the first slide's text as the title", async () => {
    const slide = (text: string) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const meta = await readPptxMeta(
      buildZip({
        "ppt/presentation.xml": "<p:presentation/>",
        "ppt/slides/slide1.xml": slide("Launch review"),
        "ppt/slides/slide2.xml": slide("Numbers"),
        "ppt/slides/slide10.xml": slide("Ask"),
      }),
    );
    expect(meta).toMatchObject({ family: "slides", count: 3, title: "Launch review" });
  });

  it("estimates a pdf's page count", () => {
    const pdf = enc(
      "%PDF-1.7\n1 0 obj<</Type /Pages /Kids [2 0 R] /Count 12>>endobj\n2 0 obj<</Type /Page>>endobj\n3 0 obj<</Title (Annual \\(draft\\) report)>>",
    );
    expect(readPdfMeta(pdf)).toMatchObject({
      family: "pdf",
      count: 12,
      title: "Annual (draft) report",
    });
    expect(readPdfMeta(enc("%PDF-1.4\n<</Type /Page>><</Type /Page>>")).count).toBe(2);
    expect(() => readPdfMeta(enc("not a pdf"))).toThrow(PreviewError);
  });
});

describe("xlsx number formats", () => {
  it("applies currency, percent, thousands and negatives like Excel", () => {
    expect(applyNumberFormat(420.5, "$#,##0.00")).toBe("$420.50");
    expect(applyNumberFormat(19.025, "$#,##0.00")).toBe("$19.03");
    expect(applyNumberFormat(1234567.891, "#,##0.00")).toBe("1,234,567.89");
    expect(applyNumberFormat(0.256, "0.0%")).toBe("25.6%");
    expect(applyNumberFormat(-1500, "$#,##0;($#,##0)")).toBe("($1,500)");
    expect(applyNumberFormat(-3.5, "0.00")).toBe("-3.50");
    expect(applyNumberFormat(12, '0" units"')).toBe("12 units");
    expect(applyNumberFormat(1999, "[$€-407] #,##0.00")).toBe("€ 1,999.00");
    expect(applyNumberFormat(5, "General")).toBeNull();
  });
});
