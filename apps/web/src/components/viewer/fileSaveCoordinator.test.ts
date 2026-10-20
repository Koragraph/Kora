import type { AtomActionResult } from "@kora/client-runtime/store/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FileSaveCoordinator } from "./fileSaveCoordinator";

interface DeferredSignal<T> {
  readonly future: Promise<T>;
  fulfill(value: T): void;
}

function makeDeferredSignal<T>(): DeferredSignal<T> {
  let fulfill!: (value: T) => void;
  const future = new Promise<T>((res) => {
    fulfill = res;
  });
  return { fulfill, future };
}

describe("FileSaveCoordinator autosave pipeline", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setupCoordinator(debounceMs = 400) {
    vi.useFakeTimers();
    const persistMock = vi.fn<(text: string) => Promise<AtomActionResult<void, Error>>>();
    const pendingSpy = vi.fn();
    const confirmedSpy = vi.fn();

    const coordinator = new FileSaveCoordinator({
      debounceMs,
      onConfirmed: confirmedSpy,
      onPendingChange: pendingSpy,
      persist: persistMock,
    });

    return { coordinator, confirmedSpy, pendingSpy, persistMock };
  }

  it("coalesces rapid text revisions and saves only the latest version after debounce", async () => {
    const { coordinator, confirmedSpy, pendingSpy, persistMock } = setupCoordinator(350);
    persistMock.mockResolvedValue(AsyncResult.success(undefined));

    coordinator.change("draft-1");
    await vi.advanceTimersByTimeAsync(150);
    coordinator.change("draft-2");
    await vi.advanceTimersByTimeAsync(349);

    expect(persistMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith("draft-2");
    expect(confirmedSpy).toHaveBeenCalledWith("draft-2");
    expect(pendingSpy).toHaveBeenNthCalledWith(1, true);
    expect(pendingSpy).toHaveBeenLastCalledWith(false);
  });

  it("immediately saves uncommitted edits upon disposal", async () => {
    const { coordinator, confirmedSpy, persistMock } = setupCoordinator(500);
    persistMock.mockResolvedValue(AsyncResult.success(undefined));

    coordinator.change("in-flight draft");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith("in-flight draft");
    expect(confirmedSpy).toHaveBeenCalledWith("in-flight draft");
  });

  it("avoids redundant writes if latest content was already confirmed before dispose", async () => {
    const { coordinator, persistMock } = setupCoordinator(200);
    persistMock.mockResolvedValue(AsyncResult.success(undefined));

    coordinator.change("initial content");
    await vi.advanceTimersByTimeAsync(200);
    expect(persistMock).toHaveBeenCalledTimes(1);

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("ignores modifications dispatched after the coordinator has been closed", async () => {
    const { coordinator, pendingSpy, persistMock } = setupCoordinator(250);
    persistMock.mockResolvedValue(AsyncResult.success(undefined));

    coordinator.dispose();
    coordinator.change("late modification");
    await vi.runAllTimersAsync();

    expect(persistMock).not.toHaveBeenCalled();
    expect(pendingSpy).not.toHaveBeenCalled();
  });

  it("keeps pending flag active and skips confirmation when persist rejects", async () => {
    const { coordinator, confirmedSpy, pendingSpy, persistMock } = setupCoordinator(300);
    const writeFailure = AsyncResult.failure<void, Error>(Cause.fail(new Error("Disk full")));
    persistMock.mockResolvedValue(writeFailure);

    coordinator.change("failed payload");
    await vi.advanceTimersByTimeAsync(300);

    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(confirmedSpy).not.toHaveBeenCalled();
    expect(pendingSpy).toHaveBeenCalledWith(true);
    expect(pendingSpy).not.toHaveBeenCalledWith(false);
  });

  it("retries unconfirmed write when disposed following a failed save attempt", async () => {
    const { coordinator, persistMock } = setupCoordinator(200);
    const failureResult = AsyncResult.failure<void, Error>(
      Cause.fail(new Error("Network timeout")),
    );
    const successResult = AsyncResult.success(undefined);

    persistMock.mockResolvedValueOnce(failureResult).mockResolvedValue(successResult);

    coordinator.change("important note");
    await vi.advanceTimersByTimeAsync(200);
    expect(persistMock).toHaveBeenCalledTimes(1);

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persistMock).toHaveBeenCalledTimes(2);
    expect(persistMock).toHaveBeenLastCalledWith("important note");
  });

  it("sequences subsequent edits when an edit happens while writing", async () => {
    const { coordinator, pendingSpy, persistMock } = setupCoordinator(250);
    const firstSaveDeferred = makeDeferredSignal<AtomActionResult<void, Error>>();

    persistMock
      .mockReturnValueOnce(firstSaveDeferred.future)
      .mockResolvedValue(AsyncResult.success(undefined));

    coordinator.change("first edit");
    await vi.advanceTimersByTimeAsync(250);
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith("first edit");

    coordinator.change("second edit");
    await vi.advanceTimersByTimeAsync(250);
    // Cannot start second save until first finishes
    expect(persistMock).toHaveBeenCalledTimes(1);

    firstSaveDeferred.fulfill(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persistMock).toHaveBeenCalledTimes(2);
    expect(persistMock).toHaveBeenLastCalledWith("second edit");
    expect(pendingSpy).toHaveBeenLastCalledWith(false);
  });

  it("does not repeat persist call if the in-flight save lands while closing with no further changes", async () => {
    const { coordinator, persistMock } = setupCoordinator(300);
    const inProgress = makeDeferredSignal<AtomActionResult<void, Error>>();

    persistMock.mockReturnValueOnce(inProgress.future);

    coordinator.change("steady state");
    await vi.advanceTimersByTimeAsync(300);
    expect(persistMock).toHaveBeenCalledTimes(1);

    coordinator.dispose();
    inProgress.fulfill(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("flushes edits made during an in-flight save when closing", async () => {
    const { coordinator, persistMock } = setupCoordinator(300);
    const firstCall = makeDeferredSignal<AtomActionResult<void, Error>>();

    persistMock
      .mockReturnValueOnce(firstCall.future)
      .mockResolvedValue(AsyncResult.success(undefined));

    coordinator.change("part 1");
    await vi.advanceTimersByTimeAsync(300);
    expect(persistMock).toHaveBeenCalledTimes(1);

    coordinator.change("part 2");
    coordinator.dispose();

    firstCall.fulfill(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persistMock).toHaveBeenCalledTimes(2);
    expect(persistMock).toHaveBeenLastCalledWith("part 2");
  });
});
