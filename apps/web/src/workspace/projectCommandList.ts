import { type ProjectAction } from "@kora/contracts";

/** Project script ids stay short so they read well in paths and logs. */
const MAX_SCRIPT_ID_LENGTH = 24;

export interface ProjectCommandInput {
  readonly name: ProjectAction["name"];
  readonly command: ProjectAction["command"];
  readonly icon: ProjectAction["icon"];
  readonly runOnWorktreeCreate: ProjectAction["runOnWorktreeCreate"];
  readonly waitForSetup: boolean;
  readonly previewUrl: Exclude<ProjectAction["previewUrl"], undefined> | null;
  readonly autoOpenPreview: boolean;
}

export function buildProjectCommand(id: string, draft: ProjectCommandInput): ProjectAction {
  return {
    id: id,
    name: draft.name,
    command: draft.command,
    icon: draft.icon,
    runOnWorktreeCreate: draft.runOnWorktreeCreate,
    ...(draft.runOnWorktreeCreate && draft.waitForSetup ? { async: false } : {}),
    ...(draft.previewUrl === null
      ? {}
      : {
          previewUrl: draft.previewUrl,
          autoOpenPreview: draft.autoOpenPreview,
        }),
  };
}

function normalizeScriptId(val: string): string {
  const lowered = val.trim().toLowerCase();
  const slug = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug === "") return "script";
  if (slug.length > MAX_SCRIPT_ID_LENGTH) {
    return slug.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
  }
  return slug;
}

export function nextProjectCommandId(label: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(label);
  if (!taken.has(baseId)) return baseId;

  let ending = 2;
  while (ending < 10_000) {
    const cand = `${baseId}-${ending}`;
    const safeCandidate =
      cand.length <= MAX_SCRIPT_ID_LENGTH
        ? cand
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(ending).length - 1))}-${ending}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    ending += 1;
  }

  // This last-resort fallback only triggers after exhausting thousands of suffixes.
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}
