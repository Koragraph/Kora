import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  askToConfirm,
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "./confirm";

/** With a host mounted askToConfirm always returns a promise; narrow it for the tests. */
function ask(...args: Parameters<typeof askToConfirm>): Promise<boolean> {
  const pending = askToConfirm(...args);
  if (!pending) throw new Error("expected a mounted confirm host");
  return pending;
}

const idle = { status: "idle" };
const shown = () => readConfirmDialogState();

beforeEach(() => resetConfirmDialogForTests());

describe("no dialog host mounted", () => {
  it("declines to ask (returns undefined) and stays idle", () => {
    expect(askToConfirm("Proceed?", { variant: "destructive" })).toBeUndefined();
    expect(shown()).toEqual(idle);
  });

  it("starts asking again once a host registers", () => {
    expect(askToConfirm("one")).toBeUndefined();
    const release = registerConfirmDialogHost();
    expect(askToConfirm("two")).toBeInstanceOf(Promise);
    release();
  });
});

describe("showing a question", () => {
  it("carries the message, label, description and variant", () => {
    const release = registerConfirmDialogHost();
    void ask("Archive Mochi?", {
      confirmLabel: "Archive",
      description: "You can restore it later.",
      variant: "destructive",
    });

    expect(shown()).toEqual({
      status: "confirming",
      message: "Archive Mochi?",
      confirmLabel: "Archive",
      description: "You can restore it later.",
      variant: "destructive",
    });
    release();
  });

  it("defaults the variant and omits label and description when empty or absent", () => {
    const release = registerConfirmDialogHost();
    void ask("Plain?", { confirmLabel: "", description: "" });

    expect(shown()).toEqual({ status: "confirming", message: "Plain?", variant: "default" });
    release();
  });
});

describe("answering", () => {
  it.each([true, false])(
    "resolves %s right away while the dialog lingers as closing",
    async (answer) => {
      const release = registerConfirmDialogHost();
      const result = ask("Remove the branch?", { variant: "destructive" });

      respondToConfirmDialog(answer);

      await expect(result).resolves.toBe(answer);
      expect(shown()).toEqual({
        status: "closing",
        message: "Remove the branch?",
        variant: "destructive",
      });
      completeConfirmDialogClose();
      expect(shown()).toEqual(idle);
      release();
    },
  );

  it("only honours the first answer", async () => {
    const release = registerConfirmDialogHost();
    const result = ask("Go on?");

    respondToConfirmDialog(false);
    respondToConfirmDialog(true);
    completeConfirmDialogClose();

    await expect(result).resolves.toBe(false);
    expect(shown()).toEqual(idle);
    release();
  });

  it("ignores a response or a close when nothing is open", () => {
    const release = registerConfirmDialogHost();
    respondToConfirmDialog(true);
    completeConfirmDialogClose();
    expect(shown()).toEqual(idle);
    release();
  });
});

describe("queueing", () => {
  it("shows queued questions one by one, each after the previous one has closed", async () => {
    const release = registerConfirmDialogHost();
    const first = ask("First?");
    const second = ask("Second?");
    const third = ask("Third?");

    respondToConfirmDialog(true);
    await expect(first).resolves.toBe(true);
    // Still the first, animating out: the next one must not appear yet.
    expect(shown()).toMatchObject({ status: "closing", message: "First?" });

    completeConfirmDialogClose();
    expect(shown()).toMatchObject({ status: "confirming", message: "Second?" });
    respondToConfirmDialog(false);
    await expect(second).resolves.toBe(false);

    completeConfirmDialogClose();
    expect(shown()).toMatchObject({ status: "confirming", message: "Third?" });
    respondToConfirmDialog(true);
    await expect(third).resolves.toBe(true);

    completeConfirmDialogClose();
    expect(shown()).toEqual(idle);
    release();
  });

  it("queues a question asked while the previous dialog is still closing", async () => {
    const release = registerConfirmDialogHost();
    const first = ask("Early?");
    respondToConfirmDialog(true);
    await first;

    const late = ask("Late?");
    expect(shown()).toMatchObject({ status: "closing", message: "Early?" });

    completeConfirmDialogClose();
    expect(shown()).toMatchObject({ status: "confirming", message: "Late?" });
    respondToConfirmDialog(true);
    await expect(late).resolves.toBe(true);
    release();
  });
});

describe("host lifetime", () => {
  it("answers both the open and the queued question 'no' when the last host goes away", async () => {
    const release = registerConfirmDialogHost();
    const open = ask("Open one?");
    const queued = ask("Queued one?");

    release();

    await expect(Promise.all([open, queued])).resolves.toEqual([false, false]);
    expect(shown()).toEqual(idle);
  });

  it("keeps the dialog alive while another host remains", async () => {
    const releaseA = registerConfirmDialogHost();
    const releaseB = registerConfirmDialogHost();
    const result = ask("Still here?");

    releaseA();
    expect(shown()).toMatchObject({ status: "confirming", message: "Still here?" });

    releaseB();
    await expect(result).resolves.toBe(false);
  });

  it("treats a second release of the same host as a no-op", () => {
    const releaseA = registerConfirmDialogHost();
    const releaseB = registerConfirmDialogHost();

    releaseA();
    releaseA();

    expect(askToConfirm("Host B is still mounted")).toBeInstanceOf(Promise);
    releaseB();
  });
});

describe("subscriptions", () => {
  it("notifies on each state change until unsubscribed", () => {
    const release = registerConfirmDialogHost();
    const listener = vi.fn();
    const unsubscribe = subscribeConfirmDialog(listener);

    void ask("Ping?");
    expect(listener).toHaveBeenCalledTimes(1);
    respondToConfirmDialog(true);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    completeConfirmDialogClose();
    expect(listener).toHaveBeenCalledTimes(2);
    release();
  });
});
