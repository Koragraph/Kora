export interface SafeErrorLogAttributes {
  readonly stack?: string;
  readonly traceId?: string;
  readonly errorTag?: string;
  readonly errorName?: string;
  readonly errorType: "error" | "array" | "null" | "object" | "primitive";
}

// Messages, paths and query strings can hold secrets, so only recognisable error names and
// tags are logged, never free text.
const SAFE_LABEL =
  /^(Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|AggregateError|DOMException|[A-Za-z][A-Za-z0-9]*(Error|Failure))$/;
const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_FRAMES = 32;

const safeLabel = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_LABEL.test(value) ? value : undefined;

const readTag = (value: unknown): string | undefined => {
  try {
    return typeof value === "object" && value !== null
      ? safeLabel((value as { _tag?: unknown })._tag)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The first well-formed `traceId` on the value or anywhere along its `cause` chain. */
const readTraceId = (value: unknown): string | undefined => {
  try {
    const seen = new Set<unknown>();
    let current: unknown = value;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const candidate = (current as { traceId?: unknown }).traceId;
      if (typeof candidate === "string" && SAFE_TRACE_ID.test(candidate)) return candidate;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // unreadable; log without it
  }
  return undefined;
};

const URL_IN_TEXT = /\b(?:https?|file):\/\/[^\s)'"]+/gi;

const stripUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    for (const part of ["username", "password", "search", "hash"] as const) url[part] = "";
    return url.toString();
  } catch {
    return raw;
  }
};

const V8_FRAME = /^\s*at\s/;
const WEBKIT_FRAME = /^[^\s@]*@(?:https?|file):\/\//i;

const scrubbedStack = (error: Error): string | undefined => {
  try {
    const frames = (error.stack ?? "")
      .split("\n")
      .filter((line) => V8_FRAME.test(line) || WEBKIT_FRAME.test(line.trim()))
      .slice(0, MAX_FRAMES)
      .map((line) => line.replace(URL_IN_TEXT, stripUrl));
    return frames.length > 0 ? frames.join("\n") : undefined;
  } catch {
    return undefined;
  }
};

export function errorLogFields(error: unknown): SafeErrorLogAttributes {
  const errorTag = readTag(error);
  const traceId = readTraceId(error);
  const optional = {
    ...(errorTag === undefined ? {} : { errorTag }),
    ...(traceId === undefined ? {} : { traceId }),
  };

  if (error instanceof Error) {
    const errorName = safeLabel(error.name);
    const stack = scrubbedStack(error);
    return {
      errorType: "error",
      ...(errorName === undefined ? {} : { errorName }),
      ...optional,
      ...(stack === undefined ? {} : { stack }),
    };
  }
  let errorType: SafeErrorLogAttributes["errorType"] = "primitive";
  if (error === null) errorType = "null";
  else if (Array.isArray(error)) errorType = "array";
  else if (typeof error === "object") errorType = "object";
  return { errorType, ...optional };
}
