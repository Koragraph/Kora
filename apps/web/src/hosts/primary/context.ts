import * as Effect from "effect/Effect";
import type { HostDescriptor } from "@kora/contracts";
import { attachHostDescriptor, createKnownHost, type KnownHost } from "@kora/client-runtime/host";

import { readPrimaryHostTarget } from "./target";
import { PrimaryHostHttpClient } from "./httpClient";
import { PrimaryHostRequestError, retryTransientBootstrap } from "./auth";
import { runPrimaryHttp } from "../../util/runtime";

let primaryHostDescriptor: HostDescriptor | null = null;
let primaryHostDescriptorPromise: Promise<HostDescriptor> | null = null;

function createPrimaryKnownHost(args: {
  readonly source: KnownHost["source"];
  readonly target: KnownHost["target"];
}): KnownHost | null {
  const descriptor = readPrimaryHostDescriptor();
  if (!descriptor) {
    return null;
  }

  return attachHostDescriptor(
    createKnownHost({
      id: descriptor.hostId,
      label: descriptor.label,
      source: args.source,
      target: args.target,
    }),
    descriptor,
  );
}

async function fetchPrimaryHostDescriptor(): Promise<HostDescriptor> {
  return retryTransientBootstrap(async () => {
    let descriptor: HostDescriptor;
    try {
      descriptor = await runPrimaryHttp(
        PrimaryHostHttpClient.pipe(Effect.flatMap((client) => client.metadata.descriptor())),
      );
    } catch (err) {
      throw PrimaryHostRequestError.fromCause({
        operation: "fetch-environment-descriptor",
        cause: err,
      });
    }

    writePrimaryHostDescriptor(descriptor);
    return descriptor;
  });
}

function readPrimaryHostDescriptor(): HostDescriptor | null {
  return primaryHostDescriptor;
}

export function writePrimaryHostDescriptor(descriptor: HostDescriptor | null): void {
  primaryHostDescriptor = descriptor;
}

export function getPrimaryKnownHost(): KnownHost | null {
  const primaryTarget = readPrimaryHostTarget();
  if (!primaryTarget) {
    return null;
  }

  return createPrimaryKnownHost({
    source: primaryTarget.source,
    target: primaryTarget.target,
  });
}

export function resolveInitialPrimaryHostDescriptor(): Promise<HostDescriptor> {
  const descriptor = readPrimaryHostDescriptor();
  if (descriptor) {
    return Promise.resolve(descriptor);
  }

  if (primaryHostDescriptorPromise) {
    return primaryHostDescriptorPromise;
  }

  const nextPromise = fetchPrimaryHostDescriptor();
  primaryHostDescriptorPromise = nextPromise;
  return nextPromise.finally(() => {
    if (primaryHostDescriptorPromise === nextPromise) {
      primaryHostDescriptorPromise = null;
    }
  });
}

export function resetPrimaryHostDescriptorForTests(): void {
  primaryHostDescriptorPromise = null;
  primaryHostDescriptor = null;
}
