// The RPC-backed Extensions API. The page holds the latest list; every change re-reads it, so the daemon's file stays
// the one source of truth.
import {
  RPC_METHODS,
  type ExtensionCatalogAddInput,
  type ExtensionCatalogResult,
  type ExtensionDiscoverResult,
  type ExtensionParseResult,
  type ExtensionProjectResult,
  type ExtensionSaveInput,
  type ExtensionServer,
  type ExtensionSkill,
  type ExtensionSkillAddResult,
  type ExtensionsListResult,
  type ExtensionTestInput,
  type ExtensionTestResult,
} from "@kora/contracts";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryHostId } from "~/atoms/hosts";
import { useAtomAction } from "~/atoms/use-atom-command";
import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS, settleCommand, type ApiResult } from "../../blobs/cards/blobCommand";

const cmd = (tag: string, label: string) =>
  createHostRpcCommand(daemonAtomRuntime, { label: `extensions:${label}`, tag } as never);

const commands = {
  list: cmd(RPC_METHODS.extensionsList, "list"),
  save: cmd(RPC_METHODS.extensionsSave, "save"),
  remove: cmd(RPC_METHODS.extensionsRemove, "remove"),
  setEnabled: cmd(RPC_METHODS.extensionsSetEnabled, "set-enabled"),
  test: cmd(RPC_METHODS.extensionsTest, "test"),
  parse: cmd(RPC_METHODS.extensionsParse, "parse"),
  discover: cmd(RPC_METHODS.extensionsDiscover, "discover"),
  catalog: cmd(RPC_METHODS.extensionsCatalog, "catalog"),
  addFromCatalog: cmd(RPC_METHODS.extensionsAddFromCatalog, "add-from-catalog"),
  project: cmd(RPC_METHODS.extensionsProject, "project"),
  projectApprove: cmd(RPC_METHODS.extensionsProjectApprove, "project-approve"),
  setProjectSecret: cmd(RPC_METHODS.extensionsSetProjectSecret, "set-project-secret"),
  skillAdd: cmd(RPC_METHODS.extensionsSkillAdd, "skill-add"),
  skillRemove: cmd(RPC_METHODS.extensionsSkillRemove, "skill-remove"),
  skillSetEnabled: cmd(RPC_METHODS.extensionsSkillSetEnabled, "skill-set-enabled"),
} as const;

export interface ExtensionsApi {
  readonly view: ExtensionsListResult | null;
  readonly error: string | null;
  reload(): Promise<void>;
  save(input: ExtensionSaveInput): Promise<ApiResult<ExtensionServer>>;
  remove(name: string): Promise<ApiResult<unknown>>;
  setEnabled(name: string, enabled: boolean): Promise<ApiResult<ExtensionServer>>;
  test(input: ExtensionTestInput): Promise<ApiResult<ExtensionTestResult>>;
  parse(text: string, name?: string): Promise<ApiResult<ExtensionParseResult>>;
  discover(): Promise<ApiResult<ExtensionDiscoverResult>>;
  catalog(): Promise<ApiResult<ExtensionCatalogResult>>;
  addFromCatalog(input: ExtensionCatalogAddInput): Promise<ApiResult<ExtensionServer>>;
  project(cwd: string): Promise<ApiResult<ExtensionProjectResult>>;
  projectApprove(cwd: string, name: string, approved: boolean): Promise<ApiResult<unknown>>;
  setProjectSecret(label: string, value: string): Promise<ApiResult<unknown>>;
  skillAdd(
    source: string,
    agents: ExtensionServer["agents"],
  ): Promise<ApiResult<ExtensionSkillAddResult>>;
  skillRemove(name: string): Promise<ApiResult<unknown>>;
  skillSetEnabled(name: string, enabled: boolean): Promise<ApiResult<ExtensionSkill>>;
}

const retryDelay = (failures: number) => Math.min(15_000, 1_500 * 2 ** Math.max(0, failures - 1));

export function useExtensionsApi(): ExtensionsApi {
  const hostId = usePrimaryHostId();
  const run = {
    list: useAtomAction(commands.list, COMMAND_OPTIONS),
    save: useAtomAction(commands.save, COMMAND_OPTIONS),
    remove: useAtomAction(commands.remove, COMMAND_OPTIONS),
    setEnabled: useAtomAction(commands.setEnabled, COMMAND_OPTIONS),
    test: useAtomAction(commands.test, COMMAND_OPTIONS),
    parse: useAtomAction(commands.parse, COMMAND_OPTIONS),
    discover: useAtomAction(commands.discover, COMMAND_OPTIONS),
    catalog: useAtomAction(commands.catalog, COMMAND_OPTIONS),
    addFromCatalog: useAtomAction(commands.addFromCatalog, COMMAND_OPTIONS),
    project: useAtomAction(commands.project, COMMAND_OPTIONS),
    projectApprove: useAtomAction(commands.projectApprove, COMMAND_OPTIONS),
    setProjectSecret: useAtomAction(commands.setProjectSecret, COMMAND_OPTIONS),
    skillAdd: useAtomAction(commands.skillAdd, COMMAND_OPTIONS),
    skillRemove: useAtomAction(commands.skillRemove, COMMAND_OPTIONS),
    skillSetEnabled: useAtomAction(commands.skillSetEnabled, COMMAND_OPTIONS),
  };
  const runRef = useRef(run);
  runRef.current = run;
  const [view, setView] = useState<ExtensionsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const call = useCallback(
    async <T>(
      name: keyof typeof commands,
      input: unknown,
      fallback: string,
    ): Promise<ApiResult<T>> => {
      if (hostId === null) return { ok: false, message: "Kora is not connected." };
      const fn = runRef.current[name] as unknown as (a: {
        hostId: string;
        input: unknown;
      }) => Promise<never>;
      return settleCommand(await fn({ hostId, input }), fallback) as ApiResult<T>;
    },
    [hostId],
  );

  const reload = useCallback(async () => {
    const r = await call<ExtensionsListResult>("list", {}, "Could not read the extensions.");
    if (!alive.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (r.ok) {
      failures.current = 0;
      setView(r.value);
      setError(null);
      return;
    }
    failures.current += 1;
    if (failures.current > 3) setError(r.message);
    timer.current = setTimeout(() => void reload(), retryDelay(failures.current));
  }, [call]);

  useEffect(() => {
    alive.current = true;
    failures.current = 0;
    void reload();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  /** A change, then a fresh list either way (a partial failure may still have changed something). */
  const change = useCallback(
    async <T>(name: keyof typeof commands, input: unknown, fallback: string) => {
      const r = await call<T>(name, input, fallback);
      await reload();
      return r;
    },
    [call, reload],
  );

  return useMemo<ExtensionsApi>(
    () => ({
      view,
      error,
      reload,
      save: (input) => change("save", input, "Could not save the extension."),
      remove: (name) => change("remove", { name }, "Could not remove it."),
      setEnabled: (name, enabled) =>
        change("setEnabled", { name, enabled }, "Could not change it."),
      test: (input) => call("test", input, "The test did not run."),
      parse: (text, name) => call("parse", { text, name: name ?? null }, "Could not read that."),
      discover: () => call("discover", {}, "Could not read your agents' settings."),
      catalog: () => call("catalog", {}, "Could not load the catalog."),
      addFromCatalog: (input) => change("addFromCatalog", input, "Could not add it."),
      project: (cwd) => call("project", { cwd }, "Could not read the project's extensions."),
      projectApprove: (cwd, name, approved) =>
        change("projectApprove", { cwd, name, approved }, "Could not change it."),
      setProjectSecret: (label, value) =>
        call("setProjectSecret", { label, value }, "Could not save that value."),
      skillAdd: (source, agents) =>
        change("skillAdd", { source, agents }, "Could not install that skill."),
      skillRemove: (name) => change("skillRemove", { name }, "Could not remove the skill."),
      skillSetEnabled: (name, enabled) =>
        change("skillSetEnabled", { name, enabled }, "Could not change the skill."),
    }),
    [view, error, reload, call, change],
  );
}
