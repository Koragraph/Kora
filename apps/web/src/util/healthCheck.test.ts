import { describe, expect, it, vi } from "vite-plus/test";

import {
  exportDiagnostics,
  checksForSurface,
  fetchHealthReport,
  fixSegments,
  localModelServers,
  orderChecks,
  parseHealthReport,
  agentsUsable,
  summarizeHealth,
  type HealthCheck,
} from "./healthCheck";
import { thisComputer } from "./utils";

const check = (
  id: string,
  status: HealthCheck["status"],
  fix: string | null = null,
): HealthCheck => ({
  id,
  label: id,
  status,
  detail: `${id} detail`,
  fix,
});

const report = (checks: HealthCheck[]) => ({
  koraVersion: "0.1.8",
  platform: "darwin",
  cwd: null,
  generatedAt: 1,
  checks,
});

describe("parseHealthReport", () => {
  it("keeps well-formed rows, drops junk, and reads an unknown status as a warning", () => {
    const parsed = parseHealthReport({
      koraVersion: "0.1.8",
      checks: [
        { id: "daemon", label: "Kora daemon", status: "ok", detail: "Running", fix: null },
        { id: "new-check", label: "Something new", status: "mystery", detail: "?", fix: "" },
        { nope: true },
        "junk",
      ],
    });
    expect(parsed?.checks.map((c) => [c.id, c.status, c.fix])).toEqual([
      ["daemon", "ok", null],
      ["new-check", "warn", null],
    ]);
  });

  it("rejects bodies without checks", () => {
    expect(parseHealthReport({ _tag: "HostResourceNotFoundError" })).toBeNull();
    expect(parseHealthReport(null)).toBeNull();
  });
});

describe("summarizeHealth / orderChecks", () => {
  it("the worst status sets the tone", () => {
    expect(summarizeHealth(report([check("a", "ok"), check("b", "skip")]))).toEqual({
      tone: "ok",
      text: "Everything checks out",
    });
    expect(summarizeHealth(report([check("a", "warn")])).text).toBe("Works, with 1 warning");
    expect(
      summarizeHealth(report([check("a", "fail"), check("b", "fail"), check("c", "warn")])),
    ).toEqual({ tone: "fail", text: "2 problems and 1 warning to fix" });
  });

  it("does not count agent rows while one agent works", () => {
    const summary = summarizeHealth(
      report([check("daemon", "ok"), check("claude-auth", "fail"), check("codex", "ok")]),
    );
    expect(summary.tone).toBe("ok");
    expect(summary.text).toContain("optional");
    expect(
      summarizeHealth(
        report([check("daemon", "fail"), check("claude-auth", "fail"), check("codex", "ok")]),
      ).text,
    ).toBe("1 problem to fix");
  });

  it("counts no usable agent as the one problem", () => {
    const rows = [
      check("claude-cli", "fail"),
      check("claude-auth", "skip"),
      check("codex", "skip"),
    ];
    expect(summarizeHealth(report(rows))).toEqual({
      tone: "fail",
      text: "No coding agent works yet: get any one of Claude Code, Codex, OpenCode or Antigravity ready",
    });
    expect(summarizeHealth(report([...rows, check("disk", "warn")])).text).toBe(
      "1 problem and 1 warning to fix",
    );
  });

  it("agentsUsable ignores a bare Claude CLI and a report without agent rows", () => {
    expect(agentsUsable([check("claude-cli", "ok")])).toBe(false);
    expect(agentsUsable([check("antigravity", "ok")])).toBe(true);
    expect(agentsUsable([check("disk", "ok")])).toBeNull();
  });

  it("puts problems first and keeps the daemon's order within a status", () => {
    const ordered = orderChecks([
      check("disk", "ok"),
      check("swarm", "skip"),
      check("claude-auth", "fail"),
      check("graph", "warn"),
      check("daemon", "ok"),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(["claude-auth", "graph", "disk", "daemon", "swarm"]);
  });
});

describe("fixSegments", () => {
  it("splits backtick commands out as code", () => {
    expect(fixSegments("Run `claude auth login` in a terminal.")).toEqual([
      { text: "Run ", code: false },
      { text: "claude auth login", code: true },
      { text: " in a terminal.", code: false },
    ]);
  });
});

describe("fetchHealthReport / exportDiagnostics", () => {
  it("asks /api/doctor with the project, subset and probe flag", async () => {
    const fetchImpl = vi.fn(async () => Response.json(report([check("disk", "ok")])));
    const result = await fetchHealthReport(
      "http://127.0.0.1:8797",
      { cwd: "/Users/me/app", only: ["disk", "graph"], probe: false },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.checks).toHaveLength(1);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe("/api/doctor");
    expect(url.searchParams.get("cwd")).toBe("/Users/me/app");
    expect(url.searchParams.get("only")).toBe("disk,graph");
    expect(url.searchParams.get("probe")).toBe("0");
  });

  it("an older daemon (404) says to update Kora", async () => {
    const fetchImpl = async () => new Response("{}", { status: 404 });
    await expect(
      fetchHealthReport("http://127.0.0.1:8797", {}, fetchImpl as typeof fetch),
    ).rejects.toThrow(/Update Kora/);
  });

  it("export posts JSON (never a simple form post) and returns the path", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true, path: "/Users/me/Downloads/kora-diagnostics-1.json", bytes: 9 }),
    );
    const result = await exportDiagnostics(
      "http://127.0.0.1:8797",
      { cwd: "/Users/me/app", dir: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.path).toMatch(/kora-diagnostics/);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ cwd: "/Users/me/app", dir: null });
  });

  it("export surfaces the daemon's reason", async () => {
    const fetchImpl = async () =>
      Response.json(
        { ok: false, reason: "Choose a folder inside your home folder." },
        { status: 400 },
      );
    await expect(
      exportDiagnostics("http://x", { dir: "/etc" }, fetchImpl as typeof fetch),
    ).rejects.toThrow("Choose a folder inside your home folder.");
  });
});

describe("localModelServers", () => {
  it("reads the local-models check's servers and ignores junk", () => {
    const parsed = parseHealthReport({
      checks: [
        {
          id: "local-models",
          label: "Local models",
          status: "ok",
          detail: "Ollama: 1 model",
          fix: null,
          data: {
            servers: [
              {
                kind: "ollama",
                baseUrl: "http://127.0.0.1:11434",
                reachable: true,
                models: ["qwen3-coder", 3],
              },
              { kind: "vllm", baseUrl: "x", reachable: true, models: [] },
              { kind: "lmstudio", baseUrl: "http://127.0.0.1:1234", reachable: false },
            ],
          },
        },
      ],
    });
    expect(localModelServers(parsed?.checks[0])).toEqual([
      {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        reachable: true,
        models: ["qwen3-coder"],
      },
      { kind: "lmstudio", baseUrl: "http://127.0.0.1:1234", reachable: false, models: [] },
    ]);
    expect(localModelServers(undefined)).toEqual([]);
  });
});

describe("checksForSurface", () => {
  const checks = [
    check("daemon", "ok"),
    {
      ...check("graph", "warn", "Run `git init && git add -A` here"),
      detail: "is not a git repository. Swarm workers need one for their worktrees.",
    },
    check("git", "warn"),
    check("opencode", "warn"),
    {
      ...check(
        "disk",
        "warn",
        "Old agent worktrees are a common culprit: `kora worktree remove <id>`.",
      ),
      detail: "3 GB free. Each Swarm worker gets its own worktree.",
    },
  ];
  it("hides the code-only rows and the worktree wording on Kora (blob) projects", () => {
    for (const surface of ["blobs"] as const) {
      const out = checksForSurface(report(checks), surface);
      expect(out.checks.map((c) => c.id)).toEqual(["daemon", "disk"]);
      const text = JSON.stringify(out.checks);
      expect(text).not.toMatch(/git|worktree|Swarm/i);
      expect(out.checks[1]!.fix).toBe(`Free some space on ${thisComputer()}.`);
    }
  });
  it("leaves a Code project's report exactly as it was", () => {
    const r = report(checks);
    expect(checksForSurface(r, "code")).toBe(r);
  });
});
