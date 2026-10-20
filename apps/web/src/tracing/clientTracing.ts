import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as Otlp from "effect/unstable/observability/OtlpExporter";
import { HttpClient } from "effect/unstable/http";
import type * as Tracer from "effect/Tracer";
import * as Scope from "effect/Scope";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import { errorLogFields } from "@kora/client-runtime/failures";

import { APP_VERSION } from "~/branding";
import { primaryHostHttpLayer } from "../hosts/primary/httpLayer";
import { resolvePrimaryHostHttpUrl } from "../hosts/primary";
import { isNative } from "../env";

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

const DEFAULT_EXPORT_INTERVAL_MS = 1000;
const MIN_EXPORT_INTERVAL_MS = 10;

type ExporterRuntime = ManagedRuntime.ManagedRuntime<
  Otlp.Flusher | OtlpSerialization.OtlpSerialization | HttpClient.HttpClient,
  never
>;

let pendingConfiguration: Promise<void> = Promise.resolve();
let activeKey: string | null = null;
let activeDelegate: Tracer.Tracer | null = null;
let activeRuntime: ExporterRuntime | null = null;
let activeScope: Scope.Closeable | null = null;
let generation = 0;
let lastConfig: ClientTracingConfig | undefined;

async function dispose(runtime: ExporterRuntime | null, scope: Scope.Closeable | null) {
  try {
    if (scope) await runtime?.runPromise(Scope.close(scope, Exit.void));
  } finally {
    await runtime?.dispose();
  }
}

function buildRuntime(): ExporterRuntime {
  // The exporter's own HTTP calls must never be traced, or they would trace themselves.
  const untraced = Layer.succeed(HttpClient.TracerDisabledWhen, () => true);
  const layer = Layer.mergeAll(
    primaryHostHttpLayer,
    OtlpSerialization.layerJson,
    Otlp.layerFlusher,
    untraced,
  );
  return ManagedRuntime.make(layer as never) as ExporterRuntime;
}

async function apply(cfg: ClientTracingConfig | undefined): Promise<void> {
  const exportIntervalMs = Math.max(
    MIN_EXPORT_INTERVAL_MS,
    cfg?.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS,
  );
  const address = resolvePrimaryHostHttpUrl("/api/observability/v1/traces");
  const keyName = `${address}|${exportIntervalMs}`;
  if (keyName === activeKey && activeDelegate) return;

  const mine = ++generation;
  const previousRuntime = activeRuntime;
  const previousScope = activeScope;
  activeKey = null;
  activeDelegate = null;
  activeRuntime = null;
  activeScope = null;
  await dispose(previousRuntime, previousScope);

  const runtime = buildRuntime();
  const scope = Scope.makeUnsafe();
  try {
    const tracer = await runtime.runPromise(
      OtlpTracer.make({
        url: address,
        exportInterval: `${exportIntervalMs} millis`,
        resource: {
          serviceName: "kora-web",
          serviceVersion: APP_VERSION,
          attributes: {
            "service.runtime": "kora-web",
            "service.mode": isNative ? "electron" : "browser",
            "service.version": APP_VERSION,
          },
        },
      }).pipe(Scope.provide(scope) as never) as never,
    );
    if (mine !== generation) {
      await dispose(runtime, scope);
      return;
    }
    activeKey = keyName;
    activeDelegate = tracer as Tracer.Tracer;
    activeRuntime = runtime;
    activeScope = scope;
  } catch (err) {
    await dispose(runtime, scope).catch(() => undefined);
    if (mine !== generation) return;
    const decoded = new URL(address);
    console.warn("Failed to configure client tracing exporter", {
      scheme: decoded.protocol.replace(/:$/, ""),
      host: decoded.hostname,
      port: decoded.port || undefined,
      exportIntervalMs,
      ...errorLogFields(err),
    });
  }
}

/** Reconfigurations run strictly in order; this never throws. */
export function configureClientTracing(cfg?: ClientTracingConfig): Promise<void> {
  if (cfg === undefined && lastConfig !== undefined) return pendingConfiguration;
  lastConfig = cfg ?? lastConfig ?? {};
  pendingConfiguration = pendingConfiguration.finally(() =>
    apply(cfg).catch((err) => {
      console.warn("Failed to configure client tracing exporter", errorLogFields(err));
    }),
  );
  return pendingConfiguration;
}
