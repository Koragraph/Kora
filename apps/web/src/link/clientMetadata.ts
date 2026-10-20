import type {
  ShellBridge,
  ClientOs,
  AuthClientDisplayMetadata,
  AuthClientMetadataDeviceType,
} from "@kora/contracts";

interface BrowserIdentity {
  readonly maxTouchPoints: number;
  readonly platform: string;
  readonly userAgent: string;
}

const PLACEHOLDER_VERSION = "0.0.0";

/** iPadOS asks for desktop sites by default and reports a Mac user agent with a touch screen. */
const looksLikeIpadOs = ({ userAgent, platform, maxTouchPoints }: BrowserIdentity) =>
  /macintosh/i.test(userAgent) && /mac/i.test(platform) && maxTouchPoints > 1;

const blank = (str: string) => str.trim() === "";

export function browserClientOs(identity: BrowserIdentity): ClientOs {
  const ua = identity.userAgent;
  if (blank(ua)) return "unknown";
  if (/iphone|ipad|ipod/i.test(ua) || looksLikeIpadOs(identity)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/cros/i.test(ua)) return "ChromeOS";
  if (/windows/i.test(ua)) return "Windows";
  if (/macintosh|mac os x/i.test(ua)) return "macOS";
  if (/linux|x11/i.test(ua)) return "Linux";
  return "other";
}

export function browserFamily(userAgent: string): string {
  if (blank(userAgent)) return "unknown";
  const ranked: ReadonlyArray<readonly [RegExp, string]> = [
    [/edg\/|edge\/|edga\/|edgios\//i, "Edge"],
    [/opr\/|opios\//i, "Opera"],
    [/samsungbrowser\//i, "Samsung Internet"],
    [/firefox\/|fxios\//i, "Firefox"],
    [/chrome\/|crios\//i, "Chrome"],
    [/safari\//i, "Safari"],
  ];
  return ranked.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "other";
}

export function browserDeviceType(identity: BrowserIdentity): AuthClientMetadataDeviceType {
  const ua = identity.userAgent;
  if (blank(ua)) return "unknown";
  if (
    /ipad|tablet|kindle|silk/i.test(ua) ||
    (/android/i.test(ua) && !/mobile/i.test(ua)) ||
    looksLikeIpadOs(identity)
  ) {
    return "tablet";
  }
  if (/iphone|ipod|android.*mobile|mobile/i.test(ua)) return "mobile";
  return "desktop";
}

function shellOs(hostOs: string | undefined): ClientOs {
  if (hostOs === undefined) return "unknown";
  const known: Record<string, ClientOs> = { linux: "Linux", win32: "Windows", darwin: "macOS" };
  return known[hostOs] ?? (hostOs === "" ? "unknown" : "other");
}

export function clientPresentationMetadata(args: {
  appVersion: string;
  hosted: boolean;
  identity: BrowserIdentity;
  shellBridge: Pick<ShellBridge, "getClientPlatform"> | undefined;
}): AuthClientDisplayMetadata {
  const version = args.appVersion === PLACEHOLDER_VERSION ? {} : { appVersion: args.appVersion };
  if (args.shellBridge) {
    return {
      label: "Kora Desktop",
      deviceType: "desktop",
      os: shellOs(args.shellBridge.getClientPlatform?.()),
      surface: "desktop",
      ...version,
    };
  }
  return {
    label: "Kora Web",
    deviceType: browserDeviceType(args.identity),
    os: browserClientOs(args.identity),
    surface: "web",
    webDeployment: args.hosted ? "hosted" : "server",
    browser: browserFamily(args.identity.userAgent),
    ...version,
  };
}
