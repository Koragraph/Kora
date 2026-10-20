// @effect-diagnostics nodeBuiltinImport:off -- a synchronous rotating writer; FileSystem would make it async and reorder writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

export interface RotatingFileSinkOptions {
  /** Surface I/O failures as errors instead of swallowing them. Logging must not crash the app by default. */
  readonly throwOnError?: boolean;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly filePath: string;
}

export class RotatingFileSinkConfigurationError extends Schema.TaggedError<RotatingFileSinkConfigurationError>()(
  "RotatingFileSinkConfigurationError",
  {
    minimum: Schema.Number,
    received: Schema.Number,
    option: Schema.Literals(["maxBytes", "maxFiles"]),
  },
) {
  override get message() {
    return this.option + " must be >= " + this.minimum + " (received " + this.received + ")";
  }
}

export class RotatingFileSinkError extends Schema.TaggedError<RotatingFileSinkError>()(
  "RotatingFileSinkError",
  {
    cause: Schema.Defect(),
    filePath: Schema.String,
    operation: Schema.Literals(["initialize", "read", "write", "rotate", "prune"]),
  },
) {
  override get message() {
    return `Failed to ${this.operation} rotating log file ${this.filePath}`;
  }
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/**
 * Appends synchronously to `filePath`, rotating to `<filePath>.1` ... `<filePath>.<maxFiles>`
 * (newest first) once a write would push the file past `maxBytes`.
 */
export class RollingLogSink {
  private size = 0;
  private readonly throwOnError: boolean;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly filePath: string;

  constructor(options: RotatingFileSinkOptions) {
    for (const option of ["maxBytes", "maxFiles"] as const) {
      const received = options[option];
      if (received < 1) {
        throw new RotatingFileSinkConfigurationError({ option, received, minimum: 1 });
      }
    }
    this.throwOnError = options.throwOnError ?? false;
    this.maxFiles = options.maxFiles;
    this.maxBytes = options.maxBytes;
    this.filePath = options.filePath;

    try {
      const folder = NodePath.dirname(this.filePath);
      NodeFS.mkdirSync(folder, { recursive: true });
    } catch (cause) {
      throw new RotatingFileSinkError({ operation: "initialize", filePath: this.filePath, cause });
    }
    this.pruneOverflowBackups();
    this.size = this.readSize({ strict: true });
  }

  write(chunk: string | Buffer): void {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (data.length === 0) return;

    try {
      // A single oversize chunk into an empty file is still written whole.
      if (this.size > 0 && this.size + data.length > this.maxBytes) this.rotate();
      NodeFS.appendFileSync(this.filePath, data);
      this.size += data.length;
    } catch (cause) {
      if (Predicate.isTagged(cause, "RotatingFileSinkError")) throw cause;
      if (this.throwOnError) {
        throw new RotatingFileSinkError({ operation: "write", filePath: this.filePath, cause });
      }
      this.size = this.readSize({ strict: false });
    }
  }

  private backup(index: number): string {
    return `${this.filePath}.${index}`;
  }

  private readSize(options: { strict: boolean }): number {
    try {
      return NodeFS.statSync(this.filePath).size;
    } catch (cause) {
      if (isMissing(cause)) return 0;
      if (options.strict) {
        throw new RotatingFileSinkError({ operation: "read", filePath: this.filePath, cause });
      }
      return 0;
    }
  }

  /** Remove backups numbered above `maxFiles`, left by an earlier, larger configuration. */
  private pruneOverflowBackups(): void {
    try {
      const prefix = `${NodePath.basename(this.filePath)}.`;
      for (const entry of NodeFS.readdirSync(NodePath.dirname(this.filePath))) {
        if (!entry.startsWith(prefix)) continue;
        const suffix = entry.slice(prefix.length);
        if (!/^\d+$/.test(suffix) || Number(suffix) <= this.maxFiles) continue;
        NodeFS.rmSync(NodePath.join(NodePath.dirname(this.filePath), entry), { force: true });
      }
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({ operation: "prune", filePath: this.filePath, cause });
      }
    }
  }

  private rotate(): void {
    try {
      NodeFS.rmSync(this.backup(this.maxFiles), { force: true });
      for (let index = this.maxFiles - 1; index >= 1; index--) {
        if (NodeFS.existsSync(this.backup(index))) {
          NodeFS.renameSync(this.backup(index), this.backup(index + 1));
        }
      }
      NodeFS.renameSync(this.filePath, this.backup(1));
      this.size = 0;
    } catch (cause) {
      if (this.throwOnError) {
        throw new RotatingFileSinkError({ operation: "rotate", filePath: this.filePath, cause });
      }
      this.size = this.readSize({ strict: false });
    }
  }
}
