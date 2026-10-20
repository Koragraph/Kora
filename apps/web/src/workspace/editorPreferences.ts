import { useCallback } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import { EDITORS, type ExternalEditorId, type HostId } from "@kora/contracts";
import { mapAtomActionResult } from "@kora/client-runtime/store/runtime";

import {
  useLocalStorage,
  setLocalStorageItem,
  getLocalStorageItem,
} from "../hooks/useLocalStorage";
import { useAtomAction } from "../atoms/use-atom-command";
import { shellHost } from "../atoms/shell";

const EDITOR_STORAGE_KEY = "kora:editor-last";
const EditorIdSchema = Schema.String as unknown as Schema.Codec<ExternalEditorId, ExternalEditorId>;

export class PreferredEditorHostRequiredError extends Schema.TaggedError<PreferredEditorHostRequiredError>()(
  "PreferredEditorHostRequiredError",
  { targetPath: Schema.String },
) {
  override get message() {
    const detail = `Cannot open ${this.targetPath} because no environment is selected.`;
    return detail;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    hostId: Schema.String as unknown as Schema.Codec<HostId, HostId>,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `No available editor can open ${this.targetPath} in environment ${this.hostId}.`;
  }
}

function resolveEditor(
  persistedVal: ExternalEditorId | null,
  available: ReadonlyArray<ExternalEditorId>,
): ExternalEditorId | null {
  if (persistedVal !== null && available.includes(persistedVal)) return persistedVal;
  return EDITORS.find((ed) => available.includes(ed.id))?.id ?? null;
}

export function useEditorPreference(
  availableEditors: ReadonlyArray<ExternalEditorId>,
): readonly [ExternalEditorId | null, (ed: ExternalEditorId) => void] {
  const [stored, setStored] = useLocalStorage<ExternalEditorId | null, ExternalEditorId | null>(
    EDITOR_STORAGE_KEY,
    null,
    Schema.NullOr(EditorIdSchema) as never,
  );
  return [resolveEditor(stored, availableEditors), setStored as (ed: ExternalEditorId) => void];
}

export function useOpenInEditor(
  hostKey: HostId | null,
  availableEditors: readonly ExternalEditorId[],
) {
  const openInEditor = useAtomAction(shellHost.openInEditor, { reportFailure: false });

  return useCallback(
    async (targetPath: string) => {
      if (hostKey === null) {
        return failure(new PreferredEditorHostRequiredError({ targetPath }));
      }
      const persistedVal = readStoredEditor();
      const ed = resolveEditor(persistedVal, availableEditors);
      if (ed === null) {
        return failure(
          new PreferredEditorUnavailableError({
            hostId: hostKey,
            targetPath,
            availableEditorIds: [...availableEditors],
          }),
        );
      }
      // Remember the fallback so the next launch reuses it.
      if (ed !== persistedVal) setLocalStorageItem(EDITOR_STORAGE_KEY, ed, EditorIdSchema);
      const outcomeVal = await openInEditor({
        hostId: hostKey,
        input: { cwd: targetPath, editor: ed },
      });
      return mapAtomActionResult(outcomeVal, () => ed);
    },
    [availableEditors, hostKey, openInEditor],
  );
}

function readStoredEditor(): ExternalEditorId | null {
  try {
    return getLocalStorageItem(EDITOR_STORAGE_KEY, EditorIdSchema);
  } catch {
    return null;
  }
}

function failure<Err>(err: Err) {
  return AsyncResult.fail(err);
}
