import * as Electron from "electron";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";

import {
  decideWebTabPermission,
  decideWebTabDownload,
  createDownloadRateLimiter,
} from "./WebTabPolicy.ts";

export type BrowserSessionPartitionNamespace = "profile";

const PERSISTENT_PREFIX = "persist:kora-preview-";
// Deliberately no `persist:` here: Chromium then keeps the partition in memory and drops it with the process.
const EPHEMERAL_PREFIX = "kora-preview-ephemeral-";
const PROFILE_MARKER = "profile-";
const DIGEST_HEX_LENGTH = 20;
const DOWNLOAD_BURST_LIMIT = 3;
const DOWNLOAD_BURST_WINDOW_MS = 10_000;

export class BrowserSessionPartitionDerivationError extends Schema.TaggedError<BrowserSessionPartitionDerivationError>()(
  "BrowserSessionPartitionDerivationError",
  { scope: Schema.String, cause: Schema.instanceOf(PlatformError.PlatformError) },
) {
  override get message() {
    const detail = `Failed to derive a desktop preview browser partition for scope ${this.scope}.`;
    return detail;
  }
}

export class BrowserSessionCreationError extends Schema.TaggedError<BrowserSessionCreationError>()(
  "BrowserSessionCreationError",
  { scope: Schema.String, partition: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    const detail = `Failed to create a desktop preview browser session for scope ${this.scope} (partition ${this.partition}).`;
    return detail;
  }
}

export class BrowserSessionStorageClearError extends Schema.TaggedError<BrowserSessionStorageClearError>()(
  "BrowserSessionStorageClearError",
  { partition: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    const detail = `Failed to clear desktop preview browser storage for partition ${this.partition}.`;
    return detail;
  }
}

export class BrowserSessionCacheClearError extends Schema.TaggedError<BrowserSessionCacheClearError>()(
  "BrowserSessionCacheClearError",
  { partition: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    const detail = `Failed to clear the desktop preview browser cache for partition ${this.partition}.`;
    return detail;
  }
}

export const BrowserSessionGetSessionError = Schema.Union([
  BrowserSessionCreationError,
  BrowserSessionPartitionDerivationError,
]);
export type BrowserSessionGetSessionError = typeof BrowserSessionGetSessionError.Type;

export const BrowserSessionError = Schema.Union([
  BrowserSessionCacheClearError,
  BrowserSessionStorageClearError,
  BrowserSessionCreationError,
  BrowserSessionPartitionDerivationError,
]);
export type BrowserSessionError = typeof BrowserSessionError.Type;

export class WebPartitions extends Context.Service<
  WebPartitions,
  {
    readonly getPartition: (
      scopeId?: string,
      keepAcrossRestarts?: boolean,
      ns?: BrowserSessionPartitionNamespace,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partName: string) => boolean;
    readonly getSession: (
      scopeId?: string,
      keepAcrossRestarts?: boolean,
      ns?: BrowserSessionPartitionNamespace,
    ) => Effect.Effect<Electron.Session, BrowserSessionGetSessionError>;
    /** Clears cookies and site storage; with no list, every session opened so far. */
    readonly clearCookies: (
      only?: ReadonlyArray<string>,
    ) => Effect.Effect<void, BrowserSessionStorageClearError>;
    readonly clearCache: (
      only?: ReadonlyArray<string>,
    ) => Effect.Effect<void, BrowserSessionCacheClearError>;
  }
>()("@kora/desktop/web/WebPartitions") {}

/**
 * The bytes hashed for a scope. TextEncoder turns a lone surrogate into U+FFFD, which would let two distinct ids
 * share cookies, so each lone surrogate is written out as `\uXXXX` (after doubling backslashes so the escape
 * cannot be typed by hand). Well-formed scopes encode as plain UTF-8, keeping existing logins in place.
 */
function scopeBytes(scope: string): Uint8Array {
  let str = "";
  const doubled = scope.replaceAll("\\", "\\\\");
  for (let pos = 0; pos < doubled.length; pos += 1) {
    const unit = doubled.charCodeAt(pos);
    const upcoming = doubled.charCodeAt(pos + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && upcoming >= 0xdc00 && upcoming <= 0xdfff) {
      str += doubled.slice(pos, pos + 2);
      pos += 1;
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      str += `\\u${unit.toString(16).padStart(4, "0")}`;
    } else {
      str += doubled[pos];
    }
  }
  return new TextEncoder().encode(str);
}

type PermissionSession = Pick<
  Electron.Session,
  "setPermissionRequestHandler" | "setPermissionCheckHandler" | "on"
>;

const firstNonEmpty = (...values: ReadonlyArray<string | null | undefined>) =>
  values.find((val): val is string => typeof val === "string" && val.length > 0);

/** Deny-by-default permissions and always-prompt downloads for a preview partition. */
export function installWebTabSessionPolicy(
  browserSession: PermissionSession,
  downloadsPath: () => string,
  clock: () => number = Date.now,
): void {
  browserSession.setPermissionRequestHandler((inner, permission, callback, detailInfo) => {
    callback(
      decideWebTabPermission({
        permission,
        requestingUrl: firstNonEmpty(detailInfo.requestingUrl, inner?.getURL()),
      }),
    );
  });
  browserSession.setPermissionCheckHandler((inner, permission, requestingOrigin, detailInfo) =>
    decideWebTabPermission({
      permission,
      requestingUrl: firstNonEmpty(detailInfo?.requestingUrl, requestingOrigin, inner?.getURL()),
    }),
  );

  const withinBurstLimit = createDownloadRateLimiter({
    limit: DOWNLOAD_BURST_LIMIT,
    windowMs: DOWNLOAD_BURST_WINDOW_MS,
    now: clock,
  });
  browserSession.on("will-download", (evt, item, inner) => {
    const decision = decideWebTabDownload({
      url: item.getURL(),
      suggestedFileName: item.getFilename(),
      allowedByRateLimit: withinBurstLimit(inner?.id ?? -1),
    });
    if (decision.action === "cancel") {
      evt.preventDefault();
      return;
    }
    // No save path is set, so Electron always asks; nothing reaches the disk unless the user picks a place.
    item.setSaveDialogOptions({
      title: decision.title,
      message: decision.message,
      defaultPath: `${downloadsPath().replace(/\/$/, "")}/${decision.fileName}`,
    });
  });
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const cacheLock = yield* Semaphore.make(1);
  const sesss = new Map<string, Electron.Session>();

  const getPartition: WebPartitions["Service"]["getPartition"] = (
    scope = "shared",
    durable = true,
    nsName,
  ) =>
    crypto.digest("SHA-256", scopeBytes(scope)).pipe(
      Effect.map(
        (digest) =>
          `${durable ? PERSISTENT_PREFIX : EPHEMERAL_PREFIX}${nsName === "profile" ? PROFILE_MARKER : ""}${Encoding.encodeHex(digest).slice(0, DIGEST_HEX_LENGTH)}`,
      ),
      Effect.mapError(
        (reason) => new BrowserSessionPartitionDerivationError({ scope: scope, cause: reason }),
      ),
    );

  const getSession: WebPartitions["Service"]["getSession"] = (
    scope = "shared",
    durable = true,
    nsName,
  ) =>
    Effect.gen(function* () {
      const partName = yield* getPartition(scope, durable, nsName);
      return yield* cacheLock.withPermits(1)(
        Effect.gen(function* () {
          const recognised = sesss.get(partName);
          if (recognised) return recognised;
          // The guest keeps Electron's own User-Agent. Any rewrite, even one that keeps the Electron token, makes
          // Cloudflare Turnstile fail with error 600010 and loop forever, so logins would never finish.
          const created = yield* Effect.try({
            try: () => {
              const upcoming = Electron.session.fromPartition(partName);
              installWebTabSessionPolicy(upcoming, () => Electron.app.getPath("downloads"));
              return upcoming;
            },
            catch: (reason) =>
              new BrowserSessionCreationError({
                scope: scope,
                partition: partName,
                cause: reason,
              }),
          });
          sesss.set(partName, created);
          return created;
        }),
      );
    });

  // Only sessions already opened in this run can be cleared; callers open the one they mean first.
  const selected = (partitions: ReadonlyArray<string> | undefined) =>
    [...sesss].filter(([partition]) => partitions === undefined || partitions.includes(partition));

  // Every selected session is attempted; the first failure (in session order) is the one reported.
  const clearAll = <Err>(
    partitions: ReadonlyArray<string> | undefined,
    exec: (sess: Electron.Session) => Promise<void>,
    toError: (partName: string, reason: unknown) => Err,
  ) =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(
        selected(partitions),
        ([partition, session]) =>
          Effect.tryPromise({
            try: () => exec(session),
            catch: (reason) => toError(partition, reason),
          }).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      for (const verdict of outcomes) {
        if (verdict._tag === "Failure") return yield* Effect.fail(verdict.failure);
      }
    });

  return WebPartitions.of({
    getPartition,
    isPartition: (partName) =>
      partName.startsWith(PERSISTENT_PREFIX) || partName.startsWith(EPHEMERAL_PREFIX),
    getSession,
    clearCookies: (partitions) =>
      clearAll(
        partitions,
        (sess) =>
          sess.clearStorageData({
            storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
          }),
        (partName, reason) =>
          new BrowserSessionStorageClearError({ partition: partName, cause: reason }),
      ),
    clearCache: (partitions) =>
      clearAll(
        partitions,
        (sess) => sess.clearCache(),
        (partName, reason) =>
          new BrowserSessionCacheClearError({ partition: partName, cause: reason }),
      ),
  });
}).pipe(Effect.withSpan("WebPartitions.make"));

export const layer = Layer.effect(WebPartitions, make);
