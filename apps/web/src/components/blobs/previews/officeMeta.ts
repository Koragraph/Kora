// Cheap metadata for documents, decks and PDFs: a title, a page / slide count and a short excerpt, read from the
// package's own parts (docx / pptx) or a scan of the file (PDF). Counts are labelled "about" where they are best
// effort. No rendering happens here: the card offers Open / Reveal for the real thing.
import { PreviewError } from "./limits";
import { decodeXmlEntities, textRuns } from "./xml";
import { openZip, readZipText } from "./zip";

export interface OfficeMeta {
  readonly family: "document" | "slides" | "pdf";
  readonly title: string | null;
  /** Pages (document, pdf) or slides (slides); null when the file does not say. */
  readonly count: number | null;
  /** True when `count` is an estimate (PDF scan, docx app.xml). */
  readonly approximate: boolean;
  readonly excerpt: string | null;
}

const EXCERPT_CHARS = 220;

function cleanTitle(xml: string | null): string | null {
  const raw = xml ? /<dc:title>([\s\S]*?)<\/dc:title>/.exec(xml)?.[1] : undefined;
  const title = raw ? decodeXmlEntities(raw).trim() : "";
  return title.length > 0 ? title : null;
}

const norm = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

/** The card already shows the title: an excerpt that starts by repeating it (a document whose first heading is its title) skips that line. */
function withoutTitle(parts: ReadonlyArray<string>, title: string | null): ReadonlyArray<string> {
  if (!title) return parts;
  const first = parts.findIndex((part) => norm(part).length > 0);
  return first >= 0 && norm(parts[first]!) === norm(title)
    ? [...parts.slice(0, first), ...parts.slice(first + 1)]
    : parts;
}

function excerptOf(parts: ReadonlyArray<string>): string | null {
  const joined = parts
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .join(" · ");
  if (joined.length === 0) return null;
  if (joined.length <= EXCERPT_CHARS) return joined;
  // Cut at a word (never mid-word, never on a dangling separator), then say it goes on.
  const cut = joined.slice(0, EXCERPT_CHARS - 1);
  const atSpace = cut.lastIndexOf(" ");
  const clean = (atSpace > EXCERPT_CHARS * 0.6 ? cut.slice(0, atSpace) : cut).replace(
    /[\s·,;:–-]+$/,
    "",
  );
  return `${clean}…`;
}

export async function readDocxMeta(bytes: Uint8Array): Promise<OfficeMeta> {
  const archive = openZip(bytes);
  if (!archive.entries.has("word/document.xml")) {
    throw new PreviewError("corrupt", "This does not look like a Word document.");
  }
  const title = cleanTitle(await readZipText(archive, "docProps/core.xml"));
  const app = await readZipText(archive, "docProps/app.xml");
  const pages = app
    ? Number.parseInt(/<Pages>(\d+)<\/Pages>/.exec(app)?.[1] ?? "", 10)
    : Number.NaN;
  // Read only the top of the body for the excerpt.
  let paragraphs = 0;
  const body =
    (await readZipText(archive, "word/document.xml", {
      maxBytes: 512 * 1024,
      until: (soFar) => {
        paragraphs = soFar.split("</w:p>").length - 1;
        return paragraphs >= 4;
      },
    })) ?? "";
  const texts = [...body.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((match) =>
    textRuns(match[0], "w:t"),
  );
  return {
    family: "document",
    title,
    count: Number.isFinite(pages) && pages > 0 ? pages : null,
    approximate: true,
    excerpt: excerptOf(withoutTitle(texts, title).slice(0, 3)),
  };
}

export async function readPptxMeta(bytes: Uint8Array): Promise<OfficeMeta> {
  const archive = openZip(bytes);
  const slideNames = [...archive.entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(
      (a, b) =>
        Number.parseInt(a.replace(/\D+/g, ""), 10) - Number.parseInt(b.replace(/\D+/g, ""), 10),
    );
  if (slideNames.length === 0 && !archive.entries.has("ppt/presentation.xml")) {
    throw new PreviewError("corrupt", "This does not look like a PowerPoint deck.");
  }
  const title = cleanTitle(await readZipText(archive, "docProps/core.xml"));
  const first = slideNames[0]
    ? await readZipText(archive, slideNames[0], { maxBytes: 512 * 1024 })
    : null;
  const lines = first
    ? [...first.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((match) => textRuns(match[0], "a:t"))
    : [];
  const slideTitle = title ?? lines.find((line) => line.trim().length > 0)?.trim() ?? null;
  return {
    family: "slides",
    title: slideTitle,
    count: slideNames.length > 0 ? slideNames.length : null,
    approximate: false,
    excerpt: excerptOf(withoutTitle(lines, slideTitle).slice(0, 3)),
  };
}

/** Page count of a PDF by scanning for page-tree `/Count`s; null for files that hide the tree in object streams. */
export function readPdfMeta(bytes: Uint8Array): OfficeMeta {
  if (bytes.byteLength < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
    throw new PreviewError("corrupt", "This does not look like a PDF.");
  }
  // Latin-1 view, in chunks so a large file does not build one giant string.
  let text = "";
  const chunk = 1 << 20;
  for (let at = 0; at < bytes.byteLength; at += chunk) {
    text += new TextDecoder("latin1").decode(
      bytes.subarray(at, Math.min(bytes.byteLength, at + chunk)),
    );
  }
  let count: number | null = null;
  for (const match of text.matchAll(
    /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g,
  )) {
    const n = Number.parseInt(match[1] ?? match[2] ?? "", 10);
    if (Number.isFinite(n) && (count === null || n > count)) count = n;
  }
  if (count === null) {
    const pages = text.match(/\/Type\s*\/Page(?![s\w])/g);
    if (pages && pages.length > 0) count = pages.length;
  }
  const rawTitle = /\/Title\s*\(((?:\\.|[^\\)])*)\)/.exec(text)?.[1];
  const title = rawTitle ? rawTitle.replace(/\\(.)/g, "$1").trim() : "";
  return {
    family: "pdf",
    title: title.length > 0 ? title : null,
    count,
    approximate: true,
    excerpt: null,
  };
}
