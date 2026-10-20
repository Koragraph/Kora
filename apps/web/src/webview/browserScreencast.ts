import { Atom } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import {
  type ShellWebScreencastArtifact,
  type HostThreadRef,
  SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER,
} from "@kora/contracts";
import { hostThreadKey } from "@kora/client-runtime/host";
import { useAtomValue } from "@effect/atom-react";

import { koraAtomRegistry } from "~/wire/atomRegistry";
import { ensureClientPrefsHydrated, getClientPrefs } from "~/hooks/usePrefs";
import { webBridge } from "~/components/web/webBridge";
import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

export const BROWSER_SCREENCAST_STARTUP_SETTLE_TIMEOUT_MS = 5_000;
export const BROWSER_SCREENCAST_PAINT_SETTLE_TIMEOUT_MS = 250;
const CAPTURE_TIMEOUT_MS = 5_000;
const TIMESLICE_MS = 1_000;
const MIN_BITRATE = 2_500_000;
const MAX_BITRATE = 50_000_000;
const BITS_PER_PIXEL = 0.05;
const withCodec = (container: string, codec: string) => `${container};codecs=${codec}`;
// Best first: H.264 in MP4 (most compatible), then VP9/VP8 in WebM, then whatever WebM offers.
const MIME_PREFERENCE: readonly string[] = [
  ...["avc1", "avc1.640028", "avc1.42e01e"].map((codec) => withCodec("video/mp4", codec)),
  ...["vp9", "vp8"].map((codec) => withCodec("video/webm", codec)),
  "video/webm",
];

// ---------- errors ----------

export class BrowserScreencastUnavailableError extends Schema.TaggedError<BrowserScreencastUnavailableError>()(
  "BrowserScreencastUnavailableError",
  { tabId: Schema.String },
) {
  override get message() {
    return `Browser recording is unavailable for tab ${this.tabId}.`;
  }
}

export class BrowserScreencastConflictError extends Schema.TaggedError<BrowserScreencastConflictError>()(
  "BrowserScreencastConflictError",
  { requestedTabId: Schema.String, activeTabId: Schema.String },
) {
  override get message() {
    return `Cannot record tab ${this.requestedTabId} while tab ${this.activeTabId} is already being recorded.`;
  }
}

export class BrowserScreencastStartCancelledError extends Schema.TaggedError<BrowserScreencastStartCancelledError>()(
  "BrowserScreencastStartCancelledError",
  { tabId: Schema.String },
) {
  override get message() {
    return `Browser recording start was cancelled for tab ${this.tabId}.`;
  }
}

export class BrowserScreencastFormatUnavailableError extends Schema.TaggedError<BrowserScreencastFormatUnavailableError>()(
  "BrowserScreencastFormatUnavailableError",
  { tabId: Schema.String },
) {
  override get message() {
    return `MediaRecorder did not report an output format for tab ${this.tabId}.`;
  }
}

export class BrowserScreencastCaptureTimeoutError extends Schema.TaggedError<BrowserScreencastCaptureTimeoutError>()(
  "BrowserScreencastCaptureTimeoutError",
  { tabId: Schema.String, timeoutMs: Schema.Number },
) {
  override get message() {
    return `Browser recording media capture for tab ${this.tabId} did not settle within ${this.timeoutMs}ms.`;
  }
}

const OPERATIONS = [
  "cleanup",
  "save-artifact",
  "stop-media-recorder",
  "wait-startup",
  "stop-screencast",
  "start-screencast",
  "start-media-recorder",
  "capture-media-stream",
  "initialize-media-recorder",
] as const;
type Operation = (typeof OPERATIONS)[number];

export class BrowserScreencastOperationError extends Schema.TaggedError<BrowserScreencastOperationError>()(
  "BrowserScreencastOperationError",
  { operation: Schema.Literals(OPERATIONS), tabId: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Browser recording operation ${this.operation} failed for tab ${this.tabId}.`;
  }
}

export const isBrowserScreencastStartCancelledError = (val: unknown): boolean =>
  Schema.is(BrowserScreencastStartCancelledError)(val);

const operationFailed = (operation1: Operation, tabKey: string, reason: unknown) =>
  new BrowserScreencastOperationError({ operation: operation1, tabId: tabKey, cause: reason });

// ---------- state ----------

export interface ActiveBrowserScreencastTarget {
  readonly runtimeTabId: string;
  readonly serverTabId: string;
}

type Phase = "starting" | "recording" | "stopping";

interface Recording {
  readonly tabId: string;
  readonly serverTabId: string;
  readonly threadKey: string | null;
  readonly startedAt: string;
  phase: Phase;
  releaseActivity: () => void;
  /** Settles (in a finally) when startup is over, however it ended. */
  startup: Promise<void>;
  cancelBeforeGrant: boolean;
  grantStarted: boolean;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  streamStopped: boolean;
  chunks: Blob[];
  stopPromise: Promise<ShellWebScreencastArtifact | null> | null;
}

const recordings = new Map<string, Recording>();
const recordingTabIdsAtom = Atom.make<{ readonly tabIds: ReadonlySet<string> }>({
  tabIds: new Set<string>(),
}).pipe(Atom.keepAlive, Atom.withLabel("preview:active-browser-recording-tabs"));

const publish = () =>
  koraAtomRegistry.set(recordingTabIdsAtom, { tabIds: new Set(recordings.keys()) });

export function useActiveBrowserScreencastTabIds(): ReadonlySet<string> {
  return useAtomValue(recordingTabIdsAtom).tabIds;
}

export function findActiveBrowserScreencastRuntimeTabId(
  threadHandle: HostThreadRef,
  serverTabId: string,
): string | null {
  const keyName = hostThreadKey(threadHandle);
  for (const recording of recordings.values()) {
    if (recording.threadKey === keyName && recording.serverTabId === serverTabId)
      return recording.tabId;
  }
  return null;
}

/** Releases the surface activity and, if this is still the registered recording, forgets it. */
function clearActiveScreencast(recording: Recording): void {
  recording.releaseActivity();
  if (recordings.get(recording.tabId) === recording) {
    recordings.delete(recording.tabId);
    publish();
  }
}

// ---------- display-media grants ----------

interface PendingCapture {
  readonly frameRate: number;
  settled: boolean;
  resolve(flow: MediaStream): void;
  reject(err: unknown): void;
}

const pendingCaptures = new Map<string, PendingCapture>();
// Only one display-media grant may be armed at a time; acquired streams may record concurrently.
let grantQueue: Promise<void> = Promise.resolve();
let grantsWaiting = 0;

const stopTracks = (flow: MediaStream) => {
  for (const track of flow.getTracks()) track.stop();
};

/** Invoked by the desktop main process (with a user gesture) once it has armed capture for a tab. */
function triggerDisplayMediaCapture(tabKey: string): boolean {
  const pending = pendingCaptures.get(tabKey);
  if (!pending) return false;
  pendingCaptures.delete(tabKey);
  navigator.mediaDevices
    .getDisplayMedia({
      audio: false,
      // No source or size constraints: main routes the grant to the armed tab at native size.
      video: { frameRate: { ideal: pending.frameRate, max: pending.frameRate } },
    })
    .then(
      (flow) => {
        if (pending.settled)
          stopTracks(flow); // arrived after cancellation or timeout
        else pending.resolve(flow);
      },
      (err: unknown) => pending.reject(err),
    );
  return true;
}

if (typeof globalThis !== "undefined") {
  Reflect.defineProperty(globalThis, SHELL_WEB_SCREENCAST_CAPTURE_TRIGGER, {
    configurable: true,
    writable: true,
    value: triggerDisplayMediaCapture,
  });
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let head = 0;
    let second = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(tmr);
      cancelAnimationFrame(head);
      cancelAnimationFrame(second);
      resolve();
    };
    const tmr = setTimeout(finish, BROWSER_SCREENCAST_PAINT_SETTLE_TIMEOUT_MS);
    head = requestAnimationFrame(() => {
      second = requestAnimationFrame(finish);
    });
  });
}

const delay = (ms: number) =>
  new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

// ---------- teardown helpers ----------

function stopStream(recording: Recording): void {
  if (!recording.stream || recording.streamStopped) return;
  recording.streamStopped = true;
  stopTracks(recording.stream);
}

/** Resolves when the recorder has really stopped (its `stop` event fired). */
function stopRecorder(recording: Recording): Promise<void> {
  const recorder = recording.recorder;
  if (!recorder || recorder.state === "inactive") return Promise.resolve();
  return new Promise<void>((resolve, fail) => {
    recorder.addEventListener("stop", () => resolve());
    try {
      recorder.stop();
    } catch (err) {
      fail(err);
    }
  });
}

/** Best-effort teardown; returns whatever went wrong so the caller can report it. */
async function cleanUp(recording: Recording, stopNative: boolean): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (stopNative) {
    try {
      await webBridge?.recording.stopScreencast(recording.tabId);
    } catch (err) {
      errors.push(err);
    }
  }
  try {
    await stopRecorder(recording);
  } catch (err) {
    errors.push(err);
  }
  stopStream(recording);
  clearActiveScreencast(recording);
  return errors;
}

// ---------- start ----------

function chooseBitrate(flow: MediaStream): number {
  const conf = flow.getVideoTracks()[0]?.getSettings?.() ?? {};
  const wd = conf.width ?? 1920;
  const ht = conf.height ?? 1080;
  const frameRate = conf.frameRate ?? 30;
  return Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, wd * ht * frameRate * BITS_PER_PIXEL));
}

/** Arms native capture and waits for the stream, inside the single-file grant queue. */
async function acquireStream(recording: Recording, queued: boolean): Promise<MediaStream> {
  const { tabId } = recording;
  const bridge = webBridge!;

  if (recording.cancelBeforeGrant && queued)
    throw new BrowserScreencastStartCancelledError({ tabId });
  recording.grantStarted = true;
  if (recordings.get(tabId) !== recording) {
    await bridge.recording.stopScreencast(tabId).catch(() => undefined);
    throw operationFailed(
      "start-screencast",
      tabId,
      new BrowserScreencastStartCancelledError({ tabId }),
    );
  }

  let resolveCapture!: (flow: MediaStream) => void;
  let rejectCapture!: (err: unknown) => void;
  const captured = new Promise<MediaStream>((resolve, fail) => {
    resolveCapture = resolve;
    rejectCapture = fail;
  });
  const pending: PendingCapture = {
    frameRate: getClientPrefs().browserRecordingFrameRate,
    settled: false,
    resolve: (flow) => {
      if (pending.settled) return stopTracks(flow);
      pending.settled = true;
      resolveCapture(flow);
    },
    reject: (err) => {
      if (pending.settled) return;
      pending.settled = true;
      rejectCapture(err);
    },
  };
  const cancelPending = () => {
    pending.settled = true;
    if (pendingCaptures.get(tabId) === pending) pendingCaptures.delete(tabId);
  };
  pendingCaptures.set(tabId, pending);

  try {
    await bridge.recording.startScreencast(tabId);
  } catch (reason) {
    cancelPending();
    if (recording.phase !== "starting" || recordings.get(tabId) !== recording) {
      throw operationFailed(
        "start-screencast",
        tabId,
        new BrowserScreencastStartCancelledError({ tabId }),
      );
    }
    clearActiveScreencast(recording);
    throw operationFailed("start-screencast", tabId, reason);
  }
  if (recordings.get(tabId) !== recording) {
    cancelPending();
    await bridge.recording.stopScreencast(tabId).catch(() => undefined);
    throw operationFailed(
      "start-screencast",
      tabId,
      new BrowserScreencastStartCancelledError({ tabId }),
    );
  }

  let tmr: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      captured,
      new Promise<never>((_, fail) => {
        tmr = setTimeout(
          () =>
            fail(
              new BrowserScreencastCaptureTimeoutError({ tabId, timeoutMs: CAPTURE_TIMEOUT_MS }),
            ),
          CAPTURE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    cancelPending();
    const timedOut = Schema.is(BrowserScreencastCaptureTimeoutError)(err);
    const cleanupErrors = await cleanUp(recording, true);
    if (timedOut && cleanupErrors.length === 0) throw err;
    throw operationFailed(
      cleanupErrors.length > 0 ? "cleanup" : "capture-media-stream",
      tabId,
      cleanupErrors.length > 0 ? [err, ...cleanupErrors] : err,
    );
  } finally {
    clearTimeout(tmr);
  }
}

export async function startBrowserScreencast(
  tabKey: string,
  threadHandle: HostThreadRef | null = null,
  serverTabId: string = tabKey,
): Promise<string> {
  const bridge = webBridge;
  if (!bridge) throw new BrowserScreencastUnavailableError({ tabId: tabKey });

  const earlierFound = recordings.get(tabKey);
  if (earlierFound) {
    if (earlierFound.phase === "recording") return earlierFound.startedAt;
    throw new BrowserScreencastConflictError({ requestedTabId: tabKey, activeTabId: tabKey });
  }
  const tkey = threadHandle ? hostThreadKey(threadHandle) : null;
  if (tkey) {
    for (const other of recordings.values()) {
      if (other.threadKey === tkey && other.serverTabId === serverTabId) {
        throw new BrowserScreencastConflictError({
          requestedTabId: tabKey,
          activeTabId: other.tabId,
        });
      }
    }
  }

  let settleStartup!: () => void;
  const recording: Recording = {
    tabId: tabKey,
    serverTabId,
    threadKey: tkey,
    startedAt: new Date().toISOString(),
    phase: "starting",
    // Keeps a hidden tab compositing for as long as it is being recorded.
    releaseActivity: acquireBrowserSurfaceActivity(tabKey),
    startup: new Promise<void>((resolve) => {
      settleStartup = resolve;
    }),
    cancelBeforeGrant: false,
    grantStarted: false,
    recorder: null,
    stream: null,
    streamStopped: false,
    chunks: [],
    stopPromise: null,
  };
  recordings.set(tabKey, recording);
  publish();

  try {
    try {
      await ensureClientPrefsHydrated();
    } catch (err) {
      clearActiveScreencast(recording);
      throw err;
    }
    await waitForPaint();

    const queued = grantsWaiting > 0;
    grantsWaiting += 1;
    const turn = grantQueue;
    let leave!: () => void;
    grantQueue = new Promise<void>((resolve) => {
      leave = resolve;
    });
    let flow: MediaStream;
    try {
      await turn;
      flow = await acquireStream(recording, queued);
    } finally {
      grantsWaiting -= 1;
      leave();
    }
    recording.stream = flow;

    let recorder: MediaRecorder;
    try {
      const mediaType = MIME_PREFERENCE.find((typ) => MediaRecorder.isTypeSupported(typ));
      recorder = new MediaRecorder(flow, {
        ...(mediaType ? { mimeType: mediaType } : {}),
        videoBitsPerSecond: chooseBitrate(flow),
      });
      recorder.addEventListener("dataavailable", (evt) => {
        const blob = (evt as BlobEvent).data;
        if (blob && blob.size > 0) recording.chunks.push(blob);
      });
    } catch (reason) {
      const errors = await cleanUp(recording, true);
      throw operationFailed(
        errors.length ? "cleanup" : "initialize-media-recorder",
        tabKey,
        errors.length ? [reason, ...errors] : reason,
      );
    }
    recording.recorder = recorder;
    try {
      recorder.start(TIMESLICE_MS);
    } catch (reason) {
      const errors = await cleanUp(recording, true);
      throw operationFailed(
        errors.length ? "cleanup" : "start-media-recorder",
        tabKey,
        errors.length ? [reason, ...errors] : reason,
      );
    }

    if (recording.phase === "starting") recording.phase = "recording";
    return recording.startedAt;
  } finally {
    settleStartup();
  }
}

// ---------- stop ----------

async function finishRecording(recording: Recording): Promise<ShellWebScreencastArtifact | null> {
  const { tabId } = recording;
  const bridge = webBridge!;

  const verdict = await Promise.race([
    recording.startup.then(() => "settled" as const),
    delay(BROWSER_SCREENCAST_STARTUP_SETTLE_TIMEOUT_MS),
  ]);
  if (verdict === "timeout") {
    // Keep the slot: a late renderer start must not be mistaken for a newer recording.
    recording.stopPromise = recording.startup.then(async () => {
      await cleanUp(recording, true);
      return null;
    });
    recording.stopPromise.catch(() => undefined);
    throw operationFailed(
      "wait-startup",
      tabId,
      new Error("Recording startup did not settle in time."),
    );
  }

  let fault: BrowserScreencastOperationError | null = null;
  let artifact: ShellWebScreencastArtifact | null = null;
  try {
    try {
      await bridge.recording.stopScreencast(tabId);
    } catch (reason) {
      throw operationFailed("stop-screencast", tabId, reason);
    }
    if (recording.recorder) {
      try {
        await stopRecorder(recording);
      } catch (reason) {
        throw operationFailed("stop-media-recorder", tabId, reason);
      }
      stopStream(recording);
      const mediaType = recording.recorder.mimeType || recording.chunks[0]?.type || "";
      if (!mediaType) throw new BrowserScreencastFormatUnavailableError({ tabId });
      try {
        const buf = new Uint8Array(
          await new Blob(recording.chunks, { type: mediaType }).arrayBuffer(),
        );
        artifact = await bridge.recording.save(tabId, mediaType, buf);
      } catch (reason) {
        throw operationFailed("save-artifact", tabId, reason);
      }
    }
  } catch (err) {
    fault = err as BrowserScreencastOperationError;
  }

  const cleanupErrors = await cleanUp(recording, false);
  if (cleanupErrors.length > 0) {
    throw operationFailed("cleanup", tabId, fault ? [fault, ...cleanupErrors] : cleanupErrors);
  }
  if (fault) throw fault;
  return artifact;
}

export function stopBrowserScreencast(tabKey: string): Promise<ShellWebScreencastArtifact | null> {
  if (!webBridge) return Promise.resolve(null);
  const recording = recordings.get(tabKey);
  if (!recording) return Promise.resolve(null);
  if (recording.phase === "stopping" && recording.stopPromise) return recording.stopPromise;

  // Before the grant begins, the start can still be called off; after, it is allowed to finish.
  if (recording.phase === "starting" && !recording.grantStarted) recording.cancelBeforeGrant = true;
  recording.phase = "stopping";
  recording.stopPromise = finishRecording(recording);
  return recording.stopPromise;
}
