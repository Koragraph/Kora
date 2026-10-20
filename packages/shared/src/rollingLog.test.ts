// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { MachinePlatform } from "./hostMachine.ts";
import * as Logging from "./rollingLog.ts";

const onWindows = MachinePlatform.defaultValue() === "win32";

const scratch = new Set<string>();
afterEach(() => {
  scratch.forEach((dir) => NodeFS.rmSync(dir, { recursive: true, force: true }));
  scratch.clear();
});

/** A fresh folder with a `app.log` path inside it. */
function logPathInScratch(name = "app.log") {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-rolling-"));
  scratch.add(dir);
  return { dir, filePath: NodePath.join(dir, name) };
}

/** Runs `action` and returns what it threw; fails the test if nothing was thrown. */
function thrownBy(action: () => unknown): any {
  let error: unknown;
  let threw = false;
  try {
    action();
  } catch (caught) {
    threw = true;
    error = caught;
  }
  expect(threw, "expected the action to throw").toBe(true);
  return error;
}

const sinkAt = (filePath: string, maxBytes: number, extra: { throwOnError?: boolean } = {}) =>
  new Logging.RollingLogSink({ filePath, maxBytes, maxFiles: 1, ...extra });

const expectSinkError = (error: unknown, operation: string, filePath: string) => {
  expect(error).toBeInstanceOf(Logging.RotatingFileSinkError);
  expect(error).toMatchObject({ operation, filePath });
};

describe("rolling log sink", () => {
  describe("configuration", () => {
    for (const [option, maxBytes, maxFiles] of [
      ["maxBytes", 0, 3],
      ["maxFiles", 10, 0],
    ] as const) {
      it(`rejects ${option} = 0 with a typed error`, () => {
        const error = thrownBy(
          () => new Logging.RollingLogSink({ filePath: "/never/used.log", maxBytes, maxFiles }),
        );
        expect(error).toBeInstanceOf(Logging.RotatingFileSinkConfigurationError);
        expect(error).toMatchObject({ option, received: 0, minimum: 1 });
        expect(error.message).toBe(`${option} must be >= 1 (received 0)`);
      });
    }
  });

  describe("start-up", () => {
    it("fails to initialize when the parent path is a file", () => {
      const { dir } = logPathInScratch();
      const blocker = NodePath.join(dir, "blocker");
      NodeFS.writeFileSync(blocker, "x");
      const filePath = NodePath.join(blocker, "app.log");

      const error = thrownBy(() => sinkAt(filePath, 1));
      expectSinkError(error, "initialize", filePath);
      expect(error.cause).toBeInstanceOf(Error);
    });

    // A too-long name makes stat fail with something other than ENOENT/EACCES on posix;
    // Windows calls it ENOENT, which the sink rightly reads as "no file yet".
    it.skipIf(onWindows)("surfaces a stat failure that is not a missing file", () => {
      const { filePath } = logPathInScratch("n".repeat(300));
      const error = thrownBy(() => sinkAt(filePath, 1));
      expectSinkError(error, "read", filePath);
      expect(error.cause).toMatchObject({ code: "ENAMETOOLONG" });
    });

    it("creates a missing log file on first write", () => {
      const { filePath } = logPathInScratch();
      sinkAt(filePath, 64).write("first line");
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("first line");
    });

    it("fails to prune when an extra backup slot is a non-empty folder", () => {
      const { filePath } = logPathInScratch();
      const stale = `${filePath}.2`;
      NodeFS.mkdirSync(stale);
      NodeFS.writeFileSync(NodePath.join(stale, "inside"), "x");

      const error = thrownBy(() => sinkAt(filePath, 1, { throwOnError: true }));
      expectSinkError(error, "prune", filePath);
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  describe("writing and rotating", () => {
    it("reports a write into a path that is a folder", () => {
      const { filePath } = logPathInScratch();
      NodeFS.mkdirSync(filePath);
      const sink = sinkAt(filePath, Number.MAX_SAFE_INTEGER, { throwOnError: true });

      const error = thrownBy(() => sink.write("line"));
      expectSinkError(error, "write", filePath);
      expect(error.cause).toMatchObject({ code: "EISDIR" });
    });

    it("reports a rotation that cannot move the file aside, as a rotate error", () => {
      const { filePath } = logPathInScratch();
      NodeFS.writeFileSync(filePath, "z");
      NodeFS.mkdirSync(`${filePath}.1`);
      const sink = sinkAt(filePath, 1, { throwOnError: true });

      const error = thrownBy(() => sink.write("y"));
      expectSinkError(error, "rotate", filePath);
      expect(error.cause).toBeInstanceOf(Error);
    });

    it("writes the oversized chunk first and fails the rotation on the next write", () => {
      const { filePath } = logPathInScratch();
      NodeFS.mkdirSync(`${filePath}.1`);
      const sink = sinkAt(filePath, 1, { throwOnError: true });

      sink.write("much too long");
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("much too long");

      expect(thrownBy(() => sink.write("after"))).toMatchObject({ operation: "rotate", filePath });
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("much too long");
    });
  });
});
