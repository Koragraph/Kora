import { hookStub as hooks } from "../../test/hookStub";
import { findElement } from "../../test/findElement";

import { SWARM_STATUS_READY } from "../../util/swarm.fixtures";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isValidElement } from "react";
import type {
  SwarmTestOutcome,
  SwarmProviderTestResult,
  SwarmProviderStatus,
} from "@kora/contracts";

const local = vi.hoisted(() => ({ openExternal: vi.fn(() => Promise.resolve()) }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { hookStub } = await import("../../test/hookStub");
  return {
    ...actual,
    useId: () => "key-input",
    useRef: hookStub.useRef,
    useState: hookStub.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { hookStub } = await import("../../test/hookStub");
  return { c: hookStub.useMemoCache };
});

vi.mock("../../localApi", () => ({
  localApiOrThrow: () => ({ shell: { openExternal: local.openExternal } }),
}));

import { SwarmProviderKeyCard } from "./SwarmProviderKeyCard";

const provider = (id: SwarmProviderStatus["provider"]) =>
  SWARM_STATUS_READY.providers.find((entry) => entry.provider === id)!;

const SECRET = "sk-or-v1-THIS-IS-THE-SECRET-KEY-0000";

/** Every string in the element tree (own JSX; child components are not rendered). */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return Object.entries(node.props)
    .filter(([key]) => key !== "className")
    .map(([, value]) => textOf(value))
    .join(" ");
}

function render(props: Partial<Parameters<typeof SwarmProviderKeyCard>[0]> = {}) {
  hooks.startRender();
  const handlers = {
    onEnabledChange: vi.fn(),
    onTest: vi.fn(),
    onClearKey: vi.fn(),
    onSaveKey: vi.fn(),
  };
  const view = SwarmProviderKeyCard({ provider: provider("openrouter"), ...handlers, ...props });
  return { view, ...(props as object), handlers: { ...handlers, ...props } };
}

function keyInput(view: unknown) {
  const input = findElement(view, (element) => element.props.id === "key-input");
  if (!input) throw new Error("Missing key input");
  return input;
}

function withTest(outcome: SwarmTestOutcome, patch: Partial<SwarmProviderTestResult> = {}) {
  const base = provider("openrouter");
  return {
    ...base,
    lastTest: { ...base.lastTest!, ok: outcome === "ok", outcome, ...patch },
  };
}

describe("SwarmProviderKeyCard", () => {
  beforeEach(() => {
    hooks.clear();
    vi.clearAllMocks();
  });

  it("wires Test connection, Remove key, Enabled and Get a key", () => {
    const { view, handlers } = render();
    const click = (label: string) => {
      const button = findElement(
        view,
        (element) =>
          typeof element.props.onClick === "function" &&
          textOf(element.props.children).includes(label),
      );
      if (!button) throw new Error(`Missing ${label}`);
      (button.props.onClick as () => void)();
    };
    click("Test connection");
    click("Remove key");
    click("Get a key");
    const toggle = findElement(
      view,
      (element) => element.props["aria-label"] === "Use OpenRouter",
    )!;
    (toggle.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(handlers.onTest).toHaveBeenCalledOnce();
    expect(handlers.onClearKey).toHaveBeenCalledOnce();
    expect(handlers.onEnabledChange).toHaveBeenCalledWith(false);
    expect(local.openExternal).toHaveBeenCalledWith("https://openrouter.ai/settings/keys");
  });

  it("opens the key field for Zen when the probe says a key is needed", () => {
    const zen = provider("zen");
    const { view } = render({
      provider: { ...zen, lastTest: { ...zen.lastTest!, ok: false, outcome: "invalid-key" } },
    });
    expect(keyInput(view).props.type).toBe("password");
  });

  it("keeps Zen's key optional and never claims no key is needed", () => {
    const { view } = render({ provider: provider("zen") });
    const text = textOf(view);
    expect(text).toContain("Add Zen key");
    expect(text.toLowerCase()).not.toContain("no key needed");
    expect(findElement(view, (element) => element.props.id === "key-input")).toBeNull();
  });

  it("labels Cerebras a trial and shows it off by default", () => {
    const { view } = render({ provider: provider("cerebras") });
    const text = textOf(view);
    expect(text).toContain("Cerebras (trial)");
    expect(text).toContain("$5 credit for 30 days");
    expect(text).toContain("Off");
  });

  it("explains the $10 OpenRouter credit", () => {
    expect(textOf(render().view)).toContain("raises this to 1000/day");
  });

  it("shows today's remaining free requests against the daily limit", () => {
    expect(textOf(render().view)).toContain("41 / 50 free requests left today");
  });

  it.each([
    ["opencode-missing", "Install OpenCode first"],
    ["no-free-models", "offers no free models right now"],
    ["unreachable", "Couldn't reach OpenRouter"],
    ["rate-limited", "Out of free requests until"],
    ["invalid-key", "OpenRouter rejected the key"],
    ["ok", "1 free model · 512 ms"],
  ] as const)("shows the %s test outcome", (outcome, copy) => {
    const { view } = render({ provider: withTest(outcome) });
    expect(textOf(view)).toContain(copy);
    expect(
      findElement(view, (element) => element.props["data-swarm-test-outcome"] === outcome),
    ).not.toBeNull();
  });

  it("drops a pasted key from the UI once it is saved", () => {
    const onSaveKey = vi.fn();
    let { view } = render({ onSaveKey });
    (keyInput(view).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: `  ${SECRET}  ` },
    });
    ({ view } = render({ onSaveKey }));
    expect(keyInput(view).props.value).toBe(`  ${SECRET}  `);
    const form = findElement(view, (element) => element.type === "form")!;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({
      preventDefault: vi.fn(),
    });
    expect(onSaveKey).toHaveBeenCalledWith(SECRET);
    ({ view } = render({ onSaveKey }));
    expect(keyInput(view).props.value).toBe("");
    expect(textOf(view)).not.toContain(SECRET);
  });

  it("shows only the key hint, never a key", () => {
    const { view } = render();
    const text = textOf(view);
    expect(text).toContain("Saved key sk-or-…a1b2");
    expect(keyInput(view).props.type).toBe("password");
    expect(keyInput(view).props.value).toBe("");
  });
});
