import { CONTEXT_CHIP_CLIPBOARD_MIME, ContextChipClipboardFragment } from "@kora/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export { CONTEXT_CHIP_CLIPBOARD_MIME };

const MAX_FRAGMENT_CHARS = 16_000_000;
const decodeFragment = Schema.decodeUnknownOption(ContextChipClipboardFragment);

export function encodeContextChipFragment(fragment: ContextChipClipboardFragment): string | null {
  const json = JSON.stringify(fragment);
  return json.length > MAX_FRAGMENT_CHARS ? null : json;
}

/** HTML is the portable flavor shared by browsers and native system clipboards. */
/** Room for the wrapper element, its attribute name, and the copied HTML itself. */
const HTML_WRAPPER_SLACK_CHARS = 4096;

const FRAGMENT_ATTRIBUTE = "data-kora-context-fragment";

const escapeHtmlText = (value: string): string =>
  value.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));

/** Wraps the copied markup (or the escaped text when there is none) in an element that carries the fragment. */
export function encodeContextChipClipboardHtml(
  plainText: string,
  fragmentJson: string,
  markup?: string,
): string {
  const [tag, body] = markup === undefined ? ["pre", escapeHtmlText(plainText)] : ["div", markup];
  return `<${tag} ${FRAGMENT_ATTRIBUTE}="${encodeURIComponent(fragmentJson)}">${body}</${tag}>`;
}

/** `decodeURIComponent` throws on a malformed escape; treat that as "no fragment". */
const tryDecodeUri = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const tryParseJson = (value: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
};

// `encodeURIComponent` expands one non-ASCII code unit to up to nine characters, so a
// fragment just under the limit must still survive the round trip through the attribute.
const MAX_HTML_CHARS = MAX_FRAGMENT_CHARS * 9 + HTML_WRAPPER_SLACK_CHARS;

export function decodeContextChipClipboardHtml(
  html: string | null | undefined,
): ContextChipClipboardFragment | null {
  if (!html || html.length > MAX_HTML_CHARS) return null;
  const attributeValue = html.match(/data-kora-context-fragment=["']([^"']+)["']/)?.[1];
  const raw = attributeValue ? tryDecodeUri(attributeValue) : null;
  return raw === null ? null : decodeContextChipFragment(raw);
}

/** Clipboard data is untrusted: anything that is not a valid version-1 fragment is ignored. */
export function decodeContextChipFragment(
  raw: string | null | undefined,
): ContextChipClipboardFragment | null {
  const parsed = raw && raw.length <= MAX_FRAGMENT_CHARS ? tryParseJson(raw) : undefined;
  return parsed?.ok ? Option.getOrNull(decodeFragment(parsed.value)) : null;
}
