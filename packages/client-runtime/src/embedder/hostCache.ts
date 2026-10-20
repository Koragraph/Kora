import {
  type ThreadId,
  type DaemonConfig,
  type ChatThreadDetailSnapshot,
  type ThreadIndexSnapshot,
  type HostId,
} from "@kora/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

export class LinkPersistenceError extends Schema.TaggedError<LinkPersistenceError>()(
  "LinkPersistenceError",
  {
    operation: Schema.Literals([
      ...(["load-shell", "save-shell"] as const),
      ...(["load-thread", "save-thread", "remove-thread"] as const),
      ...(["load-server-config", "save-server-config"] as const),
      "clear-environment",
    ]),
    message: Schema.String,
  },
) {}

export class HostCacheStore extends Context.Service<
  HostCacheStore,
  {
    readonly loadShell: (
      hostId: HostId,
    ) => Effect.Effect<Option.Option<ThreadIndexSnapshot>, LinkPersistenceError>;
    readonly saveShell: (
      hostId: HostId,
      snapshot: ThreadIndexSnapshot,
    ) => Effect.Effect<void, LinkPersistenceError>;
    readonly loadThread: (
      hostId: HostId,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ChatThreadDetailSnapshot>, LinkPersistenceError>;
    readonly saveThread: (
      hostId: HostId,
      snapshot: ChatThreadDetailSnapshot,
    ) => Effect.Effect<void, LinkPersistenceError>;
    readonly removeThread: (
      hostId: HostId,
      threadId: ThreadId,
    ) => Effect.Effect<void, LinkPersistenceError>;
    /**
     * The last complete server configuration. This deliberately includes provider
     * metadata so offline task creation can still offer the models a user last saw.
     */
    readonly loadDaemonConfig: (
      hostId: HostId,
    ) => Effect.Effect<Option.Option<DaemonConfig>, LinkPersistenceError>;
    readonly saveDaemonConfig: (
      hostId: HostId,
      config: DaemonConfig,
    ) => Effect.Effect<void, LinkPersistenceError>;
    readonly clear: (hostId: HostId) => Effect.Effect<void, LinkPersistenceError>;
  }
>()("@kora/client-runtime/embedder/hostCache/HostCacheStore") {}

export class HostOwnedDataCleanup extends Context.Reference<{
  readonly clear: (hostId: HostId) => Effect.Effect<void>;
}>("@kora/client-runtime/embedder/persistence/HostOwnedDataCleanup", {
  defaultValue: () => ({
    clear: () => Effect.void,
  }),
}) {}
