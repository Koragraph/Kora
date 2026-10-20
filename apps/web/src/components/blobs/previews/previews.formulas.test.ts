// Live QA 2026-10-09: a workbook written by openpyxl (formulas, no cached values) previewed as 0 everywhere.
import { describe, expect, it } from "vite-plus/test";

import { evaluate, FormulaError, type Ref, type Val } from "./formula";
import { buildXlsx } from "./testZip";
import { tableModelFromSheet } from "./SheetTable";
import { openWorkbook } from "./xlsx";

const cell = (ref: string, inner: string, attrs = "") => `<c r="${ref}"${attrs}>${inner}</c>`;
const num = (ref: string, n: number) => cell(ref, `<v>${n}</v>`);
const str = (ref: string, text: string) => cell(ref, `<is><t>${text}</t></is>`, ' t="inlineStr"');
const fx = (ref: string, formula: string, value?: string) =>
  cell(ref, `<f>${formula}</f>${value === undefined ? "<v></v>" : `<v>${value}</v>`}`);
const sheetXml = (rows: string[][]) =>
  `<sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${cells.join("")}</row>`).join("")}</sheetData>`;

describe("formula evaluator (copy of the runtime's)", () => {
  const grid: Record<string, Val> = { "1:1": 10, "1:2": 20, "1:3": 30 };
  const resolver = {
    cell: (r: Ref): Val => {
      if (r.col === 1 && r.row === 99) throw new FormulaError("#REF!");
      return grid[`${r.col}:${r.row}`] ?? null;
    },
  };
  const run = (f: string) => {
    const r = evaluate(f, resolver);
    return r.ok ? r.value : r.error;
  };
  it("does arithmetic, ranges and functions", () => {
    expect(run("=SUM(A1:A3)")).toBe(60);
    expect(run("=AVERAGE(A1:A3)*2")).toBe(40);
    expect(run("=MAX(A1:A3)-MIN(A1:A3)")).toBe(20);
    expect(run("=A1+A2*2")).toBe(50);
    expect(run("=A3/A1")).toBe(3);
    expect(run("=50%+0.1")).toBeCloseTo(0.6);
    expect(run('=IF(SUM(A1:A3)>50,"over","under")')).toBe("over");
    expect(run("=2^3^2")).toBe(64);
    expect(run("=A1/0")).toBe("#DIV/0!");
    expect(run("=NOPE(1)")).toBe("#NAME?");
  });
});

describe("xlsx preview: formulas without a cached value", () => {
  const book = (rows: string[][], extra = "") =>
    openWorkbook(buildXlsx({ sheets: [{ name: "Sheet1", xml: `${extra}${sheetXml(rows)}` }] }));

  it("computes SUM / arithmetic / percentages instead of showing 0, and keeps the formula for hover", async () => {
    const wb = await book([
      [str("A1", "Item"), str("B1", "Qty"), str("C1", "Price"), str("D1", "Total")],
      [str("A2", "Pens"), num("B2", 4), num("C2", 2.5), fx("D2", "B2*C2")],
      [str("A3", "Paper"), num("B3", 2), num("C3", 10), fx("D3", "B3*C3")],
      [
        str("A4", "Total"),
        fx("B4", "SUM(B2:B3)"),
        fx("C4", "AVERAGE(C2:C3)"),
        fx("D4", "SUM(D2:D3)"),
        fx("E4", "D4*10%"),
      ],
    ]);
    const sheet = await wb.readSheet(0);
    expect(sheet.rows[1]).toEqual(["Pens", "4", "2.5", "10", ""]);
    expect(sheet.rows[3]).toEqual(["Total", "6", "6.25", "30", "3"]);
    expect(sheet.rows.flat()).not.toContain("0");
    expect(sheet.formulas[1]?.[3]).toBe("=B2*C2");
    expect(sheet.formulas[3]?.[3]).toBe("=SUM(D2:D3)");
    expect(sheet.formulas[0]?.[0]).toBe("");
    const model = tableModelFromSheet(sheet);
    expect(model.formulas?.[0]?.[3]).toBe("=B2*C2"); // header row split off: first body row
  });

  it("works for self-closing empty values and a stored cached value wins", async () => {
    const wb = await book([[num("A1", 5), cell("B1", "<f>A1*2</f><v/>"), fx("C1", "A1*2", "999")]]);
    const sheet = await wb.readSheet(0);
    expect(sheet.rows[0]).toEqual(["5", "10", "999"]);
  });

  it("shows the formula text, not a guess, for an unsupported function or a range past the rows it read", async () => {
    const wb = await book([[fx("A1", "VLOOKUP(2,B1:C2,2,0)"), num("B1", 1)], [num("A2", 1)]]);
    expect((await wb.readSheet(0)).rows[0]?.[0]).toBe("=VLOOKUP(2,B1:C2,2,0)");

    const many = Array.from({ length: 30 }, (_, i) => [num(`A${i + 1}`, 1)]);
    many[0]!.push(fx("B1", "SUM(A1:A30)"));
    const big = await book(many);
    const partial = await big.readSheet(0, { rows: 10 });
    expect(partial.moreRows).toBe(true);
    expect(partial.rows[0]?.[1]).toBe("=SUM(A1:A30)"); // only 10 rows were read: not 10
    const full = await big.readSheet(0, { rows: 200 });
    expect(full.rows[0]?.[1]).toBe("30");
  });

  it("follows formulas that depend on formulas, survives a cycle, and reports a real error", async () => {
    const wb = await book([
      [num("A1", 4), fx("B1", "A1+1"), fx("C1", "B1*2"), fx("D1", "A1/0")],
      [fx("A2", "B2+1"), fx("B2", "A2+1")],
    ]);
    const sheet = await wb.readSheet(0);
    expect(sheet.rows[0]).toEqual(["4", "5", "10", "#DIV/0!"]);
    expect(sheet.rows[1]?.[0]).toBe("#REF!");
  });

  it("formats a computed number like a stored one (percent style)", async () => {
    const wb = await book([
      [num("A1", 40), num("B1", 200), cell("C1", "<f>A1/B1</f><v></v>", ' s="2"')],
    ]);
    expect((await wb.readSheet(0)).rows[0]?.[2]).toBe("20%");
  });
});
