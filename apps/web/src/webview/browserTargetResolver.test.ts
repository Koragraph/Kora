import { HostId } from "@kora/contracts";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const preparedLink = vi.fn();
vi.mock("~/atoms/session", () => ({ readPreparedLink: preparedLink }));

const loadResolver = () => import("./browserTargetResolver");
const HOST = HostId.make("env-under-test");

/** Both ends of each [first, last] address range. */
const edges = (ranges: ReadonlyArray<readonly [string, string]>) => ranges.flat();

describe("public favicon eligibility", () => {
  test.each(
    edges([
      ["192.0.0.0", "192.0.0.255"],
      ["192.0.2.0", "192.0.2.255"],
      ["192.88.99.0", "192.88.99.255"],
      ["198.51.100.0", "198.51.100.255"],
      ["203.0.113.0", "203.0.113.255"],
      ["224.0.0.0", "255.255.255.255"],
      ["100::", "100::ffff:ffff:ffff:ffff"],
      ["100:0:0:1::", "100:0:0:1:ffff:ffff:ffff:ffff"],
      ["2001:2::", "2001:2:0:ffff:ffff:ffff:ffff:ffff"],
      ["2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ]),
  )("%s is not eligible (reserved range edge)", async (host) => {
    const { isPublicFaviconHost } = await loadResolver();
    expect(isPublicFaviconHost(host)).toBe(false);
  });

  test.each([
    "::2",
    "::ffff:192.0.2.1",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fec0::",
    "5f00::1",
    "2001:5::1",
    "64:ff9b::c000:201",
    "64:ff9b::c0a8:101",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
  ])("%s is not eligible (special-purpose IPv6)", async (host) => {
    const { isPublicFaviconHost } = await loadResolver();
    expect(isPublicFaviconHost(host)).toBe(false);
  });

  test.each([
    "app.test",
    "printer.local",
    "printer.home.arpa",
    "devbox.example.ts.net",
    "service.internal",
    "hidden.onion",
    "127.0.0.1",
    "127.1",
    "10.1",
  ])("%s with trailing dots is not eligible (non-public name)", async (name) => {
    const { isPublicFaviconHost } = await loadResolver();
    expect(isPublicFaviconHost(`${name}..`)).toBe(false);
  });

  test("globally routable hosts, including those next to reserved ranges, are eligible", async () => {
    const { isPublicFaviconHost } = await loadResolver();
    const routable = [
      ...edges([
        ["191.255.255.255", "192.0.1.255"],
        ["192.0.3.0", "198.51.99.255"],
        ["198.51.101.0", "203.0.112.255"],
        ["203.0.114.0", "223.255.255.255"],
      ]),
      "example.com.",
      "example.com",
      "::ffff:8.8.8.8",
      "2001:30::1",
      "2001:20::1",
      "2001:4:112::1",
      "2001:3::1",
      "2001:1::1",
      "64:ff9b::808:808",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "1.1.1.1",
    ];
    expect(routable.filter((h) => !isPublicFaviconHost(h))).toEqual([]);
  });
});

describe("private network classification", () => {
  test("every private range edge is private", async () => {
    const { isPrivateNetworkHost } = await loadResolver();
    const inside = [
      "0.0.0.0",
      ...edges([
        ["10.0.0.0", "10.255.255.255"],
        ["100.64.0.0", "100.127.255.255"],
        ["127.0.0.0", "127.255.255.255"],
        ["169.254.0.0", "169.254.255.255"],
        ["172.16.0.0", "172.31.255.255"],
        ["192.168.0.0", "192.168.255.255"],
        ["198.18.0.0", "198.19.255.255"],
        ["fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
        ["fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ]),
    ];
    expect(inside.filter((h) => !isPrivateNetworkHost(h))).toEqual([]);
  });

  test("the address just outside each range is public", async () => {
    const { isPrivateNetworkHost } = await loadResolver();
    const outside = [
      "example.com.",
      "::ffff:8.8.8.8",
      "2001:4860:4860::8888",
      "fec0::",
      "fbff:ffff::",
      "198.20.0.0",
      "198.17.255.255",
      "192.169.0.0",
      "192.167.255.255",
      "172.32.0.0",
      "172.15.255.255",
      "169.255.0.0",
      "169.253.255.255",
      "100.128.0.0",
      "100.63.255.255",
      "1.0.0.0",
    ];
    expect(outside.filter(isPrivateNetworkHost)).toEqual([]);
  });

  test.each(["localhost", "devbox", "printer.local", "printer.home.arpa", "devbox.example.ts.net"])(
    "%s is private with one or two trailing dots",
    async (name) => {
      const { isPrivateNetworkHost } = await loadResolver();
      expect([`${name}.`, `${name}..`].every(isPrivateNetworkHost)).toBe(true);
    },
  );

  test("an IPv4-mapped IPv6 address follows the embedded IPv4", async () => {
    const { isPrivateNetworkHost } = await loadResolver();
    expect(isPrivateNetworkHost("::ffff:192.168.1.1")).toBe(true);
  });
});

describe("resolveDiscoveredDaemonUrl", () => {
  beforeEach(() => preparedLink.mockReset());

  const resolve = async (input: string) =>
    (await loadResolver()).resolveDiscoveredDaemonUrl(HOST, input);

  test("blank or unparseable input is returned verbatim", async () => {
    expect(await resolve("   ")).toBe("   ");
  });

  test("a public URL is only normalised", async () => {
    expect(await resolve("example.com/app")).toBe("https://example.com/app");
    expect(preparedLink).not.toHaveBeenCalled();
  });

  test("localhost stays localhost when the daemon itself is on 127.0.0.1", async () => {
    preparedLink.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    expect(await resolve("localhost:5173/app?x=1#top")).toBe("http://localhost:5173/app?x=1#top");
  });

  test("a loopback server is re-pointed at a remote daemon's private address", async () => {
    preparedLink.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    expect(await resolve("localhost:3000/app")).toBe("http://192.168.1.25:3000/app");
  });

  test("schemeless and 0.0.0.0 values become http://localhost URLs", async () => {
    preparedLink.mockReturnValue({ httpBaseUrl: "http://localhost:3773" });
    expect(await resolve("localhost:5173")).toBe("http://localhost:5173/");
    expect(await resolve("0.0.0.0:3000/app")).toBe("http://localhost:3000/app");
  });

  test("a public daemon address falls back to the original text", async () => {
    preparedLink.mockReturnValue({ httpBaseUrl: "https://daemon.example.com" });
    expect(await resolve("localhost:3000")).toBe("localhost:3000");
  });

  test("a daemon that is not connected falls back to the original text", async () => {
    preparedLink.mockReturnValue(null);
    expect(await resolve("localhost:3000")).toBe("localhost:3000");
  });
});
