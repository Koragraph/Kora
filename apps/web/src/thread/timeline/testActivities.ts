/** Activities for timeline tests, shaped as the client stores them after ingestion. */
import { classifyTaskAgentKind, EventId, TurnId, type ChatThreadActivity } from "@kora/contracts";

let counter = 0;

/** Seconds after a fixed start, as an ISO time: `at(5)` is five seconds in. */
export const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, seconds)).toISOString();

type Options = {
  id?: string;
  /** Seconds after the start (see `at`), or an ISO time. */
  time?: number | string;
  turn?: string;
  summary?: string;
  tone?: ChatThreadActivity["tone"];
  sequence?: number;
  payload?: Record<string, unknown>;
};

/**
 * One activity of `kind`. Task rows get the `agentKind` stamp ingestion adds (pass one in the payload to model an
 * older row without it).
 */
export function activity(kind: string, options: Options = {}): ChatThreadActivity {
  const payload = options.payload ?? {};
  const needsStamp = kind.startsWith("task.") && !("agentKind" in payload);
  const named = (key: string) =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;
  const agentKind = needsStamp
    ? classifyTaskAgentKind({ agentId: named("agentId"), taskType: named("taskType") })
    : undefined;
  const stamped = agentKind === undefined ? payload : { ...payload, agentKind };
  const time = options.time ?? 0;
  return {
    id: EventId.make(options.id ?? `a${++counter}`),
    kind,
    createdAt: typeof time === "number" ? at(time) : time,
    summary: options.summary ?? "Tool call",
    tone: options.tone ?? "tool",
    turnId: options.turn ? TurnId.make(options.turn) : null,
    payload: stamped,
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
  };
}
