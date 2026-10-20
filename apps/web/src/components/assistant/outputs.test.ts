import { describe, expect, it } from "vite-plus/test";

import {
  classifyOutputFamily,
  classifyOutputKind,
  dedupeOutputPaths,
  extractOutputPathsFromMarkdown,
  extractOutputPathsFromWorkLogEntry,
  formatOutputSize,
  outputFamilyIsBinary,
  outputFamilyLabel,
  outputDisplayName,
  resolveProjectOutputPath,
  truncateOutputName,
} from "./outputs";

const ROOT = "/Users/me/.kora/chats/projects/my-report";

describe("classifyOutputKind", () => {
  it("classifies known text kinds", () => {
    expect(classifyOutputKind("outputs/report.md")).toBe("markdown");
    expect(classifyOutputKind("outputs/data.CSV")).toBe("table");
    expect(classifyOutputKind("outputs/data.tsv")).toBe("table");
    expect(classifyOutputKind("outputs/page.html")).toBe("html");
    expect(classifyOutputKind("outputs/page.htm")).toBe("html");
    expect(classifyOutputKind("outputs/data.json")).toBe("json");
  });

  it("classifies images and pdf", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]) {
      expect(classifyOutputKind(`outputs/chart${ext}`)).toBe("image");
    }
    expect(classifyOutputKind("outputs/summary.pdf")).toBe("pdf");
  });

  it("classifies office/archive formats as other", () => {
    expect(classifyOutputKind("outputs/sheet.xlsx")).toBe("other");
    expect(classifyOutputKind("outputs/deck.pptx")).toBe("other");
    expect(classifyOutputKind("outputs/doc.docx")).toBe("other");
    expect(classifyOutputKind("outputs/archive.zip")).toBe("other");
  });

  it("falls back to code for source/text files and extensionless names", () => {
    expect(classifyOutputKind("outputs/script.py")).toBe("code");
    expect(classifyOutputKind("outputs/notes.txt")).toBe("code");
    expect(classifyOutputKind("outputs/Makefile")).toBe("code");
  });
});

describe("resolveProjectOutputPath", () => {
  it("keeps a workspace-relative path as-is", () => {
    expect(resolveProjectOutputPath("outputs/report.md", ROOT)).toBe("outputs/report.md");
    expect(resolveProjectOutputPath("./outputs/report.md", ROOT)).toBe("outputs/report.md");
  });

  it("resolves an absolute path under the root", () => {
    expect(resolveProjectOutputPath(`${ROOT}/outputs/report.md`, ROOT)).toBe("outputs/report.md");
  });

  it("rejects a path outside the root", () => {
    expect(resolveProjectOutputPath("/etc/passwd", ROOT)).toBeNull();
    expect(resolveProjectOutputPath("../outside.md", ROOT)).toBeNull();
  });

  it("rejects when there is no root", () => {
    expect(resolveProjectOutputPath("outputs/report.md", null)).toBeNull();
    expect(resolveProjectOutputPath("outputs/report.md", undefined)).toBeNull();
  });
});

describe("extractOutputPathsFromWorkLogEntry", () => {
  it("resolves changed files under the root", () => {
    expect(
      extractOutputPathsFromWorkLogEntry(
        { changedFiles: [`${ROOT}/outputs/report.md`, "outputs/data.csv"] },
        ROOT,
      ),
    ).toEqual(["outputs/report.md", "outputs/data.csv"]);
  });

  it("drops files outside the root", () => {
    expect(extractOutputPathsFromWorkLogEntry({ changedFiles: ["/etc/passwd"] }, ROOT)).toEqual([]);
  });

  it("returns nothing without changed files", () => {
    expect(extractOutputPathsFromWorkLogEntry({}, ROOT)).toEqual([]);
  });

  it("gives helper scripts and scratch files no card, unless the assistant's own text names them", () => {
    const changed = [
      `${ROOT}/outputs/edit_sheet.py`,
      `${ROOT}/scratch/tmp.csv`,
      "outputs/run.sh",
      "outputs/budget.xlsx",
    ];
    expect(extractOutputPathsFromWorkLogEntry({ changedFiles: changed }, ROOT)).toEqual([
      "outputs/budget.xlsx",
    ]);
    expect(extractOutputPathsFromMarkdown("I wrote [the script](outputs/run.sh).", ROOT)).toEqual([
      "outputs/run.sh",
    ]);
  });
});

describe("extractOutputPathsFromMarkdown", () => {
  it("extracts an explicit markdown link under the root", () => {
    const markdown = "See [the report](outputs/report.md) for details.";
    expect(extractOutputPathsFromMarkdown(markdown, ROOT)).toEqual(["outputs/report.md"]);
  });

  it("extracts a path-shaped inline code span under the root", () => {
    const markdown = "Wrote the table to `outputs/data.csv`.";
    expect(extractOutputPathsFromMarkdown(markdown, ROOT)).toEqual(["outputs/data.csv"]);
  });

  it("ignores inline code that isn't a path", () => {
    const markdown = "Run `npm install` first.";
    expect(extractOutputPathsFromMarkdown(markdown, ROOT)).toEqual([]);
  });

  it("ignores links outside the project root", () => {
    const markdown = "See [external](https://example.com/report.md).";
    expect(extractOutputPathsFromMarkdown(markdown, ROOT)).toEqual([]);
  });
});

describe("dedupeOutputPaths", () => {
  it("keeps first occurrence order and drops repeats", () => {
    expect(dedupeOutputPaths(["outputs/a.md", "outputs/b.md", "outputs/a.md"])).toEqual([
      "outputs/a.md",
      "outputs/b.md",
    ]);
  });
});

describe("outputDisplayName", () => {
  it("returns the file's basename", () => {
    expect(outputDisplayName("outputs/nested/report.md")).toBe("report.md");
  });
});

describe("truncateOutputName", () => {
  it("leaves a name within the budget untouched", () => {
    expect(truncateOutputName("llm-inference-cost-comparison.csv")).toBe(
      "llm-inference-cost-comparison.csv",
    );
    expect(truncateOutputName("short.md")).toBe("short.md");
  });

  it("middle-truncates a long name, keeping the extension visible", () => {
    const long = "llm-inference-cost-comparison-full-report.csv";
    const result = truncateOutputName(long);
    expect(result.length).toBeLessThanOrEqual(36);
    expect(result.endsWith(".csv")).toBe(true);
    expect(result).toContain("…");
    expect(result.startsWith("llm-inference")).toBe(true);
  });

  it("respects a custom character budget", () => {
    expect(truncateOutputName("a-very-long-filename-without-extension-thing", 20)).toBe(
      "a-very-lon…ion-thing",
    );
  });

  it("truncates a name with no extension without leaving a trailing dot", () => {
    const result = truncateOutputName("a-very-long-filename-without-any-dot-at-all");
    expect(result).not.toContain(".");
    expect(result).toContain("…");
  });

  it("treats a dotfile's leading dot as part of the name, not an extension", () => {
    expect(truncateOutputName(".gitignore")).toBe(".gitignore");
  });
});

describe("formatOutputSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatOutputSize(420)).toBe("420 B");
    expect(formatOutputSize(12 * 1024)).toBe("12 KB");
    expect(formatOutputSize(1536)).toBe("1.5 KB");
    expect(formatOutputSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});

describe("bare output names", () => {
  it("maps a bare file name in inline code to outputs/", () => {
    expect(extractOutputPathsFromMarkdown("CSV written to `vector-dbs.csv`.", "/tmp/proj")).toEqual(
      ["outputs/vector-dbs.csv"],
    );
  });
});

describe("symlinked roots", () => {
  it("maps an absolute outputs path under another spelling of the root", () => {
    expect(
      resolveProjectOutputPath("/private/var/x/chat/general/outputs/a.csv", "/var/x/chat/general"),
    ).toBe("outputs/a.csv");
  });
});

describe("classifyOutputFamily (Blobs rich previews)", () => {
  it("separates spreadsheets, documents and decks from the generic binaries", () => {
    expect(classifyOutputFamily("outputs/q3.xlsx")).toBe("sheet");
    expect(classifyOutputFamily("outputs/q3.XLSM")).toBe("sheet");
    expect(classifyOutputFamily("outputs/brief.docx")).toBe("document");
    expect(classifyOutputFamily("outputs/launch.pptx")).toBe("slides");
    expect(classifyOutputFamily("outputs/summary.pdf")).toBe("pdf");
    expect(classifyOutputFamily("outputs/old.doc")).toBe("other");
    expect(classifyOutputFamily("outputs/archive.zip")).toBe("other");
  });

  it("keeps text families and images", () => {
    expect(classifyOutputFamily("outputs/data.csv")).toBe("delimited");
    expect(classifyOutputFamily("outputs/data.tsv")).toBe("delimited");
    expect(classifyOutputFamily("outputs/report.md")).toBe("markdown");
    expect(classifyOutputFamily("outputs/chart.png")).toBe("image");
    expect(classifyOutputFamily("outputs/notes.txt")).toBe("text");
    expect(classifyOutputFamily("outputs/script.py")).toBe("text");
  });

  it("knows which families need the file-bytes path and how to word them", () => {
    expect(outputFamilyIsBinary("sheet")).toBe(true);
    expect(outputFamilyIsBinary("image")).toBe(true);
    expect(outputFamilyIsBinary("delimited")).toBe(false);
    expect(outputFamilyLabel("slides")).toBe("Slides");
  });
});
