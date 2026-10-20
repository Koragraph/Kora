// Settings > Blobs > Teams: the same Share / Import dialogs the roster footer opens, for people who look in Settings first.
import { useState } from "react";

import { PrefsRow, PrefsSection } from "../../prefs/prefsLayout";
import { Button } from "../../ui/button";
import { useGroupMembers } from "../groups/useGroups";
import { ExportTeamDialog } from "./ExportTeamDialog";
import { ImportTeamDialog } from "./ImportTeamDialog";
import { useTeamExportApi, useTeamImportApi, useTeamOptions } from "./useTeamApis";

export function TeamFilesSection() {
  const [sharing, setSharing] = useState(false);
  const [importing, setImporting] = useState(false);
  const team = useTeamOptions();
  const { byId } = useGroupMembers();
  const exportApi = useTeamExportApi();
  const importApi = useTeamImportApi();
  return (
    <PrefsSection title="Teams" id="blobs-teams" data-team-files>
      <PrefsRow
        title="Share your team"
        description="Save your blobs and groups as one Markdown file to give to someone, or keep as a backup. It never includes your chats, memory, keys, apps or folders; you see exactly what goes in before it is written."
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSharing(true)}
            data-settings-share-team
          >
            Share…
          </Button>
        }
      />
      <PrefsRow
        title="Import a team"
        description="Open a team file or link. You review it first; nothing is created until you press Import, and imported blobs start with no apps, paused routines, skills off and the Ask permission."
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImporting(true)}
            data-settings-import-team
          >
            Import…
          </Button>
        }
      />
      <ExportTeamDialog
        open={sharing}
        onOpenChange={setSharing}
        blobs={team.blobs.map((b) => ({ ...b, outfit: byId.get(b.id)?.outfit ?? {} }))}
        groups={team.groups}
        koraId={team.koraId}
        api={exportApi}
      />
      <ImportTeamDialog open={importing} onOpenChange={setImporting} api={importApi} />
    </PrefsSection>
  );
}
