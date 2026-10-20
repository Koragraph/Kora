import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Profile from "./agentProfile.ts";
import { ModelPick } from "./chat.ts";

const profileConfig = Schema.decodeUnknownSync(Profile.AgentProfileConfig);
const profileMap = Schema.decodeUnknownSync(Profile.AgentProfileConfigMap);
const profileRef = Schema.decodeUnknownSync(Profile.AgentProfileRef);

// Driver ids and instance ids share one slug grammar.
for (const [name, schema] of [
  ["AgentId", Profile.AgentId],
  ["AgentProfileId", Profile.AgentProfileId],
] as const) {
  describe(`${name} slugs`, () => {
    const decode = Schema.decodeUnknownSync(schema);

    it("accepts letter-led slugs with digits, dashes and underscores", () => {
      for (const ok of ["z", "codex", "claude", "lmstudio", "codex_home", "codex-job", "x9y8"]) {
        expect(decode(ok)).toBe(ok);
      }
    });

    it.each(["", "9codex", "-codex", "_codex", "codex home", "codex.home", "codex/home"])(
      "refuses %j",
      (bad) => {
        expect(() => decode(bad)).toThrow();
      },
    );

    it("trims before checking", () => {
      expect(decode("\t codex_job ")).toBe("codex_job");
    });

    it("allows 64 characters and no more", () => {
      expect(decode("q".repeat(64))).toBe("q".repeat(64));
      expect(() => decode("q".repeat(65))).toThrow();
    });
  });
}

describe("profile refs", () => {
  it.each([
    ["codex_job", "codex"],
    ["lmstudio_desk", "lmstudio"],
  ])("decodes %s → %s, known driver or not", (instanceId, driver) => {
    expect(profileRef({ driver, instanceId })).toEqual({ instanceId, driver });
  });

  it("refuses a driver that is not a slug", () => {
    expect(() => profileRef({ instanceId: "codex", driver: "9x" })).toThrow();
  });
});

describe("profile config envelope", () => {
  it("needs only a driver", () => {
    const minimal = profileConfig({ driver: "claude" });
    expect(minimal.driver).toBe("claude");
    for (const key of ["displayName", "enabled", "config"] as const) {
      expect(minimal[key]).toBeUndefined();
    }
  });

  it("keeps the driver's own config untouched, for known and unknown drivers", () => {
    const codexConfig = { binaryPath: "/opt/codex", homePath: "~/.codex-home" };
    const known = profileConfig({
      driver: "codex",
      enabled: false,
      accentColor: "#0ea5e9",
      displayName: "Home Codex",
      config: codexConfig,
    });
    expect([known.displayName, known.accentColor, known.enabled]).toEqual([
      "Home Codex",
      "#0ea5e9",
      false,
    ]);
    expect(known.config).toEqual(codexConfig);

    const forkConfig = { model: "qwen3", contextLength: 32768 };
    const fork = profileConfig({
      driver: "lmstudio",
      displayName: "LM Studio",
      enabled: true,
      config: forkConfig,
    });
    expect([fork.driver, fork.config]).toEqual(["lmstudio", forkConfig]);
  });

  it("trims envelope strings and env names, but not env values", () => {
    expect(
      profileConfig({
        driver: " claude ",
        displayName: " Claude via proxy ",
        accentColor: " #10b981 ",
        environment: [{ name: " PROXY_TOKEN ", value: " secret " }],
      }),
    ).toMatchObject({
      driver: "claude",
      displayName: "Claude via proxy",
      accentColor: "#10b981",
      environment: [{ name: "PROXY_TOKEN", value: " secret " }],
    });
  });

  it("keeps environment variables, sensitive or not, empty values included", () => {
    const environment = [
      { name: "BASE_URL", value: "https://proxy.example.net", sensitive: false },
      { name: "PROXY_TOKEN", value: "tok-123", sensitive: true },
      { name: "UNSET_ME", value: "", sensitive: false },
    ];
    expect(profileConfig({ driver: "claude", environment }).environment).toEqual(environment);
  });

  it.each([
    [
      "an env name with a dash",
      { driver: "codex", environment: [{ name: "BAD-NAME", value: "v", sensitive: false }] },
    ],
    ["a blank display name", { driver: "codex", displayName: " \t" }],
    ["an empty driver", { driver: "" }],
    ["a driver with a space", { driver: "two words" }],
  ])("refuses %s", (_label, input) => {
    expect(() => profileConfig(input)).toThrow();
  });
});

describe("profile config map", () => {
  it("holds several instances of one driver beside other drivers", () => {
    const map = profileMap({
      claude: { driver: "claude" },
      codex_home: { driver: "codex", displayName: "Home", config: { homePath: "~/.codex-home" } },
      codex_job: { driver: "codex", config: { homePath: "~/.codex-job" } },
      lmstudio_desk: { driver: "lmstudio", config: { endpoint: "http://127.0.0.1:1234" } },
    });
    expect(Object.keys(map).sort()).toEqual(["claude", "codex_home", "codex_job", "lmstudio_desk"]);
    const at = (id: string) => map[Profile.AgentProfileId.make(id)];
    expect(at("codex_home")?.driver).toBe("codex");
    expect(at("codex_job")?.config).toEqual({ homePath: "~/.codex-job" });
    expect(at("lmstudio_desk")?.driver).toBe("lmstudio");
  });

  it("refuses a key that is not an instance slug", () => {
    expect(() => profileMap({ "3codex": { driver: "codex" } })).toThrow();
  });
});

describe("legacy driver ids", () => {
  it("renames the old Claude driver id and leaves the rest alone", () => {
    expect(["claudeAgent", "codex", undefined].map(Profile.migrateLegacyAgentId)).toEqual([
      "claude",
      "codex",
      undefined,
    ]);
  });

  it("send a stored model pick with the old id to the Claude instance", () => {
    const pick = Schema.decodeUnknownSync(ModelPick)({
      model: "claude-haiku-5",
      provider: "claudeAgent",
    });
    expect(pick.instanceId).toBe("claude");
  });
});
