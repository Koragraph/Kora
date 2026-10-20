// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the test writes fake `agy` binaries and an engines.json under temp dirs.
// Antigravity auto-detect: the `agy models` parse, the picker models, the provider entry's states (installed / missing /
// signed out), the cache, and the explicit path from Settings > Engines. No real `agy` runs.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  ANTIGRAVITY_INSTANCE_ID,
  backgroundAgyEnv,
  applyAntigravityState,
  mapAgyModels,
  parseAgyModels,
  parseAgyUsage,
  readAgyUsage,
  probeAntigravity,
  readAgyCache,
  refreshAntigravity,
  resolveAgyBin,
  startAntigravityDetect,
  agyCacheAgeMs,
  AGY_CACHE_FRESH_MS,
} from "./antigravityModels.ts";
import { daemonConfig } from "./config.ts";

// Recorded from agy 1.3.3 (`agy models`; "Fetching available models..." goes to stderr).
const MODELS_OUT = [
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

const entry = () =>
  daemonConfig.providers.find((p) => p.instanceId === ANTIGRAVITY_INSTANCE_ID) as unknown as {
    driver: string;
    installed: boolean;
    version: string | null;
    status: string;
    auth: { status: string };
    message?: string;
    models: Array<{ slug: string; name: string; isDefault?: boolean }>;
  };

test("parse: id<TAB>label lines only; progress text, blanks, junk ids and repeats are skipped", () => {
  const rows = parseAgyModels(
    `Fetching available models...\n${MODELS_OUT}not a row\n-bad\tX\ngemini-3.8-flash-low\tdup\n`,
  );
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" });
  assert.equal(rows.at(-1)!.id, "gpt-oss-120b-medium");
});

test("models: labels as names, no effort select (it is in the id), one default = agy's own when listed", () => {
  const rows = parseAgyModels(MODELS_OUT);
  const ms = mapAgyModels(rows, "Gemini 3.8 Flash (Low)");
  assert.equal(ms.length, 7);
  assert.deepEqual(
    ms.filter((m) => m.isDefault).map((m) => m.slug),
    ["gemini-3.8-flash-low"],
  );
  assert.equal(ms[0]!.name, "Gemini 3.8 Flash (High)");
  assert.equal(ms[0]!.capabilities, null);
  assert.deepEqual(
    mapAgyModels(rows, "Something gone")
      .filter((m) => m.isDefault)
      .map((m) => m.slug),
    ["gemini-3.8-flash-high"],
  );
});

test("the provider entry: advertised as driver antigravity; missing = a calm install reason; found = ready with models", () => {
  assert.equal(entry().driver, "antigravity");
  assert.equal(
    (
      daemonConfig.settings.providerInstances as Record<
        string,
        { driver: string; enabled: boolean }
      >
    ).antigravity?.driver,
    "antigravity",
  );
  applyAntigravityState({ installed: false, version: null, models: null });
  assert.equal(entry().installed, false);
  assert.equal(entry().status, "error");
  assert.match(entry().message!, /Install Antigravity/);
  assert.deepEqual(entry().models, []);

  assert.equal(
    applyAntigravityState({
      installed: true,
      version: "1.3.3",
      models: parseAgyModels(MODELS_OUT),
    }),
    true,
  );
  assert.equal(entry().installed, true);
  assert.equal(entry().status, "ready");
  assert.equal(entry().version, "1.3.3");
  assert.equal(entry().auth.status, "authenticated");
  assert.equal(entry().message, undefined);
  assert.equal(entry().models.length, 7);
  assert.equal(
    applyAntigravityState({
      installed: true,
      version: "1.3.3",
      models: parseAgyModels(MODELS_OUT),
    }),
    false,
    "no change, no push",
  );

  // a probe that failed keeps the last list; signed out says so
  applyAntigravityState({
    installed: true,
    version: "1.3.3",
    models: null,
    signedOut: true,
    problem:
      "Antigravity is not signed in. Run agy in Terminal once and sign in with your Google account.",
  });
  assert.equal(entry().auth.status, "unauthenticated");
  assert.equal(entry().status, "error");
  assert.equal(entry().models.length, 7);
  assert.ok(JSON.stringify(daemonConfig.providers).includes('"antigravity"'));
  // no undefined anywhere in the wire value (RpcSerialization dies on a nested undefined)
  const walk = (v: unknown): void => {
    assert.notEqual(v, undefined);
    if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(entry());
});

function fakeAgy(dir: string, script: string): string {
  const bin = path.join(dir, "agy");
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

test("probe + cache: version and models from a fake agy, the list cached for the next boot; not found = not installed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-agy-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-agy-bin-"));
  const out = path.join(dir, "models.txt");
  fs.writeFileSync(out, MODELS_OUT);
  const bin = fakeAgy(
    dir,
    `case "$1" in --version) echo 1.3.3;; models) echo "Fetching available models..." >&2; /bin/cat "${out}";; esac`,
  );
  try {
    const r = await probeAntigravity({ bin });
    assert.equal(r.installed, true);
    assert.equal(r.version, "1.3.3");
    assert.equal(r.models?.length, 7);
    assert.deepEqual(await probeAntigravity({ bin: null }), {
      installed: false,
      version: null,
      models: null,
      problem: null,
      signedOut: false,
    });

    // Settings > Engines' explicit path is what refresh uses; the list lands in the cache
    fs.writeFileSync(
      path.join(home, "engines.json"),
      JSON.stringify({ executables: { antigravity: bin } }),
    );
    assert.equal(
      resolveAgyBin({ home, env: { PATH: "/nonexistent" }, userHome: "/nonexistent" }),
      bin,
    );
    assert.equal(await refreshAntigravity(home), true);
    assert.equal(readAgyCache(home)?.models.length, 7);
    assert.equal(readAgyCache(home)?.version, "1.3.3");
    assert.equal(entry().status, "ready");

    // a signed-out CLI
    const out2 = fakeAgy(
      dir,
      `case "$1" in --version) echo 1.3.3;; models) echo "error: not signed in. Run agy to log in." >&2; exit 1;; esac`,
    );
    const s = await probeAntigravity({ bin: out2 });
    assert.equal(s.signedOut, true);
    assert.equal(s.models, null);
    assert.match(s.problem!, /not signed in/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve: PATH first, then ~/.local/bin; an explicit path that is gone means not installed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-agy-"));
  const user = fs.mkdtempSync(path.join(os.tmpdir(), "kora-agy-user-"));
  try {
    const local = path.join(user, ".local", "bin");
    fs.mkdirSync(local, { recursive: true });
    assert.equal(
      resolveAgyBin({
        home,
        env: { PATH: "/nonexistent" },
        userHome: user,
        isExecutable: () => false,
      }),
      null,
    );
    // Windows runs only PATHEXT names from a search (npm's extensionless sh shim is not one)
    const agyName = process.platform === "win32" ? "agy.cmd" : "agy";
    fs.writeFileSync(path.join(local, agyName), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(
      resolveAgyBin({ home, env: { PATH: "/nonexistent" }, userHome: user }),
      path.join(local, agyName),
    );
    fs.writeFileSync(
      path.join(home, "engines.json"),
      JSON.stringify({ executables: { antigravity: "/gone/agy" } }),
    );
    assert.equal(resolveAgyBin({ home, env: { PATH: "/nonexistent" }, userHome: user }), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(user, { recursive: true, force: true });
  }
});

// Recorded 2026-10-13 from `agy -p /usage --output-format json` (0 tokens, no model call); descriptions trimmed.
const AGY_USAGE_JSON = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-19T12:57:19Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9988222122192383,
              reset_time: "2026-10-19T12:57:19Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-10-13T11:04:17Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.37,
              reset_time: "2026-10-20T06:04:17Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0,
              reset_time: "2026-10-13T11:04:17Z",
            },
          ],
        },
      ],
    },
  },
});

test("agy /usage JSON → one window per bucket, labelled by group, usedPercent from remaining_fraction", () => {
  const r = parseAgyUsage(AGY_USAGE_JSON);
  assert.ok(r);
  assert.equal(r.provider, "antigravity");
  assert.equal(r.complete, true);
  assert.deepEqual(
    r.windows.map((w) => [w.id, w.kind, w.label, w.usedPercent, w.windowMinutes]),
    [
      ["gemini-weekly", "weekly", "Gemini Models · Weekly", 0, 10080],
      ["gemini-5h", "session", "Gemini Models · 5-hour", 0, 300],
      ["3p-weekly", "weekly", "Claude and GPT models · Weekly", 63, 10080],
      ["3p-5h", "session", "Claude and GPT models · 5-hour", 100, 300],
    ],
  );
  assert.equal(r.windows[0]!.resetsAt, Date.parse("2026-10-19T12:57:19Z"));
  // Progress noise before the JSON line still parses; anything else is not a report.
  assert.equal(parseAgyUsage(`Checking quota...\n${AGY_USAGE_JSON}\n`)?.windows.length, 4);
  assert.equal(parseAgyUsage("agy: not signed in"), null);
  assert.equal(parseAgyUsage(JSON.stringify({ status: "ERROR" })), null);
});

test("readAgyUsage: not installed is 'absent', a timeout is a failed read, never a model call", async () => {
  assert.equal(await readAgyUsage({ bin: null }), "absent");
  let args: string[] = [];
  const ok = await readAgyUsage({
    bin: "/x/agy",
    runFn: async (_b, a) => {
      args = a;
      return { code: 0, stdout: AGY_USAGE_JSON, stderr: "", timedOut: false };
    },
  });
  assert.deepEqual(args.slice(0, 4), ["-p", "/usage", "--output-format", "json"]);
  assert.ok(ok && ok !== "absent" && ok.windows.length === 4);
  const slow = await readAgyUsage({
    bin: "/x/agy",
    runFn: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
  });
  assert.equal(slow, null);
});

test("backgroundAgyEnv: no PATH (agy can never `open` a login page), HOME kept for its keychain sign-in", () => {
  const env = backgroundAgyEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/me",
    USER: "me",
    SECRET_TOKEN: "x",
  });
  assert.equal(env.PATH, "/var/empty");
  assert.equal(env.HOME, "/Users/me");
  assert.equal(env.USER, "me");
  assert.equal(env.SECRET_TOKEN, undefined);
});

test("backgroundAgyEnv on macOS is unchanged: PATH /var/empty, no BROWSER, no Windows keys", () => {
  const env = backgroundAgyEnv(
    { PATH: "/usr/bin", HOME: "/Users/me", SystemRoot: "C:\\Windows" },
    "darwin",
    () => {
      throw new Error("the Windows guard folder is never made on macOS");
    },
  );
  assert.deepEqual(env, { PATH: "/var/empty", HOME: "/Users/me" });
});

test("backgroundAgyEnv on Windows: rundll32/cmd/a $BROWSER cannot be found by name; SystemRoot and the profile stay", () => {
  const env = backgroundAgyEnv(
    {
      Path: "C:\\Windows\\System32;C:\\Users\\me\\bin",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\me",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      GITHUB_TOKEN: "x",
    },
    "win32",
    () => "C:\\Users\\me\\.kora\\agy-empty-path",
  );
  assert.equal(
    env.PATH,
    "C:\\Users\\me\\.kora\\agy-empty-path",
    "PATH is only the empty guard folder",
  );
  assert.equal(
    env.Path,
    undefined,
    "the user's Path (with System32, where rundll32 lives) never reaches agy",
  );
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, "1");
  assert.equal(env.BROWSER, "kora-blocked-browser");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.USERPROFILE, "C:\\Users\\me");
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("boot: a fresh cached model list means no live `agy models` call (an account call to Google); no cache means one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-agy-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-agy-bin-"));
  const log = path.join(dir, "calls.txt");
  const out = path.join(dir, "models.txt");
  fs.writeFileSync(out, MODELS_OUT);
  const bin = fakeAgy(
    dir,
    `echo "$1" >> "${log}"; case "$1" in --version) echo 1.3.3;; models) /bin/cat "${out}";; esac`,
  );
  fs.writeFileSync(
    path.join(home, "engines.json"),
    JSON.stringify({ executables: { antigravity: bin } }),
  );
  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  try {
    startAntigravityDetect(home); // no cache yet: probes
    for (let i = 0; i < 200 && !readAgyCache(home); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.ok(calls().includes("models"), "cold boot probes");
    assert.equal(agyCacheAgeMs(home)! < AGY_CACHE_FRESH_MS, true);
    fs.rmSync(log);
    startAntigravityDetect(home); // fresh cache: nothing spawned
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(calls(), []);
    assert.equal(entry().models.length > 0, true, "the picker still has the cached list");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
