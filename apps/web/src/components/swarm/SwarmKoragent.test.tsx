import type { SwarmStatus } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  KORAGENT_INSTALL_COMMAND,
  koragentReadiness,
  resolveSwarmToggleAvailability,
  swarmWorkerBackend,
  swarmWorkerBackendLabel,
} from "../../util/swarm";
import { SWARM_STATUS_READY } from "../../util/swarm.fixtures";
import { AgentIcon } from "../fleet/AgentIcon";
import { AGENTS_BY_ID } from "../fleet/agents";
import { SwarmReadinessChecklist } from "./SwarmReadinessChecklist";

const koragent = (wb: Partial<NonNullable<SwarmStatus["workerBackend"]>>): SwarmStatus => ({
  ...SWARM_STATUS_READY,
  workerBackend: {
    id: "koragent",
    installed: true,
    path: "/Users/me/.koragent/bin/koragent",
    source: "koragent-home",
    version: "1.18.32",
    minVersion: "1.18.32",
    versionOk: true,
    pinned: "a".repeat(64),
    pinOk: true,
    ...wb,
  },
});

function row(status: SwarmStatus, id: string): { state: string; html: string } {
  const html = renderToStaticMarkup(<SwarmReadinessChecklist status={status} onFix={vi.fn()} />);
  const m = new RegExp(`data-swarm-readiness-row="${id}" data-state="([^"]+)"`).exec(html);
  return { state: m?.[1] ?? "absent", html };
}

describe("Koragent worker backend", () => {
  it("reads the backend from the status (absent = OpenCode)", () => {
    expect(swarmWorkerBackend(SWARM_STATUS_READY)).toBe("opencode");
    expect(swarmWorkerBackendLabel(null)).toBe("OpenCode");
    expect(swarmWorkerBackend(koragent({}))).toBe("koragent");
    expect(swarmWorkerBackendLabel(koragent({}))).toBe("Koragent");
  });

  it("readiness: installed + version + pin; each failure says what to do", () => {
    expect(koragentReadiness(koragent({})).ok).toBe(true);
    expect(koragentReadiness(koragent({ version: "local" })).label).toBe("development build");
    expect(koragentReadiness(koragent({ installed: false, path: null })).ok).toBe(false);
    expect(koragentReadiness(koragent({ versionOk: false, version: "1.2.0" })).label).toBe(
      "1.2.0 is too old",
    );
    expect(koragentReadiness(koragent({ pinOk: false })).label).toBe("Changed since install");
    expect(KORAGENT_INSTALL_COMMAND).toContain("kora swarm install --backend koragent");
  });

  it("the checklist shows a Koragent row instead of OpenCode on the koragent backend", () => {
    expect(row(koragent({}), "koragent").state).toBe("ok");
    expect(row(koragent({}), "opencode").state).toBe("absent");
    expect(row(koragent({ installed: false, path: null }), "koragent").state).toBe("problem");
    expect(row(SWARM_STATUS_READY, "opencode").state).toBe("ok");
  });

  it("toggle copy is plain and never names the wrong worker program", () => {
    const ready = resolveSwarmToggleAvailability({
      capability: true,
      selectedProvider: "claude",
      status: koragent({}),
    });
    expect(ready.tooltip).toContain("free AI models");
    expect(ready.tooltip).not.toContain("OpenCode");
  });

  it("has an agent mark and a Stone (neutral) colour", () => {
    expect(AGENTS_BY_ID.koragent?.label).toBe("Koragent");
    const hex = AGENTS_BY_ID.koragent!.color.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(12);
    const svg = renderToStaticMarkup(<AgentIcon id="koragent" size={16} />);
    expect(svg).toContain("<svg");
    expect(svg).toContain("currentColor");
  });
});
