import { describe, expect, it } from "vite-plus/test";

import { fileViewerDelimiter, parseDelimitedPreview } from "./previewDelimiters.ts";

describe("delimiter detection", () => {
  it.each([
    [{ name: "x.bin", mimeType: "text/csv; charset=utf-8" }, ","],
    [{ name: "x.bin", mimeType: "text/tab-separated-values" }, "\t"],
    [{ name: "REPORT.TSV", mimeType: "application/octet-stream" }, "\t"],
    [{ name: "report.Csv", mimeType: "text/plain" }, ","],
    [{ name: "report.csv" }, ","],
    [{ name: "report.csv", mimeType: "application/json" }, null],
    [{ name: "report.txt" }, null],
  ])("%j → %j", (file, expected) => {
    expect(fileViewerDelimiter(file)).toBe(expected);
  });
});

describe("delimited preview parsing", () => {
  it("handles a BOM, CRLF, quoted commas, doubled quotes, newlines in quotes and empty cells", () => {
    const csv = '﻿id,comment,blank\r\n"1, 2","she said ""ok""\nthen left",\r\n';
    expect(parseDelimitedPreview(csv, ",")).toEqual({
      truncated: false,
      rows: [
        ["id", "comment", "blank"],
        ["1, 2", 'she said "ok"\nthen left', ""],
      ],
    });
  });

  it("splits tabs and keeps a leading empty cell", () => {
    expect(parseDelimitedPreview("a\tb\n\tc", "\t").rows).toEqual([
      ["a", "b"],
      ["", "c"],
    ]);
  });

  it("caps rows at 100, columns at 30 and cells at 2000 characters", () => {
    const wideRow = new Array(31).fill("z".repeat(2001)).join(",");
    const { rows, truncated } = parseDelimitedPreview(new Array(101).fill(wideRow).join("\n"), ",");
    expect(truncated).toBe(true);
    expect([rows.length, rows[0]!.length, rows[0]![0]!.length]).toEqual([100, 30, 2000]);
  });

  it("flags an unterminated quote as truncated", () => {
    expect(parseDelimitedPreview('x,"never closed', ",").truncated).toBe(true);
  });
});
