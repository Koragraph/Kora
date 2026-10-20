// Wires the gallery to the daemon: `blobs.templates.list` for the cards, `blobs.templates.hire` for Hire, and the roster
// snapshot for which templates are already on the team. Components take these as props, so tests and previews don't need it.
import type { BlobProfile, BlobTemplate } from "@kora/contracts";
import { useCallback, useMemo } from "react";

import { blobsHost } from "~/atoms/blobs";
import { usePrimaryHostId } from "~/atoms/hosts";
import { useHostQuery } from "~/atoms/query";
import { useAtomAction } from "~/atoms/use-atom-command";
import { COMMAND_OPTIONS, useBlobRun } from "../cards/blobCommand";
import { useBlobsState } from "../shell/blobsApi";
import type { HireResult, StarterGalleryProps } from "./StarterGallery";

const NONE: ReadonlyArray<BlobTemplate> = [];

/** Starters renamed in 0.1.x: blobs hired under the old ids still count as hired. Mirrors RENAMED_STARTERS in the runtime. */
const RENAMED_STARTERS: Readonly<Record<string, string>> = {
  pintu: "junip",
  gumbo: "wobbo",
  zuzu: "tibbo",
  mochi: "mibble",
  noodle: "zonk",
  bloop: "plonk",
  pip: "fizzle",
};

export function useStarterGallery(): Pick<
  StarterGalleryProps,
  "templates" | "hiredTemplateIds" | "loading" | "onHire"
> {
  const hostId = usePrimaryHostId();
  const query = useHostQuery(hostId === null ? null : blobsHost.templates({ hostId, input: {} }));
  const { snapshot } = useBlobsState();
  const { run } = useBlobRun();
  const hireTemplates = useAtomAction(blobsHost.hireTemplates, COMMAND_OPTIONS);

  const templates = query.data?.templates ?? NONE;
  const hiredTemplateIds = useMemo(
    () =>
      new Set(
        (snapshot?.blobs ?? [])
          .filter((b) => b.archivedAt === null && b.templateId !== null)
          .map((b) => RENAMED_STARTERS[b.templateId as string] ?? (b.templateId as string)),
      ),
    [snapshot],
  );

  const onHire = useCallback(
    async (templateIds: ReadonlyArray<string>): Promise<HireResult> => {
      const result = await run<{ readonly profiles: ReadonlyArray<BlobProfile> }>(
        "Could not hire them. Try again in a moment.",
        (host) => hireTemplates({ hostId: host, input: { templateIds: [...templateIds] } }),
      );
      return result.ok ? { ok: true, profiles: result.value.profiles } : result;
    },
    [run, hireTemplates],
  );

  return { templates, hiredTemplateIds, loading: query.isPending, onHire };
}
