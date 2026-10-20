// Resolves once the listed files exist and a TCP port accepts connections (used by the dev runner).
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCAL_CANDIDATES = ["127.0.0.1", "localhost", "::1"];

function canConnect(host, port, timeoutMs) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function portReady(host, port, timeoutMs) {
  const hosts = host ? [host] : LOCAL_CANDIDATES;
  for (const candidate of hosts) {
    if (await canConnect(candidate, port, timeoutMs)) return true;
  }
  return false;
}

export async function waitForDevServer({
  baseDir,
  files = [],
  intervalMs = 100,
  timeoutMs = 120_000,
  tcpHost,
  tcpPort,
  probeTimeoutMs = 500,
}) {
  if (!Number.isInteger(tcpPort) || tcpPort <= 0) {
    throw new TypeError("waitForDevServer requires a positive integer tcpPort");
  }
  const startedAt = Date.now();
  for (;;) {
    const missingFiles = files.filter((file) => !existsSync(resolve(baseDir, file)));
    const tcpOk = await portReady(tcpHost, tcpPort, probeTimeoutMs);
    if (missingFiles.length === 0 && tcpOk) return;
    if (Date.now() - startedAt >= timeoutMs) {
      const pending = [];
      if (!tcpOk) pending.push(tcpHost ? `tcp:${tcpHost}:${tcpPort}` : `tcp:${tcpPort}`);
      for (const file of missingFiles) pending.push(`file:${file}`);
      throw new Error(
        `Timed out waiting for desktop dev resources after ${timeoutMs}ms: ${pending.join(", ")}`,
      );
    }
    await sleep(intervalMs);
  }
}
