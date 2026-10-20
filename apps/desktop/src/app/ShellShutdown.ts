import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";

export class ShellShutdown extends Context.Service<
  ShellShutdown,
  {
    readonly isComplete: Effect.Effect<boolean>;
    readonly awaitComplete: Effect.Effect<void>;
    readonly markComplete: Effect.Effect<void>;
    readonly awaitRequest: Effect.Effect<void>;
    readonly request: Effect.Effect<void>;
  }
>()("@kora/desktop/app/ShellShutdown") {}

const make = Effect.gen(function* () {
  const completedRef = yield* Ref.make(false);
  const completed = yield* Deferred.make<void>();
  const requested = yield* Deferred.make<void>();

  return ShellShutdown.of({
    isComplete: Ref.get(completedRef),
    awaitComplete: Deferred.await(completed),
    markComplete: Effect.asVoid(
      Effect.andThen(Ref.set(completedRef, true), Deferred.succeed(completed, undefined)),
    ),
    awaitRequest: Deferred.await(requested),
    request: Effect.asVoid(Deferred.succeed(requested, undefined)),
  });
});

export const layer = Layer.effect(ShellShutdown, make);
