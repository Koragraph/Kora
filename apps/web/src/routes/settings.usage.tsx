import { createFileRoute } from "@tanstack/react-router";

import { UsagePrefsPanel } from "../components/prefs/UsagePrefsPanel";

/** Plan limits (Claude, Codex, Antigravity) and where to find the context meter. Machine state, so no scope
 *  selects. In every edition: seeing your plan usage is free. */
export const Route = createFileRoute("/settings/usage")({
  component: UsagePrefsPanel,
});
