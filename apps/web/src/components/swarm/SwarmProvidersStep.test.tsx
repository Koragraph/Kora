import { HostId } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SWARM_STATUS_NEEDS_CONSENT,
  SWARM_STATUS_OPENCODE_MISSING,
  SWARM_STATUS_READY,
} from "../../util/swarm.fixtures";

vi.mock("../../atoms/swarm", () => ({ swarmHost: {} }));
vi.mock("../../atoms/use-atom-command", () => ({ useAtomAction: () => vi.fn() }));
vi.mock("../../localApi", () => ({
  localApiOrThrow: () => ({ shell: { openExternal: vi.fn() } }),
}));

import { SwarmIntroStep } from "./SwarmIntroStep";
import { SwarmOpencodeStep } from "./SwarmOpencodeStep";
import { SwarmProvidersStep } from "./SwarmProvidersStep";
import { SwarmReadyStep } from "./SwarmReadyStep";

const hostId = HostId.make("local");

describe("SwarmProvidersStep", () => {
  it("renders one card per provider in preference order", () => {
    const html = renderToStaticMarkup(
      <SwarmProvidersStep hostId={hostId} status={SWARM_STATUS_READY} />,
    );
    const order = [...html.matchAll(/data-swarm-agent-card="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["zen", "openrouter", "cerebras"]);
    expect(html).not.toContain("Try OpenCode Zen earlier");
  });

  it("adds provider-order controls in Settings", () => {
    const html = renderToStaticMarkup(
      <SwarmProvidersStep hostId={hostId} status={SWARM_STATUS_READY} showOrderControls />,
    );
    expect(html).toContain("Try OpenRouter earlier");
    expect(html).toContain("Try OpenRouter later");
  });

  it("says keys live in a private file in ~/.kora", () => {
    const html = renderToStaticMarkup(
      <SwarmProvidersStep hostId={hostId} status={SWARM_STATUS_READY} />,
    );
    expect(html).toContain("stored in a private file in ~/.kora that only you can read");
    expect(html).not.toContain("sk-or-v1");
  });
});

describe("Swarm setup copy", () => {
  it("never mentions the Keychain in any rendered step", () => {
    const pages = [
      SWARM_STATUS_READY,
      SWARM_STATUS_NEEDS_CONSENT,
      SWARM_STATUS_OPENCODE_MISSING,
    ].flatMap((status) => [
      renderToStaticMarkup(<SwarmIntroStep hostId={hostId} status={status} />),
      renderToStaticMarkup(<SwarmOpencodeStep hostId={hostId} status={status} />),
      renderToStaticMarkup(
        <SwarmProvidersStep hostId={hostId} status={status} showOrderControls />,
      ),
      renderToStaticMarkup(<SwarmReadyStep status={status} onFix={vi.fn()} />),
    ]);
    for (const html of pages) expect(html.toLowerCase()).not.toContain("keychain");
  });

  it("never mentions the Keychain in any Swarm setup source", () => {
    const sources = {
      ...import.meta.glob(["./Swarm*.{ts,tsx}", "./useSwarm*.ts", "!./*.test.*"], {
        query: "?raw",
        import: "default",
        eager: true,
      }),
      ...import.meta.glob(["../settings/Swarm*.tsx", "!../settings/*.test.*"], {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    } as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(8);
    for (const [file, text] of Object.entries(sources)) {
      expect(text.toLowerCase(), file).not.toContain("keychain");
    }
  });
});
