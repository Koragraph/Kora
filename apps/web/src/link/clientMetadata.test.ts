import {
  clientPresentationMetadata,
  browserFamily,
  browserDeviceType,
  browserClientOs,
} from "./clientMetadata";
import { describe, expect, it } from "vite-plus/test";

const shellChrome = {
  maxTouchPoints: 0,
  platform: "Win32",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
};

describe("client telemetry metadata", () => {
  it("uses Electron's client platform for desktop", () => {
    expect(
      clientPresentationMetadata({
        shellBridge: { getClientPlatform: () => "darwin" },
        identity: shellChrome,
        hosted: false,
        appVersion: "1.2.3",
      }),
    ).toEqual({
      appVersion: "1.2.3",
      surface: "desktop",
      os: "macOS",
      deviceType: "desktop",
      label: "Kora Desktop",
    });
  });

  it("identifies phone and tablet browsers", () => {
    const iphone = {
      maxTouchPoints: 5,
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    };
    const androidTablet = {
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    };
    const ipadosShellUa = {
      maxTouchPoints: 5,
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    };

    expect(browserDeviceType(iphone)).toBe("mobile");
    expect(browserClientOs(iphone)).toBe("iOS");
    expect(browserFamily(iphone.userAgent)).toBe("Safari");
    expect(browserDeviceType(androidTablet)).toBe("tablet");
    expect(browserClientOs(androidTablet)).toBe("Android");
    expect(browserDeviceType(ipadosShellUa)).toBe("tablet");
    expect(browserClientOs(ipadosShellUa)).toBe("iOS");
  });
  it("distinguishes hosted web from server-served web", () => {
    expect(
      clientPresentationMetadata({
        shellBridge: undefined,
        identity: shellChrome,
        hosted: true,
        appVersion: "1.2.3",
      }),
    ).toMatchObject({
      appVersion: "1.2.3",
      browser: "Chrome",
      os: "Windows",
      deviceType: "desktop",
      webDeployment: "hosted",
      surface: "web",
    });

    expect(
      clientPresentationMetadata({
        shellBridge: undefined,
        identity: shellChrome,
        hosted: false,
        appVersion: "0.0.0",
      }),
    ).toMatchObject({ surface: "web", webDeployment: "server" });
  });
});
