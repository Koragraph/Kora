import { act, createElement, useLayoutEffect } from "react";
import { create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PromptHandleContext, type PromptHandleRef } from "../../promptHandleContext";
import * as Scope from "./promptEventScope";

/** An element that sits inside exactly the containers whose selectors it was given. */
class Node {
  readonly inside: ReadonlySet<string>;
  constructor(...inside: string[]) {
    this.inside = new Set(inside);
  }
  closest(selectorList: string): Node | null {
    return selectorList.split(",").some((selector) => this.inside.has(selector)) ? this : null;
  }
}
const target = (...inside: string[]) => new Node(...inside) as unknown as EventTarget;

const FLOATING = '[data-prompt-floating-layer="true"]';
const DRAWER = '[data-prompt-drawer-layer="true"]';
const COLLAPSED = '[data-prompt-collapsed-controls="true"]';
const RESTING = '[data-prompt-resting-controls="true"]';
const IMAGES = '[data-prompt-resting-images="true"]';
const CONTEXT = "[data-prompt-context-control]";

// Every test runs against the fake element class; globals are restored afterwards.
beforeEach(() => void vi.stubGlobal("Element", Node));
afterEach(() => void vi.unstubAllGlobals());

describe("composer event scopes", () => {
  it("knows the composer's own floating layers, and no one else's", () => {
    expect(Scope.isInsidePromptFloatingLayer(target(FLOATING))).toBe(true);
    expect(Scope.isInsidePromptFloatingLayer(target(DRAWER))).toBe(true);
    expect(Scope.isInsidePromptFloatingLayer(target('[data-slot="popover-popup"]'))).toBe(false);
    expect(Scope.isInsidePromptFloatingLayer(null)).toBe(false);
  });

  it("knows the controls docked above a collapsed composer", () => {
    expect(Scope.isInsideCollapsedPromptControls(target(COLLAPSED))).toBe(true);
    expect(Scope.isInsideCollapsedPromptControls(target())).toBe(false);
    expect(Scope.isInsideCollapsedPromptControls(null)).toBe(false);
  });

  it.each([
    ["resting controls", RESTING, true],
    ["resting images", IMAGES, true],
    ["the context strip", CONTEXT, true],
    ["a composer floating layer", FLOATING, true],
    ["some other popover", '[data-slot="popover-popup"]', false],
    ["the editor itself", "[data-editor]", false],
  ])("counts %s as resting scope: %s", (_where, selector, expected) => {
    expect(Scope.isInsideRestingPromptControlScope(target(selector))).toBe(expected);
  });

  it("ignores targets that are not elements", () => {
    expect(Scope.isInsideRestingPromptControlScope(null)).toBe(false);
    expect(Scope.isInsideRestingPromptControlScope({} as EventTarget)).toBe(false);
  });

  it("marks menus as composer-owned floating layers", () => {
    expect(Scope.promptFloatingLayerProps).toEqual({ "data-prompt-floating-layer": "true" });
  });
});

describe("usePromptMenuProps focus return", () => {
  /** Renders the hook inside a composer and returns its props plus the fake document. */
  async function mount(focused: "body" | "menu" | "input", withComposer = true) {
    const body = new Node();
    const editor = new Node("[data-editor]");
    const elements = { body, menu: new Node(FLOATING), input: new Node("input") };
    const page = { body, activeElement: elements[focused] as Node };
    vi.stubGlobal("document", page);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const handle = {
      current: { focusAtEnd: () => void (page.activeElement = editor) },
    } as unknown as PromptHandleRef;

    let props: ReturnType<typeof Scope.usePromptMenuProps> | undefined;
    const Probe = () => {
      const latest = Scope.usePromptMenuProps();
      useLayoutEffect(() => void (props = latest));
      return null;
    };
    const tree = await act(() =>
      create(
        createElement(
          PromptHandleContext,
          { value: withComposer ? handle : null },
          createElement(Probe),
        ),
      ),
    );
    return {
      page,
      editor,
      before: elements[focused],
      props: props!,
      unmount: () => act(() => tree.unmount()),
    };
  }

  it.each([
    ["the page body", "body", true],
    ["the closing menu", "menu", true],
    ["another field", "input", false],
  ] as const)("when focus is on %s, refocuses the editor: %s", async (_where, focused, refocus) => {
    const view = await mount(focused);
    try {
      expect(view.props.finalFocus?.()).toBe(false);
      expect(view.page.activeElement).toBe(refocus ? view.editor : view.before);
    } finally {
      await view.unmount();
    }
  });

  it("leaves focus to the menu outside a composer", async () => {
    const view = await mount("body", false);
    try {
      expect(view.props.finalFocus).toBeUndefined();
      expect(view.props["data-prompt-floating-layer"]).toBe("true");
    } finally {
      await view.unmount();
    }
  });
});
