import type { ProjectAction } from "@kora/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The dialog primitives are replaced with plain elements so the form logic can be driven directly.
const gate = (open: boolean, children: ReactNode) => (open ? children : null);
vi.mock("./ui/dialog", () => ({
  Dialog: (p: { open: boolean; children: ReactNode }) => gate(p.open, p.children),
  DialogTitle: "h2",
  DialogPopup: "section",
  DialogPanel: "section",
  DialogHeader: "header",
  DialogFooter: "footer",
  DialogDescription: "p",
}));
vi.mock("./ui/alert-dialog", () => ({
  AlertDialog: (p: { open: boolean; children: ReactNode }) => gate(p.open, p.children),
  AlertDialogTitle: "h2",
  AlertDialogPopup: "section",
  AlertDialogHeader: "header",
  AlertDialogFooter: "footer",
  AlertDialogDescription: "p",
  AlertDialogClose: "button",
}));
vi.mock("./ui/popover", () => ({
  Popover: (p: { children: ReactNode }) => p.children,
  PopoverTrigger: "button",
  PopoverPopup: () => null,
}));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/input", () => ({ Input: "input" }));
vi.mock("./ui/label", () => ({ Label: "label" }));
vi.mock("./ui/switch", () => ({ Switch: "input" }));
vi.mock("./ui/textarea", () => ({ Textarea: "textarea" }));

import {
  EMPTY_PROJECT_COMMAND_INPUT,
  ProjectCommandEditorDialog,
  editorRequestForScript,
  type NewProjectCommandInput,
  type ProjectCommandActionResult,
  type ProjectCommandEditorRequest,
} from "./projectCommandEditor";

const onSubmit = vi.fn<Parameters<typeof ProjectCommandEditorDialog>[0]["onSubmit"]>();
const onClose = vi.fn();
const onDelete = vi.fn();
let renderer: ReactTestRenderer | null = null;

const requestWith = (
  scriptId: string | null,
  initial: Partial<NewProjectCommandInput> = {},
  error?: string,
): ProjectCommandEditorRequest => ({
  scriptId,
  initial: { ...EMPTY_PROJECT_COMMAND_INPUT, name: scriptId ?? "", command: "make", ...initial },
  ...(error === undefined ? {} : { error }),
});

const element = (request: ProjectCommandEditorRequest | null) => (
  <StrictMode>
    <ProjectCommandEditorDialog
      request={request}
      onSubmit={onSubmit}
      onClose={onClose}
      onDelete={onDelete}
    />
  </StrictMode>
);

function open(request: ProjectCommandEditorRequest | null) {
  act(() => {
    if (renderer) renderer.update(element(request));
    else renderer = create(element(request));
  });
}

const tree = () => renderer!.root;
const buttons = () => tree().findAllByType("button");
const buttonLabelled = (label: string) => buttons().find((b) => b.children.includes(label));
const submitButton = () => buttons().find((b) => b.props.type === "submit")!;
const fieldset = () => tree().findByType("fieldset");
const shownTexts = () =>
  tree()
    .findAllByType("p")
    .flatMap((p) => p.children);
const titleText = () => tree().findByType("h2").children.join("");
const field = (id: string) => tree().findByProps({ id });
const switches = (): ReactTestInstance[] =>
  tree()
    .findAllByType("input")
    .filter((el) => "onCheckedChange" in el.props);

const typeInto = (id: string, value: string) =>
  act(() => field(id).props.onChange({ target: { value } }));
const flip = (index: number, checked: boolean) =>
  act(() => switches()[index]!.props.onCheckedChange(checked));

/** Fires the form's submit handler inside act; resolves when the handler's promise does. */
function submit(): Promise<void> {
  let finished!: Promise<void>;
  act(() => {
    finished = tree()
      .findByType("form")
      .props.onSubmit({ preventDefault() {} });
  });
  return finished;
}
const settle = (work: Promise<void>, before: () => void = () => {}) =>
  act(async () => {
    before();
    await work;
  });

/** A save whose outcome is decided later by the test. */
function manualSave() {
  const handle = {} as {
    ok: () => void;
    failWith: (error: Error) => void;
    interrupt: () => void;
    throwWith: (error: unknown) => void;
  };
  const result = new Promise<ProjectCommandActionResult>((resolve, reject) => {
    handle.ok = () => resolve(AsyncResult.success(undefined));
    handle.failWith = (error) => resolve(AsyncResult.failure(Cause.fail(error)));
    handle.interrupt = () => resolve(AsyncResult.failure(Cause.interrupt()));
    handle.throwWith = reject;
  });
  return { result, ...handle };
}

beforeEach(() => {
  renderer = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [onSubmit, onClose, onDelete]) mock.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("editorRequestForScript", () => {
  const base: ProjectAction = {
    id: "act-1",
    name: "Serve",
    command: "pnpm dev",
    icon: "build",
    runOnWorktreeCreate: false,
  };

  it.each<[string, Partial<ProjectAction>, Partial<NewProjectCommandInput>]>([
    ["a plain action", {}, { waitForSetup: false, autoOpenPreview: false, previewUrl: null }],
    [
      "a setup script that blocks the agent (async: false)",
      { runOnWorktreeCreate: true, async: false },
      { runOnWorktreeCreate: true, waitForSetup: true },
    ],
    [
      "a setup script that runs in the background",
      { runOnWorktreeCreate: true, async: true },
      { runOnWorktreeCreate: true, waitForSetup: false },
    ],
    [
      "a setup script with async left unset",
      { runOnWorktreeCreate: true },
      { runOnWorktreeCreate: true, waitForSetup: false },
    ],
    [
      "a non-setup action ignores async: false",
      { async: false },
      { runOnWorktreeCreate: false, waitForSetup: false },
    ],
    [
      "a preview action",
      { previewUrl: "http://localhost:3000", autoOpenPreview: true },
      { previewUrl: "http://localhost:3000", autoOpenPreview: true },
    ],
  ])("maps %s", (_label, overrides, expected) => {
    const request = editorRequestForScript({ ...base, ...overrides });
    expect(request.scriptId).toBe("act-1");
    expect(request.initial).toMatchObject({
      name: "Serve",
      command: "pnpm dev",
      icon: "build",
      ...expected,
    });
    expect(request.error).toBeUndefined();
  });
});

describe("ProjectCommandEditorDialog chrome", () => {
  it("renders nothing while there is no request", () => {
    open(null);
    expect(renderer!.toJSON()).toBeNull();
  });

  it("is an 'Add' form with no Delete button for a new action", () => {
    open(requestWith(null));
    expect(titleText()).toBe("Add Action");
    expect(buttonLabelled("Delete")).toBeUndefined();
    expect(submitButton().children).toContain("Save action");
  });

  it("is an 'Edit' form with a Delete button for an existing action", () => {
    open(requestWith("lint"));
    expect(titleText()).toBe("Edit Action");
    expect(buttonLabelled("Delete")).toBeDefined();
    expect(submitButton().children).toContain("Save changes");
  });

  it("fills the fields from the request and shows its error", () => {
    open(requestWith("lint", { command: "pnpm lint", previewUrl: "http://x.test" }, "Seen before"));
    expect(field("script-name").props.value).toBe("lint");
    expect(field("script-command").props.value).toBe("pnpm lint");
    expect(field("script-preview-url").props.value).toBe("http://x.test");
    expect(shownTexts()).toContain("Seen before");
  });

  it("only enables the dependent switches when their prerequisite is set", () => {
    open(requestWith("lint"));
    expect(switches().map((s) => s.props.disabled === true)).toEqual([false, true, true]);

    flip(0, true);
    typeInto("script-preview-url", "http://x.test");
    expect(switches().map((s) => s.props.disabled === true)).toEqual([false, false, false]);

    typeInto("script-preview-url", "   ");
    expect(switches()[2]!.props.disabled).toBe(true);
  });
});

describe("ProjectCommandEditorDialog validation", () => {
  it.each([
    ["name", { name: "   " }, "Name is required."],
    ["command", { command: "\n " }, "Command is required."],
  ])("refuses a blank %s without saving", async (_which, initial, message) => {
    open(requestWith("lint", initial));
    await settle(submit());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(shownTexts()).toContain(message);
    expect(submitButton().props.disabled).toBe(false);
  });

  it("checks the name before the command", async () => {
    open(requestWith("lint", { name: "", command: "" }));
    await settle(submit());
    expect(shownTexts()).toContain("Name is required.");
  });
});

describe("ProjectCommandEditorDialog payload", () => {
  it("trims text, drops a blank preview URL and the flags that depend on it", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    open(
      requestWith("lint", {
        name: "  Lint  ",
        command: "  pnpm lint \n",
        icon: "lint",
        runOnWorktreeCreate: false,
        waitForSetup: true,
        previewUrl: "   ",
        autoOpenPreview: true,
      }),
    );
    await settle(submit());

    expect(onSubmit).toHaveBeenCalledWith("lint", {
      name: "Lint",
      command: "pnpm lint",
      icon: "lint",
      runOnWorktreeCreate: false,
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
    });
  });

  it("keeps the dependent flags when their prerequisites are present", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    open(
      requestWith(null, {
        name: "Setup",
        runOnWorktreeCreate: true,
        waitForSetup: true,
        previewUrl: " http://localhost:9 ",
        autoOpenPreview: true,
      }),
    );
    await settle(submit());

    expect(onSubmit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        runOnWorktreeCreate: true,
        waitForSetup: true,
        previewUrl: "http://localhost:9",
        autoOpenPreview: true,
      }),
    );
  });

  it("sends edits made in the form, not the original request", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    open(requestWith("lint"));
    typeInto("script-name", "Format");
    typeInto("script-command", "pnpm fmt");

    await settle(submit());

    expect(onSubmit).toHaveBeenCalledWith(
      "lint",
      expect.objectContaining({ name: "Format", command: "pnpm fmt" }),
    );
  });

  it("closes after a successful save", async () => {
    onSubmit.mockResolvedValue(AsyncResult.success(undefined));
    open(requestWith("lint"));
    await settle(submit());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectCommandEditorDialog while saving", () => {
  it("locks the form and ignores a second submit, but leaves Cancel working", async () => {
    const save = manualSave();
    onSubmit.mockReturnValue(save.result);
    open(requestWith("lint"));

    let first!: Promise<void>;
    act(() => {
      first = tree()
        .findByType("form")
        .props.onSubmit({ preventDefault() {} });
      void tree()
        .findByType("form")
        .props.onSubmit({ preventDefault() {} });
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(fieldset().props.disabled).toBe(true);
    expect(submitButton().props.disabled).toBe(true);
    expect(submitButton().children).toContain("Saving…");
    expect(buttonLabelled("Cancel")!.props.disabled).not.toBe(true);

    await settle(first, save.ok);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a failure result",
      (s: ReturnType<typeof manualSave>) => s.failWith(new Error("Quota hit")),
      "Quota hit",
    ],
    [
      "a thrown Error",
      (s: ReturnType<typeof manualSave>) => s.throwWith(new Error("Socket closed")),
      "Socket closed",
    ],
    [
      "a thrown non-Error",
      (s: ReturnType<typeof manualSave>) => s.throwWith("nope"),
      "Failed to save action.",
    ],
    [
      "an Error with no message",
      (s: ReturnType<typeof manualSave>) => s.throwWith(new Error("")),
      "Failed to save action.",
    ],
  ])("shows the message for %s and unlocks the form", async (_label, trigger, message) => {
    const save = manualSave();
    onSubmit.mockReturnValue(save.result);
    open(requestWith("lint"));

    await settle(submit(), () => trigger(save));

    expect(shownTexts()).toContain(message);
    expect(fieldset().props.disabled).toBe(false);
    expect(submitButton().props.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("treats an interrupted save as silent: unlocks without an error or closing", async () => {
    const save = manualSave();
    onSubmit.mockReturnValue(save.result);
    open(requestWith("lint"));

    await settle(submit(), save.interrupt);

    expect(fieldset().props.disabled).toBe(false);
    expect(
      tree()
        .findAllByType("p")
        .map((p) => p.props.className ?? ""),
    ).not.toContainEqual(expect.stringContaining("destructive"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("can retry after a failure", async () => {
    onSubmit.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Try again"))));
    onSubmit.mockResolvedValueOnce(AsyncResult.success(undefined));
    open(requestWith("lint"));

    await settle(submit());
    expect(onClose).not.toHaveBeenCalled();
    await settle(submit());

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "unmounted"] as const)(
    "does not close a second time when the save lands after the dialog was %s",
    async (how) => {
      const save = manualSave();
      onSubmit.mockReturnValue(save.result);
      open(requestWith("lint"));
      const running = submit();

      act(() => {
        if (how === "cancelled") buttonLabelled("Cancel")!.props.onClick();
        else {
          renderer!.unmount();
          renderer = null;
        }
      });
      onClose.mockClear();

      await settle(running, save.ok);
      expect(onClose).not.toHaveBeenCalled();
    },
  );
});

describe("ProjectCommandEditorDialog when the request is swapped during a save", () => {
  it.each(["failure", "exception"] as const)(
    "drops the old request's %s instead of showing it on the new one",
    async (mode) => {
      const save = manualSave();
      onSubmit.mockReturnValue(save.result);
      open(requestWith("one"));
      const running = submit();

      open(requestWith("two", {}, "Name taken"));
      await settle(running, () => {
        const boom = new Error("Stale problem");
        if (mode === "failure") save.failWith(boom);
        else save.throwWith(boom);
      });

      expect(shownTexts()).toContain("Name taken");
      expect(shownTexts()).not.toContain("Stale problem");
      expect(submitButton().props.disabled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("lets the new request save on its own while the old save is still unresolved", async () => {
    const oldSave = manualSave();
    const newSave = manualSave();
    onSubmit.mockReturnValueOnce(oldSave.result).mockReturnValueOnce(newSave.result);
    open(requestWith("one"));
    const oldRun = submit();

    open(requestWith("two"));
    expect(field("script-name").props.value).toBe("two");
    expect(submitButton().props.disabled).toBe(false);
    const newRun = submit();

    await settle(oldRun, oldSave.ok);
    expect(onClose).not.toHaveBeenCalled();
    expect(submitButton().props.disabled).toBe(true);

    await settle(newRun, newSave.ok);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
  });
});

describe("ProjectCommandEditorDialog deleting", () => {
  it("asks for confirmation naming the action, and only then deletes and closes", () => {
    open(requestWith("lint"));
    expect(buttonLabelled("Delete action")).toBeUndefined();

    act(() => buttonLabelled("Delete")!.props.onClick());
    const headings = tree()
      .findAllByType("h2")
      .map((h) => h.children.join(""));
    expect(headings).toContain('Delete action "lint"?');
    expect(onDelete).not.toHaveBeenCalled();

    act(() => buttonLabelled("Delete action")!.props.onClick());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("lint");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
