// The RPC-backed team-file APIs the export and import dialogs call (blobs.team.*). The renderer never writes files: export
// asks the daemon for the markdown (scrubbed, with its report) and hands it to the browser's own download / the clipboard;
// import sends text or an https link to the daemon, gets a PLAN back, and later only says which parts to skip.
import { RPC_METHODS } from "@kora/contracts";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";
import { useEffect, useMemo, useState } from "react";

import { useAtomAction } from "~/atoms/use-atom-command";
import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS, useBlobRun } from "../cards/blobCommand";
import type {
  ApiRes,
  ExportBlobOption,
  ExportGroupOption,
  ExportReportWire,
  ExportSelection,
  ImportPlanWire,
  ImportResultWire,
  TeamExportApi,
  TeamImportApi,
} from "./teamfileModel";

const cmd = <T extends Parameters<typeof createHostRpcCommand>[1]["tag"]>(name: string, tag: T) =>
  createHostRpcCommand(daemonAtomRuntime, { label: `blobs:team:${name}`, tag });
const optionsCmd = cmd("options", RPC_METHODS.blobsTeamOptions);
const previewCmd = cmd("preview", RPC_METHODS.blobsTeamPreview);
const exportCmd = cmd("export", RPC_METHODS.blobsTeamExport);
const planCmd = cmd("import-plan", RPC_METHODS.blobsTeamImportPlan);
const applyCmd = cmd("import-apply", RPC_METHODS.blobsTeamImportApply);

export interface TeamOptions {
  readonly koraId: string | null;
  readonly blobs: ReadonlyArray<Omit<ExportBlobOption, "outfit">>;
  readonly groups: ReadonlyArray<ExportGroupOption>;
}

/** What the export dialog lists (loaded once, refreshed whenever the roster or the groups change size). */
export function useTeamOptions(refreshKey: string | number = 0): TeamOptions {
  const { run } = useBlobRun();
  const options = useAtomAction(optionsCmd, COMMAND_OPTIONS);
  const [value, setValue] = useState<TeamOptions>({ koraId: null, blobs: [], groups: [] });
  useEffect(() => {
    let live = true;
    void run("Could not load the team.", (h) => options({ hostId: h, input: {} })).then((r) => {
      if (live && r.ok) setValue(r.value as unknown as TeamOptions);
    });
    return () => {
      live = false;
    };
  }, [run, options, refreshKey]);
  return value;
}

const toRes = <T>(r: { ok: true; value: unknown } | { ok: false; message: string }): ApiRes<T> =>
  r.ok ? { ok: true, value: r.value as T } : { ok: false, message: r.message };

const selectionOf = (s: ExportSelection) => ({
  blobIds: [...s.blobIds],
  groupIds: [...s.groupIds],
  chief: s.chief,
  routines: s.routines,
  skills: s.skills,
  name: s.name,
});

/** Hand the file to the browser's download (Electron shows its save sheet). */
function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function useTeamExportApi(): TeamExportApi {
  const { run } = useBlobRun();
  const preview = useAtomAction(previewCmd, COMMAND_OPTIONS);
  const exp = useAtomAction(exportCmd, COMMAND_OPTIONS);
  return useMemo<TeamExportApi>(
    () => ({
      preview: async (sel) =>
        toRes<ExportReportWire>(
          await run("Could not check the file.", (h) =>
            preview({ hostId: h, input: { selection: selectionOf(sel) } }),
          ),
        ),
      save: async (sel) => {
        const r = await run("Could not build the file.", (h) =>
          exp({ hostId: h, input: { selection: selectionOf(sel) } }),
        );
        if (!r.ok) return { ok: false, message: r.message };
        const v = r.value as unknown as { markdown: string; fileName: string };
        downloadText(v.fileName, v.markdown);
        return { ok: true, value: { path: v.fileName } };
      },
      copy: async (sel) => {
        const r = await run("Could not build the file.", (h) =>
          exp({ hostId: h, input: { selection: selectionOf(sel) } }),
        );
        if (!r.ok) return { ok: false, message: r.message };
        try {
          await navigator.clipboard.writeText(
            (r.value as unknown as { markdown: string }).markdown,
          );
        } catch {
          return { ok: false, message: "Could not copy. Use Save instead." };
        }
        return { ok: true, value: {} };
      },
    }),
    [run, preview, exp],
  );
}

export function useTeamImportApi(): TeamImportApi {
  const { run } = useBlobRun();
  const plan = useAtomAction(planCmd, COMMAND_OPTIONS);
  const apply = useAtomAction(applyCmd, COMMAND_OPTIONS);
  return useMemo<TeamImportApi>(
    () => ({
      fromText: async (text) =>
        toRes<ImportPlanWire>(
          await run("Could not read that file.", (h) => plan({ hostId: h, input: { text } })),
        ),
      fromUrl: async (url) =>
        toRes<ImportPlanWire>(
          await run("Could not fetch that link.", (h) => plan({ hostId: h, input: { url } })),
        ),
      apply: async (planId, skip) =>
        toRes<ImportResultWire>(
          await run("Could not import the team.", (h) =>
            apply({
              hostId: h,
              input: {
                planId,
                skip: {
                  blobs: [...skip.blobs],
                  groups: [...skip.groups],
                  replace: [...(skip.replace ?? [])],
                },
              },
            }),
          ),
        ),
    }),
    [run, plan, apply],
  );
}
