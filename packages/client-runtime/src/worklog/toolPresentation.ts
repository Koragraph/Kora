import type {
  ToolTraceSurface,
  ToolTraceSource,
  ToolTraceIcon,
  ToolTraceAppRef,
} from "@kora/contracts";

export interface ExtractedToolActivityPresentation {
  readonly toolSurface?: ToolTraceSurface;
  readonly toolIcon?: ToolTraceIcon;
  readonly toolSource?: ToolTraceSource;
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A string, trimmed, non-empty and no longer than `max`. */
const boundedText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= max ? trimmed : undefined;
};

const MAX_URL_LENGTH = 4096;

/** Normalised href for a URL whose scheme is on the allow-list; anything else is rejected. */
const safeUrl = (value: unknown, schemes: ReadonlySet<string>): string | undefined => {
  const text = boundedText(value, MAX_URL_LENGTH);
  if (text === undefined) return undefined;
  try {
    const url = new URL(text);
    return schemes.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const IMAGE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "data:"]);
const PAGE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

const readAppRef = (value: unknown): ToolTraceAppRef | undefined => {
  if (!isRecord(value)) return undefined;
  if (value._tag === "app-id") {
    const appId = boundedText(value.appId, 512);
    return appId !== undefined && /^[A-Za-z0-9._-]+$/.test(appId)
      ? { _tag: "app-id", appId }
      : undefined;
  }
  if (value._tag === "display-name") {
    const displayName = boundedText(value.displayName, 160);
    return displayName === undefined ? undefined : { _tag: "display-name", displayName };
  }
  return undefined;
};

const readIcon = (value: unknown): ToolTraceIcon | undefined => {
  if (!isRecord(value)) return undefined;
  switch (value._tag) {
    case "website": {
      const pageUrl = safeUrl(value.pageUrl, PAGE_SCHEMES);
      if (pageUrl === undefined) return undefined;
      const faviconUrl = safeUrl(value.faviconUrl, IMAGE_SCHEMES);
      const faviconUrlDark = safeUrl(value.faviconUrlDark, IMAGE_SCHEMES);
      return {
        _tag: "website",
        pageUrl,
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
        ...(faviconUrlDark === undefined ? {} : { faviconUrlDark }),
      };
    }
    case "native-app": {
      const app = readAppRef(value.app);
      return app === undefined ? undefined : { _tag: "native-app", app };
    }
    case "themed-logo": {
      const logoUrl = safeUrl(value.logoUrl, IMAGE_SCHEMES);
      if (logoUrl === undefined) return undefined;
      const logoUrlDark = safeUrl(value.logoUrlDark, IMAGE_SCHEMES);
      return {
        _tag: "themed-logo",
        logoUrl,
        ...(logoUrlDark === undefined ? {} : { logoUrlDark }),
      };
    }
    default:
      return undefined;
  }
};

const SOURCE_KINDS: ReadonlySet<unknown> = new Set(["browser", "computer", "integration"]);

const readSource = (value: unknown): ToolTraceSource | undefined => {
  if (!isRecord(value)) return undefined;
  const key = boundedText(value.key, 512);
  const name = boundedText(value.name, 160);
  const kind = value.kind;
  if (key === undefined || name === undefined || !SOURCE_KINDS.has(kind)) return undefined;
  const icon = readIcon(value.icon);
  return {
    key,
    name,
    kind: kind as ToolTraceSource["kind"],
    ...(icon === undefined ? {} : { icon }),
  };
};

export function extractToolActivityPresentation(
  payload: unknown,
): ExtractedToolActivityPresentation {
  if (!isRecord(payload)) return {};
  const surface = payload.toolSurface;
  const toolIcon = readIcon(payload.toolIcon);
  const toolSource = readSource(payload.toolSource);
  return {
    ...(surface === "browser" || surface === "computer" ? { toolSurface: surface } : {}),
    ...(toolIcon === undefined ? {} : { toolIcon }),
    ...(toolSource === undefined ? {} : { toolSource }),
  };
}
