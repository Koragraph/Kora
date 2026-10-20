import { describe, expect, it } from "vite-plus/test";

import { isPublicFaviconHost } from "./hostnames.ts";

const verdicts = (hosts: readonly string[]) =>
  Object.fromEntries(hosts.map((host) => [host, isPublicFaviconHost(host)]));
const all = (hosts: readonly string[], value: boolean) =>
  Object.fromEntries(hosts.map((host) => [host, value]));

const expectPublic = (...hosts: string[]) => expect(verdicts(hosts)).toEqual(all(hosts, true));
const expectPrivate = (...hosts: string[]) => expect(verdicts(hosts)).toEqual(all(hosts, false));

describe("favicon host classification", () => {
  it("lets ordinary internet names and addresses through", () => {
    expectPublic(
      "gitlab.com",
      "docs.python.org",
      "example.ac.jp",
      "9.9.9.9",
      "208.67.222.222",
      "100.129.0.5",
      "172.15.255.255",
      "172.32.10.10",
      "192.169.0.1",
      "12.34.56.78",
    );
  });

  describe("IPv4", () => {
    it("blocks unspecified, loopback, RFC 1918 and link-local ranges", () => {
      expectPrivate(
        "0.0.0.0",
        "10.1.2.3",
        "10.255.0.255",
        "127.8.8.8",
        "192.168.0.254",
        "172.20.1.1",
        "172.31.0.1",
        "169.254.169.254",
      );
    });

    it("blocks the CGNAT block 100.64.0.0/10 and nothing just outside it", () => {
      expectPrivate("100.64.0.0", "100.77.1.2", "100.120.9.9", "100.127.255.254");
      expectPublic("100.63.255.255", "100.128.0.0");
    });

    it("does not treat malformed dotted text as an address", () => {
      expectPublic("192.168.1.300", "192.168.1");
    });
  });

  describe("IPv6", () => {
    it("blocks loopback, unique-local and link-local, bracketed or not", () => {
      expectPrivate("::1", "[::1]", "fdab::7", "fc12::1", "fe80::abcd", "FDFF:1::2");
      expectPublic("2001:4860:4860::8888");
    });

    it("unwraps IPv4-mapped addresses in dotted and hex form", () => {
      // c0a8:0001 = 192.168.0.1, ac10:0005 = 172.16.0.5, 644d:0102 = 100.77.1.2
      expectPrivate(
        "::ffff:192.168.0.1",
        "::ffff:172.16.0.5",
        "::ffff:100.77.1.2",
        "[::ffff:10.9.9.9]",
        "::ffff:c0a8:1",
        "::ffff:ac10:0005",
        "::ffff:644d:102",
      );
      expectPublic("::ffff:9.9.9.9", "::ffff:909:909");
    });
  });

  describe("names", () => {
    it("blocks single labels and private-use suffixes, in any case", () => {
      expectPrivate(
        "localhost",
        "nas",
        "camera.local",
        "db.internal",
        "nas.home.arpa",
        "home.arpa",
        "laptop.my-tail.ts.net",
        "MAC.TAIL1234.TS.NET",
        "web.localhost",
        "a.b.localhost",
        "SITE.LOCALHOST",
      );
    });

    it("ignores the trailing root dot", () => {
      expectPrivate(
        "localhost.",
        "camera.local.",
        "db.internal.",
        "laptop.my-tail.ts.net.",
        "nas.",
      );
      expectPublic("gitlab.com.");
    });

    it("treats blank input as private", () => {
      expectPrivate("", "\t  ");
    });
  });
});
