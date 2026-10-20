// Just enough XML for Office parts: attribute reading and entity decoding. The parts are machine-written and
// regular; a full DOM parser is neither available in a worker nor needed.
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return safeFromCodePoint(Number.parseInt(body.slice(2), 16), whole);
    if (body.startsWith("#")) return safeFromCodePoint(Number.parseInt(body.slice(1), 10), whole);
    return ENTITIES[body] ?? whole;
  });
}

function safeFromCodePoint(codePoint: number, fallback: string): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : fallback;
}

const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** `attributes('<c r="B2" t="s">')` -> `{ r: "B2", t: "s" }` (entity-decoded). */
export function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1];
    if (name === undefined) continue;
    result[name] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return result;
}

/** The concatenated text of every `<tag ...>text</tag>` in `xml` (rich-text runs, `<w:t>`, `<a:t>`, `<t>`). */
export function textRuns(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let out = "";
  for (const match of xml.matchAll(pattern)) out += decodeXmlEntities(match[1] ?? "");
  return out;
}
