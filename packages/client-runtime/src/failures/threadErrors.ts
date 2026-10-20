import { ChatDispatchError } from "@kora/contracts";
import * as Schema from "effect/Schema";

const isChatDispatchError = Schema.is(ChatDispatchError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return isChatDispatchError(error) && error.bootstrapThreadDisposition === "deleted";
}
