import { createFileRoute } from "@tanstack/react-router";

import { DiagnosticsPrefsPanel } from "../components/prefs/DiagnosticsPrefs";

export const Route = createFileRoute("/settings/diagnostics")({
  component: DiagnosticsPrefsPanel,
});
