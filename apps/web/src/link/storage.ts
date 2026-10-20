import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import {
  ThreadIndexSnapshot,
  ThreadId,
  HostId,
  DaemonConfig,
  ChatThreadDetailSnapshot,
} from "@kora/contracts";
import { HostCacheStore, LinkPersistenceError } from "@kora/client-runtime/embedder";

import { projectFaviconCache } from "../assets/faviconCache";

const DB_NAME = "kora:connection-runtime";
const DB_VERSION = 6;
const OPEN_TIMEOUT_MS = 4_000;

const SHELL = "shell";
const THREAD = "thread";
const CONFIG = "server-config";
const CURRENT_STORES = [SHELL, THREAD, CONFIG] as const;
const LEGACY_STORES = ["catalog", "vcs-refs"] as const;

// The schema versions exist so older or partial snapshots fail to decode and become a cold cache.
const ShellRecord = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(2),
    hostId: HostId,
    snapshot: ThreadIndexSnapshot,
  }),
);
const ThreadRecord = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(4),
    hostId: HostId,
    threadId: ThreadId,
    snapshot: ChatThreadDetailSnapshot,
  }),
);
const ConfigRecord = Schema.fromJsonString(
  Schema.Struct({ schemaVersion: Schema.Literal(2), hostId: HostId, config: DaemonConfig }),
);

type Operation = ConstructorParameters<typeof LinkPersistenceError>[0]["operation"];

const failure = (operation1: Operation, reason: unknown) =>
  new LinkPersistenceError({
    operation: operation1,
    message: `Could not ${operation1.replaceAll("-", " ")}: ${reason instanceof Error ? reason.message : String(reason)}`,
  });

const request = <T>(req: IDBRequest<T>, tx: IDBTransaction): Promise<T> =>
  new Promise<T>((resolve, fail) => {
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    // Resolve only when the transaction has really committed.
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });

function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion >= 1 && oldVersion <= 4) {
    // Derived caches that the daemon re-sends are dropped, not migrated.
    for (const label of [...CURRENT_STORES, "vcs-refs"]) {
      if (db.objectStoreNames.contains(label)) db.deleteObjectStore(label);
    }
  }
  for (const label of LEGACY_STORES) {
    if (db.objectStoreNames.contains(label)) db.deleteObjectStore(label);
  }
  for (const label of CURRENT_STORES) {
    if (!db.objectStoreNames.contains(label)) db.createObjectStore(label);
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, fail) => {
    if (typeof indexedDB === "undefined") {
      fail(new Error("IndexedDB is unavailable"));
      return;
    }
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = (evt) => upgrade(open.result, evt.oldVersion);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => fail(open.error);
    open.onblocked = () => fail(new Error("Local cache upgrade is blocked"));
  });
}

type CacheStore = HostCacheStore["Service"];

function makeStore(db: IDBDatabase): CacheStore {
  const read = (storeName: string, keyName: string) => {
    const tx = db.transaction(storeName, "readonly");
    return request(tx.objectStore(storeName).get(keyName), tx);
  };
  const write = (storeName: string, keyName: string, val: string) => {
    const tx = db.transaction(storeName, "readwrite");
    return request(tx.objectStore(storeName).put(val, keyName), tx);
  };
  const remove = (storeName: string, keyName: string | IDBKeyRange) => {
    const tx = db.transaction(storeName, "readwrite");
    return request(tx.objectStore(storeName).delete(keyName), tx);
  };
  const tkey = (hostKey: string, threadId: string) => `${hostKey}:${threadId}`;

  const load = <A>(
    operation1: Operation,
    storeName: string,
    keyName: string,
    decode: (unparsed: string) => A | null,
  ) =>
    Effect.tryPromise({
      try: () => read(storeName, keyName),
      catch: (ch) => failure(operation1, ch),
    }).pipe(
      Effect.flatMap((unparsed) => {
        // Missing, or not a string: nothing cached.
        if (typeof unparsed !== "string") return Effect.succeedNone;
        return Effect.try({
          try: () => decode(unparsed),
          catch: (ch) => failure(operation1, ch),
        }).pipe(Effect.map((val) => (val === null ? Option.none<A>() : Option.some(val))));
      }),
    );
  const save = (operation1: Operation, storeName: string, keyName: string, encode: () => string) =>
    Effect.try({ try: encode, catch: (ch) => failure(operation1, ch) }).pipe(
      Effect.flatMap((val) =>
        Effect.tryPromise({
          try: () => write(storeName, keyName, val),
          catch: (ch) => failure(operation1, ch),
        }),
      ),
      Effect.asVoid,
    );

  return {
    loadShell: (hostKey) =>
      Effect.tryPromise({ try: () => projectFaviconCache.hydrate(), catch: () => undefined }).pipe(
        Effect.ignore,
        Effect.andThen(
          load("load-shell", SHELL, hostKey, (unparsed) => {
            const record = Schema.decodeUnknownSync(ShellRecord)(unparsed);
            return record.hostId === hostKey ? record.snapshot : null;
          }),
        ),
      ),
    saveShell: (hostKey, frameSnap) =>
      save("save-shell", SHELL, hostKey, () =>
        Schema.encodeSync(ShellRecord)({ schemaVersion: 2, hostId: hostKey, snapshot: frameSnap }),
      ),
    loadThread: (hostKey, threadId) =>
      load("load-thread", THREAD, tkey(hostKey, threadId), (unparsed) => {
        const record = Schema.decodeUnknownSync(ThreadRecord)(unparsed);
        return record.hostId === hostKey && record.threadId === threadId ? record.snapshot : null;
      }),
    saveThread: (hostKey, frameSnap) =>
      save("save-thread", THREAD, tkey(hostKey, frameSnap.thread.id), () =>
        Schema.encodeSync(ThreadRecord)({
          schemaVersion: 4,
          hostId: hostKey,
          threadId: frameSnap.thread.id,
          snapshot: frameSnap,
        }),
      ),
    removeThread: (hostKey, threadId) =>
      Effect.tryPromise({
        try: () => remove(THREAD, tkey(hostKey, threadId)),
        catch: (ch) => failure("remove-thread", ch),
      }).pipe(Effect.asVoid),
    loadDaemonConfig: (hostKey) =>
      load("load-server-config", CONFIG, hostKey, (unparsed) => {
        const record = Schema.decodeUnknownSync(ConfigRecord)(unparsed);
        return record.hostId === hostKey ? record.config : null;
      }),
    saveDaemonConfig: (hostKey, cfg) =>
      save("save-server-config", CONFIG, hostKey, () =>
        Schema.encodeSync(ConfigRecord)({ schemaVersion: 2, hostId: hostKey, config: cfg }),
      ),
    clear: (hostKey) =>
      Effect.all(
        [
          Effect.tryPromise({
            try: () => projectFaviconCache.clearHost(hostKey),
            catch: (ch) => failure("clear-environment", ch),
          }),
          Effect.tryPromise({
            try: () => remove(SHELL, hostKey),
            catch: (ch) => failure("clear-environment", ch),
          }),
          Effect.tryPromise({
            try: () => remove(THREAD, IDBKeyRange.bound(`${hostKey}:`, `${hostKey}:￿`)),
            catch: (ch) => failure("clear-environment", ch),
          }),
          Effect.tryPromise({
            try: () => remove(CONFIG, hostKey),
            catch: (ch) => failure("clear-environment", ch),
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
  };
}

/** Loads nothing and drops every write: the app simply runs cold. */
const noCache: CacheStore = {
  clear: () => Effect.void,
  saveDaemonConfig: () => Effect.void,
  loadDaemonConfig: () => Effect.succeedNone,
  removeThread: () => Effect.void,
  saveThread: () => Effect.void,
  loadThread: () => Effect.succeedNone,
  saveShell: () => Effect.void,
  loadShell: () => Effect.succeedNone,
};

// Resolves to null when the browser refuses the database or takes too long.
const openDatabaseOrNull = Effect.callback<IDBDatabase | null>((resume) => {
  let abandoned = false;
  openDatabase().then(
    (db) => {
      if (abandoned)
        db.close(); // it arrived after we gave up
      else resume(Effect.succeed(db));
    },
    () => {
      if (!abandoned) resume(Effect.succeed(null));
    },
  );
  return Effect.sync(() => {
    abandoned = true;
  });
}).pipe(Effect.timeoutOption(`${OPEN_TIMEOUT_MS} millis`), Effect.map(Option.getOrNull));

export const linkStorageLayer = Layer.effect(
  HostCacheStore,
  Effect.gen(function* () {
    const db = yield* openDatabaseOrNull;
    if (db === null) {
      yield* Effect.logWarning("Local cache unavailable; running without it");
      return noCache;
    }
    // Never hold up another window's upgrade or delete.
    db.onversionchange = () => db.close();
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    return makeStore(db);
  }),
);
