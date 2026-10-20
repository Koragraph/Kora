export interface MarkdownClipboardPayload {
  text: string;
  html: string;
}

const SKIPPED_TAGS = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE", "SVG"]);
const HEADING = /^H([1-6])$/;

// ---------- element helpers (only the DOM surface a reduced DOM can offer) ----------

const isText = (node: Node) => node.nodeType === Node.TEXT_NODE;
const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;
const tagOf = (el: Element) => el.tagName.toUpperCase();
const hasClass = (el: Element, name: string) => el.classList.contains(name);
const elementChildren = (el: Element): Element[] => Array.from(el.childNodes).filter(isElement);

function isSkipped(el: Element): boolean {
  return (
    SKIPPED_TAGS.has(tagOf(el)) ||
    el.getAttribute("aria-hidden") === "true" ||
    hasClass(el, "select-none") ||
    hasClass(el, "sr-only")
  );
}

/** An explicit markdown representation that the rendered element asks to be copied as. */
const copyOverride = (el: Element): string | null => el.getAttribute("data-markdown-copy");

function longestRun(str: string, char: string): number {
  let best = 0;
  let run = 0;
  for (const ch of str) {
    run = ch === char ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// ---------- serializer ----------

function serializeChildren(parent: Node): string {
  return Array.from(parent.childNodes).map(serializeNode).join("");
}

function serializeNode(node: Node): string {
  if (isText(node)) {
    const str = node.textContent ?? "";
    return /^\s*$/.test(str) && str.includes("\n") ? "\n" : str;
  }
  if (!isElement(node)) return "";
  if (node.hasAttribute("data-markdown-details")) return serializeDetails(node);
  const copy = copyOverride(node);
  if (copy !== null) return copy;
  if (isSkipped(node)) return "";

  const tag = tagOf(node);
  const heading = HEADING.exec(tag);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${serializeChildren(node).trim()}\n\n`;

  switch (tag) {
    case "P":
      return `${serializeChildren(node).trim()}\n\n`;
    case "BR":
      return "\n";
    case "HR":
      return "---\n\n";
    case "STRONG":
    case "B":
      return wrapEmphasis(serializeChildren(node), "**");
    case "EM":
    case "I":
      return wrapEmphasis(serializeChildren(node), "*");
    case "DEL":
    case "S":
      return wrapEmphasis(serializeChildren(node), "~~");
    case "CODE":
      return serializeCode(node);
    case "PRE":
      return serializePre(node);
    case "A":
      return serializeLink(node);
    case "IMG": {
      const alt = node.getAttribute("alt") ?? "";
      const src = node.getAttribute("src") ?? "";
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "UL":
    case "OL":
      return serializeList(node, tag === "OL");
    case "BLOCKQUOTE":
      return serializeBlockquote(node);
    case "TABLE":
      return serializeTable(node);
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const inner = serializeChildren(node);
      return inner === "" || inner.endsWith("\n") ? inner : `${inner}\n`;
    }
    default:
      return serializeChildren(node);
  }
}

/** Markers wrap the trimmed core; surrounding whitespace stays outside them. */
function wrapEmphasis(contentBody: string, marker: string): string {
  const core = contentBody.trim();
  if (core === "") return contentBody;
  const begin = contentBody.indexOf(core);
  return `${contentBody.slice(0, begin)}${marker}${core}${marker}${contentBody.slice(begin + core.length)}`;
}

function isBlockCode(codeElement: Element, contentBody: string): boolean {
  return (
    contentBody.includes("\n") || elementChildren(codeElement).some((kid) => hasClass(kid, "line"))
  );
}

function serializeCode(codeElement: Element): string {
  const contentBody = codeElement.textContent ?? "";
  // A code element whose <pre> fell outside the selection is still a block.
  if (isBlockCode(codeElement, contentBody)) return contentBody;
  const fence = "`".repeat(longestRun(contentBody, "`") + 1);
  const pad = contentBody.startsWith("`") || contentBody.endsWith("`") ? " " : "";
  return `${fence}${pad}${contentBody}${pad}${fence}`;
}

function languageOf(pre: Element, codeElement: Element | null): string {
  const tagged = pre.closest("[data-language]")?.getAttribute("data-language");
  if (tagged) return tagged;
  const fromClass = /(?:^|\s)language-(\S+)/.exec(codeElement?.getAttribute("class") ?? "");
  return fromClass?.[1] ?? "";
}

const innerCode = (pre: Element): Element | null =>
  elementChildren(pre).find((kid) => tagOf(kid) === "CODE") ?? null;

function serializePre(pre: Element): string {
  const codeElement = innerCode(pre);
  const markup = (codeElement ?? pre).textContent ?? "";
  const str = markup.endsWith("\n") ? markup.slice(0, -1) : markup;
  const runs = longestRun(str, "`");
  const fence = "`".repeat(Math.max(3, runs >= 3 ? runs + 1 : 3));
  const language = languageOf(pre, codeElement);
  const meta = language === "text" ? "" : language;
  return `${fence}${meta}\n${str}\n${fence}\n\n`;
}

function serializeLink(anch: Element): string {
  const caption = serializeChildren(anch).trim();
  const linkTarget = anch.getAttribute("href") ?? "";
  if (!/^https?:/i.test(linkTarget)) return serializeChildren(anch);
  if (caption === "") return "";
  return caption === linkTarget ? linkTarget : `[${caption}](${linkTarget})`;
}

function serializeList(arr: Element, ranked: boolean): string {
  const decoded = Number.parseInt(arr.getAttribute("start") ?? "", 10);
  let number = Number.isFinite(decoded) && decoded !== 0 ? decoded : 1;
  const elems = elementChildren(arr).filter((kid) => tagOf(kid) === "LI");
  const lines = elems.map((item) => {
    const marker = ranked ? `${number++}. ` : "- ";
    return serializeListItem(item, marker);
  });
  return `${lines.join("\n")}\n\n`;
}

function serializeListItem(item: Element, marker: string): string {
  const checkbox = item.querySelector('input[type="checkbox"]');
  let task = "";
  if (checkbox) {
    const checked =
      (checkbox as HTMLInputElement).checked === true || checkbox.hasAttribute("checked");
    task = checked ? "[x] " : "[ ] ";
  }
  let contentBody = serializeChildren(item)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const loose = item.querySelector(":scope > p") !== null;
  if (!loose) contentBody = contentBody.replace(/\n{2,}/g, "\n");
  const indent = " ".repeat(marker.length);
  const [first = "", ...rest] = contentBody.split("\n");
  return [marker + task + first, ...rest.map((ln) => (ln === "" ? ln : indent + ln))].join("\n");
}

function serializeBlockquote(quote: Element): string {
  const inner = serializeChildren(quote)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (inner === "") return "";
  return `${inner
    .split("\n")
    .map((ln) => (ln === "" ? ">" : `> ${ln}`))
    .join("\n")}\n\n`;
}

function tableRows(table: Element): Element[][] {
  const lineList: Element[] = [];
  for (const kid of elementChildren(table)) {
    const tag = tagOf(kid);
    if (tag === "TR") lineList.push(kid);
    else if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") {
      lineList.push(...elementChildren(kid).filter((ch) => tagOf(ch) === "TR"));
    }
  }
  return lineList.map((lineNo) =>
    elementChildren(lineNo).filter((ch) => ["TH", "TD"].includes(tagOf(ch))),
  );
}

const cellText = (slot: Element) => serializeChildren(slot).replace(/\n+/g, " ").trim();

function cellAlignment(slot: Element): "---" | ":---:" | "---:" {
  const align = (slot as HTMLElement).style?.textAlign || slot.getAttribute("align") || "";
  return align === "center" ? ":---:" : align === "right" ? "---:" : "---";
}

function serializeTable(table: Element): string {
  const acc: string[] = [];
  let separated = false;
  for (const cells of tableRows(table)) {
    if (cells.length === 0) continue;
    acc.push(`| ${cells.map((ch) => cellText(ch).replaceAll("|", "\\|")).join(" | ")} |`);
    if (!separated) {
      separated = true;
      acc.push(`| ${cells.map(cellAlignment).join(" | ")} |`);
    }
  }
  return `${acc.join("\n")}\n\n`;
}

function serializeDetails(detailInfo: Element): string {
  const summaryEl = detailInfo.querySelector("[data-markdown-details-summary]");
  const summary = summaryEl ? serializeChildren(summaryEl).trim() : "";
  const bodyEl = detailInfo.querySelector("[data-markdown-details-content]");
  const markup = bodyEl ? serializeChildren(bodyEl).trim() : "";
  const open = detailInfo.getAttribute("data-markdown-details-open") === "true" ? " open" : "";
  return `<details${open}>\n<summary>${summary || "Details"}</summary>${markup ? `\n\n${markup}` : ""}\n</details>\n\n`;
}

export function serializeTableElementToMarkdown(table: Element): string {
  return serializeTable(table).trim();
}

export function serializeTableElementToCsv(table: Element): string {
  const quote = (str: string) => (/["\n,]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str);
  return tableRows(table)
    .map((cells) =>
      cells.map((slot) => quote((slot.textContent ?? "").replace(/\s+/g, " ").trim())).join(","),
    )
    .join("\n");
}

// ---------- sole code block + tidy ----------

/** The code text when the fragment's only visible content is one <pre>; otherwise null. */
function soleCodeBlock(root: Node): string | null {
  let pre: Element | null = null;
  let other = false;

  const visit = (node: Node): void => {
    if (other) return;
    if (isText(node)) {
      if (!/^\s*$/.test(node.textContent ?? "")) other = true;
      return;
    }
    if (!isElement(node)) return;
    const copy = copyOverride(node);
    if (copy !== null && copy.trim() !== "") {
      other = true;
      return;
    }
    if (node.hasAttribute("data-markdown-details")) {
      other = true;
      return;
    }
    const tag = tagOf(node);
    if (isSkipped(node)) return;
    if (tag === "PRE") {
      if (pre) other = true;
      else pre = node;
      return;
    }
    if (tag === "IMG" || tag === "HR" || tag === "TABLE") {
      other = true;
      return;
    }
    const earlier = pre;
    for (const kid of Array.from(node.childNodes)) visit(kid);
    // A list item that does not hold the block contributes a marker of its own.
    if (tag === "LI" && pre === earlier) other = true;
  };

  visit(root);
  if (other || pre === null) return null;
  const markup = ((innerCode(pre) ?? pre).textContent ?? "").replace(/\n$/, "");
  return markup;
}

function tidy(str: string): string {
  const acc: string[] = [];
  let fence: number | null = null;
  let blankRun = 0;
  for (const ln of str.split("\n")) {
    if (fence !== null) {
      acc.push(ln);
      const closing = /^ {0,3}(`+)[ \t]*$/.exec(ln);
      if (closing && closing[1]!.length >= fence) fence = null;
      continue;
    }
    const opening = /^ {0,3}(`{3,})/.exec(ln);
    if (opening) {
      fence = opening[1]!.length;
      blankRun = 0;
      acc.push(ln);
      continue;
    }
    const stripped = ln.replace(/[ \t]+$/, "");
    blankRun = stripped === "" ? blankRun + 1 : 0;
    if (blankRun <= 1) acc.push(stripped);
  }
  return acc.join("\n").trim();
}

export function serializeRenderedMarkdownFragment(container: Node): string {
  const plain = soleCodeBlock(container);
  if (plain !== null) return plain;
  return tidy(serializeChildren(container));
}

// ---------- selection -> clipboard ----------

const STRIP_SELECTOR =
  'button, input, script, style, svg, [aria-hidden="true"], .select-none, .sr-only';
const ALWAYS_STRIP = (el: Element) =>
  el.matches('[aria-hidden="true"]') || el.tagName.toLowerCase() === "svg";

function sanitizedHtml(fragmentHost: HTMLElement, insideFileLink: boolean): string {
  for (const el of Array.from(fragmentHost.querySelectorAll(STRIP_SELECTOR))) {
    // A file link keeps its visible text and button wrapper.
    if ((insideFileLink || el.closest(".reply-md-file-link")) && !ALWAYS_STRIP(el)) continue;
    el.remove();
  }
  return `<meta charset="utf-8">${fragmentHost.innerHTML}`;
}

export function replyMarkdownClipboardPayload(picked: Selection): MarkdownClipboardPayload | null {
  const texts: string[] = [];
  const htmls: string[] = [];

  for (let idx = 0; idx < picked.rangeCount; idx++) {
    const span = picked.getRangeAt(idx);
    if (span.collapsed) continue;
    const hostInfo = document.createElement("div");
    hostInfo.append(span.cloneContents());

    const ancestor = span.commonAncestorContainer;
    const ancestorElement = isElement(ancestor) ? ancestor : ancestor.parentElement;
    const insideFileLink = !!ancestorElement?.closest(".reply-md-file-link");
    const insideCode = !!ancestorElement?.closest("pre");

    const str = insideCode ? span.toString() : serializeRenderedMarkdownFragment(hostInfo);
    if (str === "") continue;
    texts.push(str);
    htmls.push(sanitizedHtml(hostInfo, insideFileLink));
  }
  return texts.length === 0 ? null : { text: texts.join("\n\n"), html: htmls.join("") };
}
