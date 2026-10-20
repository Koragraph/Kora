import type * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";

export type LinkWakeup =
  | "credentials-changed"
  | "application-active-reconnect"
  | "application-active-probe"
  | "application-active";

const ACTIVE_WAKEUPS: ReadonlySet<LinkWakeup> = new Set<LinkWakeup>([
  "application-active-reconnect",
  "application-active-probe",
  "application-active",
]);

export const isApplicationActiveWakeup = (reason: LinkWakeup): boolean =>
  ACTIVE_WAKEUPS.has(reason);

export function shouldResubscribeAfterWakeup(reason: LinkWakeup): boolean {
  return reason === "application-active" || reason === "application-active-probe";
}

export class LinkWakeups extends Context.Service<
  LinkWakeups,
  {
    readonly changes: Stream.Stream<LinkWakeup>;
  }
>()("@kora/client-runtime/link/wakeups/LinkWakeups") {}

const make = (service: LinkWakeups["Service"]) => LinkWakeups.of(service);

export const layer = (service: LinkWakeups["Service"]) => Layer.succeed(LinkWakeups, make(service));
