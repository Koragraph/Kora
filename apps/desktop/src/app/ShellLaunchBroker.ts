// @effect-diagnostics globalTimers:off -- request deadlines are plain cancellable timers on purpose (see below).
import {
  SHELL_LAUNCH_PROTOCOL_VERSION,
  type ShellLaunchFailure,
  type ShellLaunchRequest,
  type ShellLaunchResponse,
} from "@kora/contracts";

type FailureCode = ShellLaunchFailure["code"];

const failure = (requestId: string, code: FailureCode, message: string): ShellLaunchFailure => ({
  version: SHELL_LAUNCH_PROTOCOL_VERSION,
  requestId,
  ok: false,
  code,
  message,
});

interface Waiting {
  readonly request: ShellLaunchRequest;
  readonly settle: (response: ShellLaunchResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  sent: boolean;
}

/**
 * Holds "open this project" requests from the CLI until the renderer can take them, hands them over one at a
 * time, and always ends each one with a response: the renderer's, a timeout, a cancel, or a shutdown notice.
 * Timers are plain timeouts on purpose: a deadline has to be cancellable the moment a request settles.
 */
export class ShellLaunchBroker {
  private readonly waiting = new Map<string, Waiting>();
  private sender: ((request: ShellLaunchRequest) => void) | null = null;
  private closed = false;

  private readonly options: {
    readonly requestTimeoutMs: number;
    readonly activate: () => void;
  };

  constructor(options: { readonly requestTimeoutMs: number; readonly activate: () => void }) {
    this.options = options;
  }

  request(request: ShellLaunchRequest): Promise<ShellLaunchResponse> {
    const id = request.requestId;
    if (this.closed) {
      return Promise.resolve(failure(id, "renderer-unavailable", "Kora is shutting down."));
    }
    if (this.waiting.has(id)) {
      return Promise.resolve(failure(id, "invalid-request", "The request id is already in use."));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          this.settle(
            id,
            failure(
              id,
              "request-timeout",
              "The desktop app did not finish opening the project in time.",
            ),
          ),
        this.options.requestTimeoutMs,
      );
      this.waiting.set(id, { request, settle: resolve, timer, sent: false });
      this.options.activate();
      this.flush();
    });
  }

  registerRenderer(send: (request: ShellLaunchRequest) => void): void {
    this.sender = send;
    this.flush();
  }

  clearRenderer(): void {
    this.sender = null;
    // Whatever the old renderer was handed is lost with it; requests not yet handed over wait for the next one.
    for (const [id, entry] of [...this.waiting]) {
      if (entry.sent) {
        this.settle(
          id,
          failure(
            id,
            "renderer-unavailable",
            "The Kora window closed before it opened the project.",
          ),
        );
      }
    }
  }

  complete(response: ShellLaunchResponse): void {
    this.settle(response.requestId, response);
  }

  cancel(requestId: string): void {
    this.settle(
      requestId,
      failure(requestId, "renderer-unavailable", "The command closed before Kora was ready."),
    );
  }

  close(): void {
    this.closed = true;
    this.sender = null;
    for (const id of [...this.waiting.keys()]) {
      this.settle(id, failure(id, "renderer-unavailable", "Kora is shutting down."));
    }
  }

  private settle(id: string, response: ShellLaunchResponse): void {
    const entry = this.waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.waiting.delete(id);
    entry.settle(response);
    this.flush();
  }

  // At most one request is with the renderer at any moment; the next goes out only after it settles.
  private flush(): void {
    const send = this.sender;
    if (!send) return;
    let next: Waiting | undefined;
    for (const entry of this.waiting.values()) {
      if (entry.sent) return;
      next ??= entry;
    }
    if (!next) return;
    next.sent = true;
    try {
      send(next.request);
    } catch {
      next.sent = false;
      this.sender = null;
    }
  }
}
