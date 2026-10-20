/**
 * Which icon a tool-activity row shows. Kora is local-only: a reply or a tool row never makes the app fetch an icon from
 * the page's site or a favicon service (that told Google and the site which links you were shown, while images in the
 * same reply waited behind a consent click; pl4 S3-12). Only an icon that arrived inline (a `data:` URL) is shown; the
 * caller draws its glyph otherwise.
 */
const MAX_URL_LENGTH = 4096;

const inlineIcon = (value: string | undefined): string | null => {
  if (!value || value.length > MAX_URL_LENGTH || !URL.canParse(value)) return null;
  return new URL(value).protocol === "data:" ? value : null;
};

type ToolIcon = {
  readonly faviconUrlDark?: string | undefined;
  readonly faviconUrl?: string | undefined;
  readonly pageUrl: string;
};

export function toolActivityFaviconUrl(
  icon: ToolIcon,
  appearance: "light" | "dark",
  _size = 32,
): string | null {
  const own = inlineIcon(icon.faviconUrl);
  if (appearance === "dark") return inlineIcon(icon.faviconUrlDark) ?? own;
  return own;
}
