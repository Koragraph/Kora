// Host RPC atoms for the Blobs surface. The roster stream and every write come from the shared store
// (`@kora/client-runtime/store/blobs`, via ~/atoms/blobs); one-shot reads the panels fire imperatively
// (detail, usage, files, about-me, defaults) are plain commands here, so a component can await them.
import { RPC_METHODS } from "@kora/contracts";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";

import { blobsHost as shared } from "~/atoms/blobs";
import { daemonAtomRuntime } from "~/link/runtime";

const read = <T extends Parameters<typeof createHostRpcCommand>[1]["tag"]>(name: string, tag: T) =>
  createHostRpcCommand(daemonAtomRuntime, { label: `blobs:read:${name}`, tag });

export const blobsHost = {
  roster: shared.snapshot,
  create: shared.create,
  update: shared.update,
  setSoul: shared.setSoul,
  archive: shared.archive,
  rehire: shared.rehire,
  remove: shared.delete,
  duplicate: shared.duplicate,
  setAboutMe: shared.setAboutMe,
  setDefaults: shared.setDefaults,
  setFlag: shared.setFlag,
  get: read("get", RPC_METHODS.blobsGet),
  usage: read("usage", RPC_METHODS.blobsUsage),
  files: read("files", RPC_METHODS.blobsFiles),
  getAboutMe: read("get-about-me", RPC_METHODS.blobsGetAboutMe),
  getDefaults: read("get-defaults", RPC_METHODS.blobsGetDefaults),
};
