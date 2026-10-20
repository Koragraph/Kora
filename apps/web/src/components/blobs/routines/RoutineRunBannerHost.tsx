// Mounted on a routine's hidden execution thread: finds the run behind it and shows the banner with "Back to results".
// The thread carries `origin.runId`; the run record (from the daemon) carries the title, when it ran and where its report went.
import { RoutineRunBanner } from "./RoutineReportCard";
import { useRoutinesData } from "./RoutinesPanel";
import { useRoutineNav } from "./useRoutineNav";

export function RoutineRunBannerHost(props: {
  readonly blobId: string;
  readonly threadId: string;
  readonly runId: string | null;
}) {
  const nav = useRoutineNav();
  const { snapshot } = useRoutinesData(props.blobId);
  const run =
    snapshot?.runs.find((r) => r.threadId === props.threadId) ??
    (props.runId ? snapshot?.runs.find((r) => r.id === props.runId) : undefined) ??
    null;
  // Until the run record loads, still say where you are (the way back appears with it).
  return (
    <RoutineRunBanner
      title={run?.title ?? "Routine run"}
      ranAt={run?.dueAt ?? Date.now()}
      resultsThreadId={run?.resultsThreadId ?? null}
      onBack={nav.openThread}
    />
  );
}
