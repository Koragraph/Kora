import { createFileRoute } from "@tanstack/react-router";

import { PrefsPageContainer } from "../components/prefs/prefsLayout";
import { TokenSavingsPrefs } from "../components/prefs/TokenSavingsPrefs";

/** The switches that keep tokens (and dollars) down. Scoped like Defaults: a project can override each one. */
export const Route = createFileRoute("/settings/token-savings")({
  component: () => (
    <PrefsPageContainer>
      <TokenSavingsPrefs />
    </PrefsPageContainer>
  ),
});
