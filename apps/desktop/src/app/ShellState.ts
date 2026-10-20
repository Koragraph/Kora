import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

export class ShellState extends Context.Service<
  ShellState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
  }
>()("@kora/desktop/app/ShellState") {}

const make = Effect.all({
  quitting: Ref.make(false),
  backendReady: Ref.make(false),
});

export const layer = Layer.effect(ShellState, make);
